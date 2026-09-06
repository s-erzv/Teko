// Verifikasi menyeluruh SEMUA skenario service.js langsung terhadap kontrak
// live di BSC Testnet + AWS KMS + Xendit sandbox beneran — TANPA lewat
// Telegram. Store dipaksa in-memory (lihat .env.verify.local) supaya gak
// keblokir tabel Supabase yang belum dibuat; ini cuma menguji jalur
// chain/wallet/xendit, bukan persistensi Supabase (yang sudah dijaga
// terpisah oleh store.js:check()).
//
// Jalankan: pnpm verify (atau: node --env-file=.env.verify.local src/scripts/verify_all.js)
//
// .env.verify.local belum ada? Bikin dari .env.local, kosongin 2 baris Supabase:
//   sed -e 's/^SUPABASE_URL=.*/SUPABASE_URL=/' -e 's/^SUPABASE_SERVICE_KEY=.*/SUPABASE_SERVICE_KEY=/' .env.local > .env.verify.local
//
// Makan waktu beberapa menit (3x nunggu VRF fulfillment beneran + jeda 25
// detik buat tes telat bayar) dan ngirim transaksi on-chain sungguhan
// (butuh tBNB + IDRX di Treasury) — bukan buat dijalanin di CI tiap commit,
// tapi buat verifikasi manual sebelum ngerilis perubahan kontrak/service.js.
import * as svc from "../service.js";
import * as store from "../store.js";
import * as chain from "../chain.js";
import { custodialAddress } from "../wallet.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    failures.push(`${label} ${detail}`);
    console.log(`  ❌ ${label} ${detail}`);
  }
}

function line(s) {
  console.log("\n─── " + s + " " + "─".repeat(Math.max(0, 60 - s.length)));
}

