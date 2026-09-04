// Dogfood full-flow di level service, lawan BSC Testnet beneran.
// Melewati UI Telegram & Xendit — langsung uji: createArisan → settle → draw
// untuk 1 siklus arisan penuh (2 orang, 2 ronde).
//
// CATATAN: anggota di sini didaftarkan dengan wallet address hardcode (bukan
// lewat custodialAddress()/KMS), jadi auto-sweep hadiah di drawWinner() akan
// gagal-dengan-aman (dicatat sbg error, notifyUser no-op karena setNotifier
// belum dipanggil) — script tetap lanjut, cuma bagian sweep-nya tidak
// benar-benar teruji di sini. Untuk uji sweep+Xendit end-to-end, pakai bot
// beneran (src/index.js) dengan kredensial sandbox.
import * as svc from "../service.js";
import * as store from "../store.js";
import * as chain from "../chain.js";

const chatId = "dogfood-" + Date.now();
const A = { userId: "u1", username: "budi", wallet: "0x1111111111111111111111111111111111111111" };
const B = { userId: "u2", username: "siti", wallet: "0x2222222222222222222222222222222222222222" };

const line = (s) => console.log("\n─── " + s + " ".padEnd(50, "─"));

async function settle(groupId, round, m, idx) {
  const orderId = `dogfood-g${groupId}-r${round}-${m.userId}-${idx}`;
  await store.savePayment({
    order_id: orderId,
    group_id: groupId,
    round,
    telegram_user_id: m.userId,
    amount_idr: 200000,
    fee_idr: 2500,
    status: "pending",
  });
  await svc.onPaymentSettled(orderId); // → Treasury deposit() on-chain
}

async function main() {
  line("1) Buat arisan (2 orang, 200rb) — createGroup on-chain");
  const created = await svc.createArisan({ chatId, size: 2, contributionIdr: 200000 });
  console.log(created.message.split("\n")[0], created.ok ? "✅" : "❌");

  const group = await store.getGroupByChat(chatId);
  const groupId = group.group_id;
  console.log("groupId:", groupId);

  line("2) Daftar 2 anggota + wallet");
  await store.addMember({ groupId, telegramUserId: A.userId, username: A.username, walletAddress: A.wallet });
  await store.addMember({ groupId, telegramUserId: B.userId, username: B.username, walletAddress: B.wallet });
  console.log("Anggota:", (await store.getMembers(groupId)).map((m) => m.username).join(", "));

  // Jalankan 2 ronde penuh
  for (let round = 1; round <= 2; round++) {
    line(`3.${round}) Ronde ${round}: kedua anggota bayar → deposit on-chain`);
    await settle(groupId, round, A, round);
    await settle(groupId, round, B, round);
    const g = await chain.getGroup(groupId);
    console.log(`paidThisRound: ${g.paidThisRound}/${g.size} | pot on-chain: Rp${(g.contributionIdr * g.size).toLocaleString("id-ID")}`);

    line(`4.${round}) Undi pemenang ronde ${round} → drawRound on-chain`);
    const drawn = await svc.drawWinner({ chatId });
    console.log(drawn.message.replace(/\[tx.*?\)/g, "").trim());
  }

  line("5) Status akhir");
  const g = await chain.getGroup(groupId);
  console.log(`finished: ${g.finished} | winnersCount: ${g.winnersCount}/${g.size}`);
  console.log("\n✅ Dogfood selesai — full flow jalan on-chain.");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Dogfood gagal:", e);
  process.exit(1);
});
