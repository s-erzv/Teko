import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/store.js";

// SUPABASE_* kosong di .env.test -> semua di bawah ini menguji jalur in-memory,
// yang bentuk & kontraknya sengaja dibikin identik dengan jalur Supabase.

test("mode store jatuh ke in-memory tanpa kredensial Supabase", () => {
  assert.equal(store.storeMode, "in-memory");
});

test("anggota yang keluar hilang dari roster tapi masih bisa dilacak", async () => {
  const gid = 101;
  await store.saveGroup({ groupId: gid, chatId: "-1", size: 2, contributionIdr: 1000 });
  await store.addMember({ groupId: gid, telegramUserId: 1, username: "andi", walletAddress: "0xAAA" });
  await store.addMember({ groupId: gid, telegramUserId: 2, username: "budi", walletAddress: "0xBBB" });

  assert.equal((await store.getMembers(gid)).length, 2);

  await store.markMemberExited(gid, 1);

  const aktif = await store.getMembers(gid);
  assert.deepEqual(aktif.map((m) => m.username), ["budi"]);

  // Riwayatnya tetap ada — dipakai buat mencocokkan address pemenang di
  // event lama ke identitas Telegram.
  const semua = await store.getMembers(gid, { includeExited: true });
  assert.equal(semua.length, 2);

  // Tidak boleh ketemu lagi lewat @username (mis. buat proposal governance).
  assert.equal(await store.getMemberByUsername(gid, "andi"), null);
  assert.ok(await store.getMemberByUsername(gid, "budi"));

  // Tapi lookup langsung tetap jalan: dia mungkin masih punya utang.
  assert.ok(await store.getMember(gid, 1));
});

test("addMember menghidupkan kembali slot yang pernah ditandai keluar", async () => {
  const gid = 102;
  await store.saveGroup({ groupId: gid, chatId: "-2", size: 2, contributionIdr: 1000 });
  await store.addMember({ groupId: gid, telegramUserId: 9, username: "citra", walletAddress: "0xCCC" });
  await store.markMemberExited(gid, 9);
  await store.addMember({ groupId: gid, telegramUserId: 9, username: "citra", walletAddress: "0xCCC" });
  assert.equal((await store.getMembers(gid)).length, 1);
});

test("claimEvent cuma boleh sukses sekali per event", async () => {
  assert.equal(await store.claimEvent("0xdead:0", "RoundDrawn"), true);
  assert.equal(await store.claimEvent("0xdead:0", "RoundDrawn"), false);
  assert.equal(await store.claimEvent("0xdead:1", "RoundDrawn"), true);
});

test("kursor blok tidak pernah mundur", async () => {
  assert.equal(await store.getCursor("RoundDrawn"), null);
  await store.setCursor("RoundDrawn", 500);
  assert.equal(await store.getCursor("RoundDrawn"), 500);
  await store.setCursor("RoundDrawn", 400); // event lama datang telat
  assert.equal(await store.getCursor("RoundDrawn"), 500);
  await store.setCursor("RoundDrawn", 900);
  assert.equal(await store.getCursor("RoundDrawn"), 900);
});

test("pending payout bertahan sampai dibersihkan eksplisit", async () => {
  const gid = 103;
  await store.saveGroup({ groupId: gid, chatId: "-3", size: 2, contributionIdr: 1000 });
  assert.equal(await store.getPendingPayout(7), null);

  await store.setPendingPayout(7, { groupId: gid, round: 2, prizeIdr: 190_000 });
  assert.deepEqual(await store.getPendingPayout(7), { groupId: gid, round: 2, prizeIdr: 190_000 });

  await store.clearPendingPayout(7);
  assert.equal(await store.getPendingPayout(7), null);
});

test("antrean DM keluar urut lama->baru lalu kosong", async () => {
  await store.addPendingDM(42, "pesan satu");
  await store.addPendingDM(42, "pesan dua");
  await store.addPendingDM(43, "punya orang lain");

  assert.deepEqual(await store.takePendingDMs(42), ["pesan satu", "pesan dua"]);
  assert.deepEqual(await store.takePendingDMs(42), []);
  assert.deepEqual(await store.takePendingDMs(43), ["punya orang lain"]);
});

test("claimPaymentPending idempotent: webhook retry tidak bisa lolos dua kali", async () => {
  const gid = 104;
  await store.saveGroup({ groupId: gid, chatId: "-4", size: 2, contributionIdr: 1000 });
  await store.savePayment({
    order_id: "ord-1",
    group_id: gid,
    round: 1,
    telegram_user_id: "5",
    amount_idr: 1000,
    fee_idr: 2500,
    status: "pending",
    kind: "contribution",
  });

  assert.ok(await store.claimPaymentPending("ord-1"));
  assert.equal(await store.claimPaymentPending("ord-1"), null);
});

test("pembayaran gagal bisa diantre ulang, dan cuma sekali", async () => {
  const gid = 105;
  await store.saveGroup({ groupId: gid, chatId: "-5", size: 2, contributionIdr: 1000 });
  await store.savePayment({
    order_id: "ord-2",
    group_id: gid,
    round: 1,
    telegram_user_id: "6",
    amount_idr: 1000,
    fee_idr: 0,
    status: "pending",
    kind: "contribution",
  });

  await store.claimPaymentPending("ord-2");
  await store.updatePayment("ord-2", { status: "deposit_failed" });

  const gagal = await store.getRetryablePayments();
  assert.deepEqual(gagal.map((p) => p.order_id), ["ord-2"]);

  assert.ok(await store.requeuePayment("ord-2"));
  assert.equal((await store.getPayment("ord-2")).status, "pending");
  // Sudah 'pending', bukan 'deposit_failed' lagi -> requeue kedua harus nolak.
  assert.equal(await store.requeuePayment("ord-2"), null);
});

test("buku besar payout mencatat status dan menyaring yang belum tuntas", async () => {
  const gid = 106;
  await store.saveGroup({ groupId: gid, chatId: "-6", size: 2, contributionIdr: 1000 });
  const base = {
    telegram_user_id: "8",
    group_id: gid,
    round: 1,
    amount_idr: 190_000,
    channel_code: "ID_BCA",
    account_number: "1234567890",
  };
  await store.savePayout({ ...base, reference_id: "ref-ok" });
  await store.savePayout({ ...base, reference_id: "ref-gagal" });

  await store.updatePayout("ref-ok", { status: "succeeded" });
  await store.updatePayout("ref-gagal", { status: "failed", failure_reason: "INVALID_ACCOUNT" });

  const belum = await store.getUnsettledPayouts();
  assert.deepEqual(belum.map((p) => p.reference_id), ["ref-gagal"]);
  assert.equal((await store.getPayout("ref-gagal")).failure_reason, "INVALID_ACCOUNT");
});

test("klaim event bisa dilepas supaya event yang gagal dicoba lagi", async () => {
  assert.equal(await store.claimEvent("0xbeef:0", "RoundDrawn"), true);
  assert.equal(await store.claimEvent("0xbeef:0", "RoundDrawn"), false);

  await store.releaseEvent("0xbeef:0");
  assert.equal(await store.claimEvent("0xbeef:0", "RoundDrawn"), true);
});