/** Minta undian & tunggu event RoundDrawn utk groupId spesifik (timeout 4 menit). */
function waitForDraw(groupId, timeoutMs = 4 * 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout nunggu VRF fulfillment grup ${groupId}`)), timeoutMs);
    chain.onRoundDrawn((payload) => {
      if (payload.groupId === groupId) {
        clearTimeout(timer);
        resolve(payload);
      }
    });
  });
}

// Simulasikan Telegram user: bikin wallet custodial beneran via KMS (AWS live).
let uidCounter = 90000;
function fakeUser(username) {
  uidCounter += 1;
  return { userId: String(uidCounter), username };
}

async function memberByWallet(groupId, wallet) {
  const members = await store.getMembers(groupId);
  return members.find((m) => m.wallet_address?.toLowerCase() === wallet.toLowerCase()) || null;
}

async function joinDirect(groupId, chatId, user) {
  // Setara joinOrPay() tapi skip Xendit invoice (kita cuma perlu wallet +
  // member row + settle langsung) — Xendit invoice sendiri diuji terpisah
  // di test "Xendit Invoice real".
  const walletAddress = await custodialAddress(user.userId);
  await store.addMember({ groupId, telegramUserId: user.userId, username: user.username, walletAddress });
  return walletAddress;
}

async function settleContribution(groupId, round, user, idx) {
  const orderId = `verify-g${groupId}-r${round}-${user.userId}-${idx}`;
  await store.savePayment({
    order_id: orderId,
    group_id: groupId,
    round,
    telegram_user_id: user.userId,
    amount_idr: 200000,
    fee_idr: 2500,
    status: "pending",
    kind: "contribution",
  });
  await svc.onPaymentSettled(orderId);
}

async function main() {
  // ── 0) Xendit Invoice — beneran hit API sandbox, gak dibayar, cuma
  //      mastiin integrasinya nyambung & gak 401/404. ─────────────────
  line("0) Xendit Invoice API (real sandbox call)");
  try {
    const { createInvoice } = await import("../xendit.js");
    const inv = await createInvoice({
      externalId: `verify-xendit-${Date.now()}`,
      grossIdr: 202500,
      description: "Verifikasi integrasi Xendit",
    });
    ok("createInvoice() balik invoice_url", Boolean(inv.paymentUrl), JSON.stringify(inv));
  } catch (e) {
    ok("createInvoice() gagal", false, e.message);
  }

  // ── A) Grup happy-path (size 2) + exit-after-payout + pay-debt ──────
  line("A) Happy path 2 orang, 2 ronde + exit-after-payout + pay-debt");
  const chatA = "verify-A-" + Date.now();
  const a1 = fakeUser("alice");
  const a2 = fakeUser("budi");
  const createdA = await svc.createArisan({ chatId: chatA, size: 2, contributionIdr: 200000 });
  ok("createArisan A sukses", createdA.ok, createdA.message);
  const groupA = await store.getGroupByChat(chatA);
  const gidA = groupA.group_id;

  await joinDirect(gidA, chatA, a1);
  await joinDirect(gidA, chatA, a2);

  for (let round = 1; round <= 2; round++) {
    await settleContribution(gidA, round, a1, round);
    await settleContribution(gidA, round, a2, round);
    const g = await chain.getGroup(gidA);
    ok(`Ronde ${round} A: paidThisRound == activeCount`, g.paidThisRound === g.activeCount, JSON.stringify(g));

    const waiting = waitForDraw(gidA);
    const reqd = await svc.requestDraw({ chatId: chatA });
    ok(`Ronde ${round} A: requestDraw ok`, reqd.ok, reqd.message);
    const drawn = await waiting;
    ok(`Ronde ${round} A: ada pemenang`, Boolean(drawn.winner));
    console.log(`     pemenang ronde ${round}: ${drawn.winner} (Rp${drawn.prizeIdr.toLocaleString("id-ID")})`);
  }

  const finalA = await chain.getGroup(gidA);
  ok("Grup A selesai (finished)", finalA.finished, JSON.stringify(finalA));

  // exit-after-payout: salah satu member (yg udah menang) keluar -> kena debt
  const memberA1 = await store.getMember(gidA, a1.userId);
  const hasWonA1 = await chain.hasWon(gidA, memberA1.wallet_address);
  const exitTarget = hasWonA1 ? a1 : a2;
  const exitResult = await svc.exitArisan({ chatId: chatA, userId: exitTarget.userId });
  ok("exitArisan setelah grup selesai (post-payout) -> pesan kena tanggungan", exitResult.ok && /tanggungan/.test(exitResult.message), exitResult.message);

  const memberDebt = await chain.getMember(gidA, (await store.getMember(gidA, exitTarget.userId)).wallet_address);
  ok("balanceOwed > 0 setelah exit post-payout", memberDebt.balanceOwedIdr > 0, JSON.stringify(memberDebt));

  const payDebtReq = await svc.requestPayDebt({ chatId: chatA, userId: exitTarget.userId });
  ok("requestPayDebt bikin invoice Xendit", payDebtReq.ok && Boolean(payDebtReq.paymentUrl), payDebtReq.message);
  // Settle debt-nya lewat onPaymentSettled langsung (skenario G di bawah
  // sudah nutup jalur payDebt on-chain secara terpisah & lebih terkontrol).

  // ── B) Grup governance (size 3): kick sebelum ronde 1 ───────────────
  line("B) Governance kick sebelum ronde 1 (3 -> 2 orang)");
  const chatB = "verify-B-" + Date.now();
  const b1 = fakeUser("citra");
  const b2 = fakeUser("dedi");
  const b3 = fakeUser("eka");
  const createdB = await svc.createArisan({ chatId: chatB, size: 3, contributionIdr: 200000 });
  ok("createArisan B sukses", createdB.ok);
  const groupB = await store.getGroupByChat(chatB);
  const gidB = groupB.group_id;
  await joinDirect(gidB, chatB, b1);
  await joinDirect(gidB, chatB, b2);
  await joinDirect(gidB, chatB, b3);

  await settleContribution(gidB, 1, b1, 1);
  await settleContribution(gidB, 1, b2, 1);
  await settleContribution(gidB, 1, b3, 1);

  const proposeRes = await svc.proposeGovernance({ chatId: chatB, kind: "kick", targetUserId: b3.userId });
  ok("proposeGovernance kick b3", proposeRes.ok, proposeRes.message);
  const pidMatch = proposeRes.message.match(/#(\d+)/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  ok("proposalId terparse dari pesan", pid !== null, proposeRes.message);

  const vote1 = await svc.castVote({ chatId: chatB, userId: b1.userId, proposalId: pid, approve: true });
  ok("vote b1 setuju", vote1.ok, vote1.message);
  const vote2 = await svc.castVote({ chatId: chatB, userId: b2.userId, proposalId: pid, approve: true });
  ok("vote b2 setuju (kuorum 2/2 eligible)", vote2.ok, vote2.message);

  const gAfterKick = await chain.getGroup(gidB);
  ok("Setelah kick: activeCount == 2", gAfterKick.activeCount === 2, JSON.stringify(gAfterKick));
  ok("Setelah kick: paidThisRound == 2 (setoran b3 dikembalikan & dilepas)", gAfterKick.paidThisRound === 2, JSON.stringify(gAfterKick));

  const waitingB = waitForDraw(gidB);
  const reqB = await svc.requestDraw({ chatId: chatB });
  ok("requestDraw B (2 sisa) ok", reqB.ok, reqB.message);
  const drawnB = await waitingB;
  ok("Grup B ronde 1: pemenang bukan b3 (udah dikick)", drawnB.winner !== (await store.getMember(gidB, b3.userId))?.wallet_address);

  // ── C) Priority-swap (berbayar, gate posisi) + swap gratis ──────────
  line("C) Priority-swap & swap gratis (mode PerCycle, antrian aktif)");
  const chatC = "verify-C-" + Date.now();
  const c1 = fakeUser("fajar");
  const c2 = fakeUser("gita");
  const c3 = fakeUser("hana");
  const createdC = await svc.createArisan({ chatId: chatC, size: 3, contributionIdr: 200000 });
  const groupC = await store.getGroupByChat(chatC);
  const gidC = groupC.group_id;
  await joinDirect(gidC, chatC, c1);
  await joinDirect(gidC, chatC, c2);
  await joinDirect(gidC, chatC, c3);
  await settleContribution(gidC, 1, c1, 1);
  await settleContribution(gidC, 1, c2, 1);
  await settleContribution(gidC, 1, c3, 1);

  const waitingC = waitForDraw(gidC);
  await svc.requestDraw({ chatId: chatC });
  await waitingC; // grup activated, 2 sisa di antrian

  const q = await chain.getQueue(gidC);
  ok("Antrian aktif berisi 2 sisa anggota", q.length === 2, JSON.stringify(q));
  const frontMember = await memberByWallet(gidC, q[0]);
  const backMember = await memberByWallet(gidC, q[1]);

  const prioReq = await svc.requestPriority({
    chatId: chatC,
    userId: backMember.telegram_user_id,
    targetUsername: frontMember.username,
    feeIdr: 50000,
  });
  ok("requestPriority (posisi valid, target di depan) bikin invoice", prioReq.ok && Boolean(prioReq.paymentUrl), prioReq.message);

  // Settle manual (simulasi webhook) lalu terima tawarannya.
  const prioOrderId = `verify-priosettle-${Date.now()}`;
  await store.savePayment({
    order_id: prioOrderId, group_id: gidC, round: 0, telegram_user_id: backMember.telegram_user_id,
    amount_idr: 50000, fee_idr: 0, status: "pending", kind: "priority",
    member_wallet: backMember.wallet_address, target_wallet: frontMember.wallet_address,
  });
  await svc.onPaymentSettled(prioOrderId);

  const respondRes = await svc.respondPrioritySwap({ chatId: chatC, userId: frontMember.telegram_user_id, accept: true });
  ok("respondPrioritySwap (terima) sukses", respondRes.ok, respondRes.message);
  const qAfterPriority = await chain.getQueue(gidC);
  ok("Posisi ketuker setelah priority-swap diterima", qAfterPriority[0] === backMember.wallet_address, JSON.stringify(qAfterPriority));

  // Swap gratis: tuker balik.
  const freeSwapReq = await svc.requestFreeSwap({
    chatId: chatC,
    userId: qAfterPriority[1] === frontMember.wallet_address ? frontMember.telegram_user_id : backMember.telegram_user_id,
    targetUsername: qAfterPriority[0] === backMember.wallet_address ? backMember.username : frontMember.username,
  });
  ok("requestFreeSwap sukses", freeSwapReq.ok, freeSwapReq.message);
  const accepterUserId = qAfterPriority[0] === backMember.wallet_address ? backMember.telegram_user_id : frontMember.telegram_user_id;
  const freeSwapAccept = await svc.acceptFreeSwap({ chatId: chatC, userId: accepterUserId });
  ok("acceptFreeSwap sukses", freeSwapAccept.ok, freeSwapAccept.message);
  const qAfterFreeSwap = await chain.getQueue(gidC);
  ok("Posisi ketuker balik setelah swap gratis", qAfterFreeSwap[0] === frontMember.wallet_address, JSON.stringify(qAfterFreeSwap));

  // ── D) Exit SEBELUM menang (refund - exitPenalty) ───────────────────
  line("D) Exit sebelum menang (refund dikurangi exitPenalty)");
  const chatD = "verify-D-" + Date.now();
  const d1 = fakeUser("hadi");
  const createdD = await svc.createArisan({ chatId: chatD, size: 2, contributionIdr: 200000 });
  const groupD = await store.getGroupByChat(chatD);
  const gidD = groupD.group_id;
  await joinDirect(gidD, chatD, d1);
  await settleContribution(gidD, 1, d1, 1);

  const exitD = await svc.exitArisan({ chatId: chatD, userId: d1.userId });
  ok("exitArisan sebelum menang -> ada refund, TANPA 'tanggungan'", exitD.ok && !/tanggungan/.test(exitD.message), exitD.message);

  // ── E) Self-custody: daftar wallet eksternal ────────────────────────
  line("E) Self-custody wallet eksternal");
  const e1 = fakeUser("ika");
  await custodialAddress(e1.userId); // pastikan wallet custodial ada dulu
  const setW = await svc.setExternalWallet({ userId: e1.userId, address: "0xE1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1" });
  ok("setExternalWallet sukses", setW.ok, setW.message);
  const badW = await svc.setExternalWallet({ userId: e1.userId, address: "bukan-address" });
  ok("setExternalWallet tolak format invalid", !badW.ok, badW.message);

  // ── F) Replace member (deep-link flow) ──────────────────────────────
  line("F) Replace member");
  const chatF = "verify-F-" + Date.now();
  const f1 = fakeUser("joko");
  const f2 = fakeUser("kiki"); // pengganti
  const createdF = await svc.createArisan({ chatId: chatF, size: 2, contributionIdr: 200000 });
  const groupF = await store.getGroupByChat(chatF);
  const gidF = groupF.group_id;
  await joinDirect(gidF, chatF, f1);
  await settleContribution(gidF, 1, f1, 1);

  const reqReplace = await svc.requestReplace({ chatId: chatF, oldUserId: f1.userId });
  ok("requestReplace ok", reqReplace.ok, JSON.stringify(reqReplace));
  const doneReplace = await svc.completeReplace({
    groupId: gidF,
    oldUserId: f1.userId,
    newUserId: f2.userId,
    newUsername: f2.username,
  });
  ok("completeReplace ok", doneReplace.ok, doneReplace.message);
  const oldMemberF = await store.getMember(gidF, f1.userId);
  const oldStateF = await chain.getMember(gidF, oldMemberF.wallet_address);
  ok("Member lama (f1) exited=true setelah replace", oldStateF.exited);

  // ── G) Penalize / telat bayar — cycle pendek biar gak nunggu lama ───
  // Catatan: registrasi & setoran pertama menyatu di ronde 1 (deposit() yang
  // bikin member "registered"), jadi member yg BELUM PERNAH setor sama sekali
  // bukan "telat" dari sudut pandang kontrak, dia belum sah anggota (NotMember).
  // Makanya di sini ronde 1 diselesaikan dulu (keduanya setor + diundi),
  // BARU ronde 2 disimulasikan salah satu telat — pola yang sama persis
  // dipakai di test/TekoArisan.t.sol (test_PenalizeThenPayDebt).
  line("G) Telat bayar di ronde 2 -> penalize (cycle 20 detik)");
  const g1 = fakeUser("lala");
  const g2 = fakeUser("momo");
  const wG1 = await custodialAddress(g1.userId);
  const wG2 = await custodialAddress(g2.userId);
  const { groupId: gidG } = await chain.createGroup({
    size: 2,
    contributionIdr: 200000,
    cycleLengthSecs: 20,
    penaltyPerDayIdr: 5000,
  });
  await store.saveGroup({ groupId: gidG, chatId: "verify-G-" + Date.now(), size: 2, contributionIdr: 200000 });
  await store.addMember({ groupId: gidG, telegramUserId: g1.userId, username: g1.username, walletAddress: wG1 });
  await store.addMember({ groupId: gidG, telegramUserId: g2.userId, username: g2.username, walletAddress: wG2 });

  await chain.deposit(gidG, wG1);
  await chain.deposit(gidG, wG2); // ronde 1 lunas dua-duanya -> registered

  const waitingG = waitForDraw(gidG);
  await chain.requestDraw(gidG);
  await waitingG; // ronde 1 selesai, masuk ronde 2

  await chain.deposit(gidG, wG1); // cuma g1 yg setor ronde 2 -> buka deadline 20 detik, g2 telat

  console.log("     nunggu 25 detik biar deadline kelewat...");
  await new Promise((r) => setTimeout(r, 25_000));

  const penResult = await chain.penalize(gidG, wG2);
  ok("penalize g2 (telat) charge > 0", penResult.chargeIdr > 0, JSON.stringify(penResult));
  const memG2 = await chain.getMember(gidG, wG2);
  ok("g2 delinquent=true & balanceOwed > 0", memG2.delinquent && memG2.balanceOwedIdr > 0, JSON.stringify(memG2));

  const penAgain = await chain.penalize(gidG, wG2).catch((e) => ({ error: chain.describeError(e) }));
  ok("penalize 2x hari sama -> NothingToCharge (gak dobel tagih)", Boolean(penAgain.error) && /NothingToCharge/.test(penAgain.error), JSON.stringify(penAgain));

  const payoffTx = await chain.payDebt(gidG, wG2, memG2.balanceOwedIdr);
  ok("payDebt lunasin utang g2", Boolean(payoffTx.txHash));
  const memG2After = await chain.getMember(gidG, wG2);
  ok("g2 balanceOwed == 0 setelah dilunasi", memG2After.balanceOwedIdr === 0, JSON.stringify(memG2After));

  // ── H) Parameter invalid ditolak dengan sopan (bukan crash) ─────────
  line("H) Validasi parameter invalid");
  const badSize = await svc.createArisan({ chatId: "verify-H1-" + Date.now(), size: 1, contributionIdr: 200000 });
  ok("createArisan size<2 ditolak", !badSize.ok, badSize.message);
  const badContrib = await svc.createArisan({ chatId: "verify-H2-" + Date.now(), size: 3, contributionIdr: 500 });
  ok("createArisan contribution<1000 ditolak", !badContrib.ok, badContrib.message);

  // ── I) Idempotency: settle payment yang sama 2x gak boleh dobel-deposit ─
  line("I) Idempotency onPaymentSettled (webhook retry)");
  const chatI = "verify-I-" + Date.now();
  const i1 = fakeUser("intan");
  const i2 = fakeUser("joni");
  const i3 = fakeUser("kirana"); // size 3, bukan 2 — governance (skenario J) butuh min. 2 pemilih DI LUAR subjek (ElectorateTooSmall kalau cuma 2 orang total)
  await svc.createArisan({ chatId: chatI, size: 3, contributionIdr: 200000 });
  const groupI = await store.getGroupByChat(chatI);
  const gidI = groupI.group_id;
  await joinDirect(gidI, chatI, i1);
  await joinDirect(gidI, chatI, i2);
  await joinDirect(gidI, chatI, i3);
  const orderIdI = `verify-idempotent-${Date.now()}`;
  await store.savePayment({
    order_id: orderIdI, group_id: gidI, round: 1, telegram_user_id: i1.userId,
    amount_idr: 200000, fee_idr: 2500, status: "pending", kind: "contribution",
  });
  await svc.onPaymentSettled(orderIdI);
  await svc.onPaymentSettled(orderIdI); // simulasi webhook Xendit retry
  const gAfterIdempotent = await chain.getGroup(gidI);
  ok("Retry webhook TIDAK dobel-deposit (paidThisRound tetap 1)", gAfterIdempotent.paidThisRound === 1, JSON.stringify(gAfterIdempotent));

  // ── J) Vote oleh non-member ditolak ──────────────────────────────────
  line("J) Vote oleh non-member ditolak");
  await settleContribution(gidI, 1, i2, 1);
  await settleContribution(gidI, 1, i3, 1); // lunasin semua (roster lock)
  const proposeJ = await svc.proposeGovernance({ chatId: chatI, kind: "skip", targetUserId: i1.userId });
  ok("proposeGovernance J ok", proposeJ.ok, proposeJ.message);
  const pidJ = Number(proposeJ.message.match(/#(\d+)/)?.[1]);
  const outsider = fakeUser("orangluar");
  const voteOutsider = await svc.castVote({ chatId: chatI, userId: outsider.userId, proposalId: pidJ, approve: true });
  ok("Vote dari non-member ditolak", !voteOutsider.ok, voteOutsider.message);

  // ── K) Xendit Payout — beneran hit API sandbox (cairin hadiah) ──────
  line("K) Xendit Payout API (real sandbox call)");
  try {
    const { createPayout } = await import("../xendit.js");
    const payout = await createPayout({
      referenceId: `verify-payout-${Date.now()}`,
      amountIdr: 50000,
      channelCode: "ID_DANA",
      accountNumber: "081234567890",
      accountHolderName: "Verifikasi Teko",
    });
    ok("createPayout() balik payoutId + status", Boolean(payout.payoutId), JSON.stringify(payout));
  } catch (e) {
    // Sandbox bisa nolak nomor tes yang gak valid — dicatat sbg info,
    // bukan otomatis fail, karena tujuan di sini cuma mastiin API call-nya
    // nyambung (bukan 401/404/schema error), bukan mastiin dana beneran cair.
    console.log(`  ℹ️  createPayout() ditolak sandbox: ${e.message}`);
    ok("createPayout() API nyambung (dapet respons dari Xendit, bukan network/schema error)", /Xendit payout \d/.test(e.message), e.message);
  }

  // ── Ringkasan ────────────────────────────────────────────────────
  line("RINGKASAN");
  console.log(`✅ ${pass} lolos, ❌ ${fail} gagal dari ${pass + fail} pengecekan.`);
  if (failures.length) {
    console.log("\nYang gagal:");
    failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("❌ Script verifikasi crash:", e);
  process.exit(1);
});
