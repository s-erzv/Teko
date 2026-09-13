import { ethers } from "ethers";
import { config, rupiah, esc, idrToUnits } from "./config.js";
import * as chain from "./chain.js";
import * as store from "./store.js";
import { createInvoice, createPayout, resolveChannelCode } from "./xendit.js";
import { custodialAddress, sweepToTreasury, sweepToExternal } from "./wallet.js";
import { notify, notifyUser, notifyAdmins } from "./notifier.js";

/**
 * Cari grup arisan yang relevan buat `userId` — coba dari `chatId` dulu
 * (kerja normal kalau dipanggil dari chat GRUP), fallback ke grup aktif
 * terbaru tempat `userId` jadi anggota (kerja kalau dipanggil dari DM, di
 * mana `chatId` adalah chat DM itu sendiri, bukan chat grup arisannya).
 */
async function resolveGroupForUser(chatId, userId) {
  const byChat = await store.getGroupByChat(chatId);
  if (byChat) return byChat;
  return store.getActiveGroupForMember(userId);
}

/**
 * Buat arisan baru on-chain + simpan metadata.
 * @param {object} p
 * @param {number} [p.cycleDays] siklus (hari per ronde) — kalau gak disebutkan,
 *        dipakai default dari config DAN disebutkan eksplisit di pesan balasan
 *        (bukan diam-diam kaya versi sebelumnya).
 * @param {"percycle"|"upfront"} [p.drawMode] "percycle" (antrian diacak ulang
 *        tiap ronde, default) atau "upfront" (urutan tetap ditentukan sekali
 *        di awal — ronde ke-2 dst cair instan tanpa nunggu VRF lagi).
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function createArisan({ chatId, size, contributionIdr, cycleDays, drawMode }) {
  if (!size || size < 2 || size > 50)
    return { ok: false, message: "Jumlah anggota harus 2–50 ya. Contoh: <i>arisan 5 orang 200rb</i>." };
  if (!contributionIdr || contributionIdr < 1000)
    return { ok: false, message: "Setoran minimal Rp1.000. Contoh: <i>arisan 5 orang 200rb</i>." };

  const usedDefaultCycle = !cycleDays;
  const cycleLengthSecs = cycleDays
    ? BigInt(Math.round(cycleDays * 86400))
    : config.chain.defaultCycleLengthSecs;
  const drawModeNum = drawMode === "upfront" ? chain.DRAW_MODE_UPFRONT : chain.DRAW_MODE_PER_CYCLE;

  const { groupId, txHash } = await chain.createGroup({
    size,
    contributionIdr,
    cycleLengthSecs,
    drawMode: drawModeNum,
  });
  if (!groupId) return { ok: false, message: "Gagal baca groupId dari transaksi. Coba lagi." };

  await store.saveGroup({ groupId, chatId, size, contributionIdr });

  const cycleDaysUsed = Number(cycleLengthSecs) / 86400;
  const drawModeLabel =
    drawModeNum === chain.DRAW_MODE_UPFRONT
      ? "diundi SEKALI di awal (urutan tetap dari ronde 1 sampai selesai)"
      : "diundi ULANG tiap ronde (antrian diacak lagi tiap abis 1 orang menang)";

  return {
    ok: true,
    groupId,
    message:
      `<b>Arisan #${groupId} dibuat.</b>\n` +
      `• Anggota: ${size} orang\n` +
      `• Setoran: ${rupiah(contributionIdr)}/orang/ronde\n` +
      `• Siklus: tiap ${cycleDaysUsed} hari${usedDefaultCycle ? " (default, sebut sendiri kalau mau beda — contoh: <i>arisan 5 orang 200rb tiap minggu</i>)" : ""}\n` +
      `• Cara undi: ${drawModeLabel}\n\n` +
      `Anggota tekan tombol <b>Ikut Arisan Ini</b> di bawah untuk setor — nggak perlu wallet.\n\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Lihat transaksi</a>`,
  };
}

/**
 * Member gabung / bayar ronde berjalan. Tidak perlu wallet — bot bikinkan
 * wallet custodial (key random per user, terenkripsi KMS) otomatis. Setoran
 * lewat Invoice Xendit.
 */
export async function joinOrPay({ chatId, groupId: gid, userId, username, firstName, lastName }) {
  const group = gid ? await store.getGroupById(gid) : await store.getGroupByChat(chatId);
  if (!group)
    return { ok: false, message: "Belum ada arisan aktif. Buat dulu di grup: <i>arisan 5 orang 200rb</i>." };
  if (group.status !== "collecting")
    return { ok: false, message: "Arisan ini sudah selesai." };

  const groupId = group.group_id;
  let member = await store.getMember(groupId, userId);

  if (!member) {
    const walletAddress = await custodialAddress(userId);
    member = await store.addMember({ groupId, telegramUserId: userId, username, walletAddress });
  }

  const g = await chain.getGroup(groupId);
  if (g.finished) return { ok: false, message: `Arisan #${groupId} sudah selesai. 🎉` };

  const round = g.round === 0 ? 1 : g.round;
  const grossIdr = group.contribution_idr + config.fee.convenienceIdr;
  const externalId = `teko-g${groupId}-r${round}-u${userId}-${Date.now().toString(36)}`;

  const { paymentUrl } = await createInvoice({
    externalId,
    grossIdr,
    description: `Setoran Arisan #${groupId} Ronde ${round}`,
    customer: {},
  });

  await store.savePayment({
    order_id: externalId,
    group_id: groupId,
    round,
    telegram_user_id: String(userId),
    amount_idr: group.contribution_idr,
    fee_idr: config.fee.convenienceIdr,
    payment_url: paymentUrl,
    status: "pending",
    kind: "contribution",
  });

  const who = username ? `@${esc(username)}` : esc(firstName || "kamu");
  return {
    ok: true,
    message:
      `<b>Setoran Arisan #${groupId} — Ronde ${round}</b>\n` +
      `Untuk: <b>${who}</b>\n` +
      `• Setoran: ${rupiah(group.contribution_idr)}\n` +
      `• Biaya admin: ${rupiah(config.fee.convenienceIdr)}\n` +
      `• <b>Total: ${rupiah(grossIdr)}</b>\n\n` +
      `Link ini khusus buat ${who} — klik tombol di bawah buat bayar.\n` +
      `<i>Tip: buka japri bot ini lalu tekan Start biar dapet resi dan bisa klaim hadiah.</i>`,
    paymentUrl,
  };
}

/**
 * Dipanggil webhook Xendit saat invoice lunas. Cabang berdasarkan `kind`
 * pembayaran: setoran ronde, bayar utang, atau beli tiket prioritas.
 *
 * Urutan klaim-dulu-baru-cek-nominal ini sengaja disamain persis sama
 * webhook Xendit-nya Circa: klaim baris pending->settled dilakukan atomik
 * (`claimPaymentPending`) DULUAN supaya webhook yang di-retry Xendit gak
 * bisa lolos dua kali dari race apa pun, baru SETELAH itu nominal yang
 * beneran dibayar (`paidAmountIdr`, dari `paid_amount` Xendit) diverifikasi
 * cocok sama yang ditagih sebelum kredit apa pun jalan on-chain.
 */
export async function onPaymentSettled(orderId, paidAmountIdr) {
  let pay = await store.getPayment(orderId);
  if (!pay) {
    const base = orderId.replace(/-\d+$/, "");
    if (base !== orderId) pay = await store.getPayment(base);
  }
  if (!pay) {
    console.warn("[settle] payment tidak ditemukan:", orderId);
    return;
  }
  const oid = pay.order_id;

  const claimed = await store.claimPaymentPending(oid);
  if (!claimed) return; // sudah diklaim request lain, atau bukan 'pending' -> idempotent no-op

  const expected = pay.kind === "contribution" || !pay.kind
    ? (pay.amount_idr || 0) + (pay.fee_idr || 0)
    : pay.amount_idr || 0;
  if (paidAmountIdr != null && Math.round(paidAmountIdr) !== Math.round(expected)) {
    console.error(`[settle] nominal tidak cocok untuk ${oid}: diharapkan ${expected}, diterima ${paidAmountIdr}`);
    await store.updatePayment(oid, { status: "amount_mismatch" });
    await notifyUser(
      pay.telegram_user_id,
      `Pembayaranmu buat Arisan #${pay.group_id} nominalnya nggak cocok ` +
        `(ditagih ${rupiah(expected)}, terbaca ${rupiah(paidAmountIdr)}), jadi belum aku kreditkan. ` +
        `Admin lagi ngecek — uangmu nggak hilang.`
    );
    await notifyAdmins(
      `Nominal pembayaran tidak cocok.\n` +
        `• Order: <code>${esc(oid)}</code>\n` +
        `• Ditagih ${rupiah(expected)}, dibayar ${rupiah(paidAmountIdr)}\n` +
        `• Arisan #${pay.group_id}, user ${pay.telegram_user_id}`
    );
    return;
  }

  const kind = pay.kind || "contribution";
  if (kind === "debt") return _settleDebt(pay, oid);
  if (kind === "priority") return _settlePriority(pay, oid);
  return _settleContribution(pay, oid);
}

async function _settleContribution(pay, oid) {
  const member = await store.getMember(pay.group_id, pay.telegram_user_id);
  if (!member?.wallet_address) {
    console.error("[settle] member/wallet tidak ada untuk", oid);
    return;
  }

  let depositTx;
  try {
    const r = await chain.deposit(pay.group_id, member.wallet_address);
    depositTx = r.txHash;
    await store.updatePayment(oid, { tx_hash: depositTx });
  } catch (e) {
    // `AlreadyPaid` bukan kegagalan: kontrak bilang setoran ronde ini SUDAH
    // tercatat. Paling sering muncul kalau user bikin invoice dua kali dan
    // yang kedua sukses duluan, atau kalau proses bot mati setelah tx masuk
    // tapi sebelum statusnya sempat ditulis ke DB. Tanpa cabang ini barisnya
    // nyangkut `deposit_failed` selamanya: tiap putaran cron pemulihan
    // meretry, ditolak lagi, dan membangunkan admin — padahal tidak ada yang
    // perlu dikerjakan.
    //
    // Tetap dikonfirmasi ke on-chain dulu, dan khusus untuk `pay.round`, BUKAN
    // ronde yang lagi berjalan: deposit() selalu memakai ronde kontrak saat
    // ini, jadi setoran buat ronde 2 yang nyasar ke ronde 1 yang sudah lunas
    // juga bakal bilang AlreadyPaid. Menandainya settled tanpa cek itu berarti
    // menutup baris yang kewajibannya belum benar-benar terpenuhi.
    if (chain.isAlreadyPaidError(e)) {
      const credited = await chain
        .hasPaidInRound(pay.group_id, pay.round, member.wallet_address)
        .catch(() => false);
      if (credited) {
        console.log(`[settle] ${oid}: AlreadyPaid, terkonfirmasi on-chain -> ditutup sbg settled.`);
        await store.updatePayment(oid, { status: "settled" });
        return;
      }
    }
    await _handleSettleFailure({
      oid,
      pay,
      error: e,
      what: `setoran Ronde ${pay.round}`,
      userNote:
        `Pembayaranmu <b>${rupiah((pay.amount_idr || 0) + (pay.fee_idr || 0))}</b> sudah diterima, ` +
        `tapi pencatatannya on-chain belum berhasil. Uangmu aman dan bakal dicoba ulang otomatis.`,
    });
    return;
  }

  const g = await chain.getGroup(pay.group_id);
  const group = await store.getGroupById(pay.group_id);
  const chatId = group?.chat_id || null;

  // `activeCount` di kontrak cuma naik pas ada anggota BARU yang pertama
  // kali setor -- di ronde 1, sebelum semua target anggota pernah gabung,
  // activeCount < size, jadi kalau dipakai sbg penyebut malah salah nunjukin
  // "1/1" padahal grupnya buat 2 orang. Sebelum roster kekunci (`rosterLocked`,
  // yaitu udah ada `size` orang yang PERNAH setor), tampilkan target = size;
  // sesudahnya (ronde 2+, activeCount = size - yang exit) baru aman pakai activeCount.
  const target = g.rosterLocked ? g.activeCount : g.size;
  const isFull = g.rosterLocked && g.paidThisRound === g.activeCount;

  const collected = g.paidThisRound * g.contributionIdr;
  const targetIdr = target * g.contributionIdr;

  let msg =
    `Setoran baru masuk ke <b>pool arisan</b> on-chain.\n` +
    `Terkumpul: <b>${rupiah(collected)}</b> / ${rupiah(targetIdr)}  (${g.paidThisRound}/${target} orang)\n` +
    `<a href="https://testnet.bscscan.com/tx/${depositTx}">Bukti on-chain</a>`;
  if (isFull) {
    msg += `\n\nPool penuh! Lagi ngundi otomatis pemenang ronde ${g.round}...`;
  }
  if (chatId) await notify(chatId, msg);

  const total = (pay.amount_idr || 0) + (pay.fee_idr || 0);
  await notifyUser(
    pay.telegram_user_id,
    `Pembayaran kamu <b>${rupiah(total)}</b> diterima.\n` +
      `Kamu sudah setor Arisan #${pay.group_id} Ronde ${g.round}. Terima kasih.`
  );

  if (isFull) await _autoDraw({ groupId: pay.group_id, round: g.round, chatId });
}

/**
 * Dipicu otomatis begitu setoran ronde penuh (lihat `isFull` di atas) --
 * gak perlu admin ketik "undi" lagi. `hasPendingDraw` tetap dicek biar aman
 * kalau (secara teori) dua settle jalan hampir bersamaan dan sama-sama
 * ngelihat kondisi "baru penuh".
 */
async function _autoDraw({ groupId, round, chatId }) {
  try {
    if (await chain.hasPendingDraw(groupId)) return;
    const { txHash } = await chain.requestDraw(groupId);
    if (chatId) {
      await notify(
        chatId,
        `Undian Ronde ${round} Arisan #${groupId} otomatis diminta ke Chainlink VRF — biasanya cair dalam 1-3 menit begitu oracle merespons.\n` +
          `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti permintaan on-chain</a>`
      );
    }
  } catch (e) {
    console.error("[settle] auto-undi gagal:", chain.describeError ? chain.describeError(e) : e.message);
    if (chatId) {
      await notify(chatId, `Pool penuh tapi undian otomatis gagal diminta — admin bisa ketik <b>undi</b> manual.`);
    }
  }
}

async function _settleDebt(pay, oid) {
  try {
    const r = await chain.payDebt(pay.group_id, pay.member_wallet, pay.amount_idr);
    await store.updatePayment(oid, { tx_hash: r.txHash });
    await notifyUser(
      pay.telegram_user_id,
      `Utang kamu di Arisan #${pay.group_id} sebesar <b>${rupiah(pay.amount_idr)}</b> sudah lunas. Terima kasih.`
    );
  } catch (e) {
    await _handleSettleFailure({
      oid,
      pay,
      error: e,
      what: "pelunasan utang",
      userNote:
        `Pembayaran utangmu <b>${rupiah(pay.amount_idr)}</b> sudah diterima, tapi pencatatannya ` +
        `on-chain belum berhasil. Uangmu aman dan bakal dicoba ulang otomatis.`,
    });
  }
}

async function _settlePriority(pay, oid) {
  try {
    const r = await chain.requestPrioritySwap(pay.group_id, pay.member_wallet, pay.target_wallet, pay.amount_idr);
    await store.updatePayment(oid, { tx_hash: r.txHash });
    const target = await memberByWallet(pay.group_id, pay.target_wallet);
    const targetLabel = target?.username ? `@${esc(target.username)}` : "orangnya";
    await notifyUser(
      pay.telegram_user_id,
      `Tawaran <b>${rupiah(pay.amount_idr)}</b> buat gantiin posisi ${targetLabel} di Arisan #${pay.group_id} udah diajukan. Nunggu ${targetLabel} terima/tolak.`
    );
    if (target) {
      await notifyUser(
        target.telegram_user_id,
        `Ada yang nawar <b>${rupiah(pay.amount_idr)}</b> buat gantiin posisi kamu di Arisan #${pay.group_id}.\n` +
          `Ketik <i>terima tawaran</i> atau <i>tolak tawaran</i> di grup arisan itu.`
      );
    }
  } catch (e) {
    await _handleSettleFailure({
      oid,
      pay,
      error: e,
      what: "tawaran prioritas",
      userNote:
        `Pembayaran tawaran prioritasmu <b>${rupiah(pay.amount_idr)}</b> sudah diterima, tapi ` +
        `pengajuannya on-chain belum berhasil. Uangmu aman dan bakal dicoba ulang otomatis.`,
    });
  }
}

/**
 * Jalur kegagalan bersama buat ketiga jenis settle. Dulu kegagalan di sini
 * cuma menulis `deposit_failed` ke DB lalu diam: user sudah membayar uang
 * sungguhan, tapi tidak ada yang memberitahunya, tidak ada admin yang tahu,
 * dan tidak ada yang mencoba lagi. Sekarang ketiganya dikerjakan.
 */
async function _handleSettleFailure({ oid, pay, error, what, userNote }) {
  const reason = chain.describeError(error);
  console.error(`[settle] ${what} gagal untuk ${oid}:`, reason);
  await store.updatePayment(oid, { status: "deposit_failed" });
  await notifyUser(pay.telegram_user_id, userNote);
  await notifyAdmins(
    `Kredit on-chain GAGAL (${esc(what)}).\n` +
      `• Order: <code>${esc(oid)}</code>\n` +
      `• Arisan #${pay.group_id}, user ${pay.telegram_user_id}\n` +
      `• Nominal: ${rupiah(pay.amount_idr)}\n` +
      `• Alasan: ${esc(reason)}\n\n` +
      `Bakal di-retry otomatis. Kalau alasannya soal saldo, isi ulang IDRX/BNB Treasury dulu.`
  );
}

/** ID arisan aktif di sebuah grup (untuk bikin deep-link). null bila tak ada. */
export async function activeGroupId(chatId) {
  const group = await store.getGroupByChat(chatId);
  return group?.group_id || null;
}

/**
 * ID arisan aktif yang relevan buat `userId`, termasuk kalau dipanggil dari
 * japri (di mana `chatId` adalah chat DM, bukan chat grup arisannya). Dipakai
 * supaya anggota bisa ketik "bayar" langsung di japri buat ronde berikutnya —
 * persis seperti yang disuruh pesan pengumuman pemenang.
 */
export async function activeGroupIdForUser(chatId, userId) {
  const group = await resolveGroupForUser(chatId, userId);
  return group?.group_id || null;
}

/**
 * MINTA undian ronde berjalan (hanya admin) — Chainlink VRF, dua tahap.
 * Fungsi ini cuma mengirim request; siapa yang menang BELUM diketahui saat
 * fungsi ini selesai. Pemenang, pengumuman ke grup, dan sweep hadiah semua
 * terjadi belakangan lewat `handleRoundDrawn()`, dipicu event `RoundDrawn`
 * begitu VRFCoordinator memanggil balik kontrak (lihat index.js: `main()`
 * mendaftarkan `chain.onRoundDrawn(...)` sekali saat boot).
 */
export async function requestDraw({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };

  const g = await chain.getGroup(group.group_id);
  if (g.finished) return { ok: false, message: `Arisan #${group.group_id} sudah selesai. 🎉` };
  if (await chain.hasPendingDraw(group.group_id))
    return { ok: false, message: "Undian ronde ini sudah diminta, masih nunggu konfirmasi VRF. Tunggu sebentar." };
  const target = g.rosterLocked ? g.activeCount : g.size;
  if (!g.rosterLocked || g.paidThisRound !== g.activeCount)
    return {
      ok: false,
      message: `Belum semua setor (${g.paidThisRound}/${target}). Tunggu semua bayar dulu.`,
    };

  const { txHash } = await chain.requestDraw(group.group_id);
  return {
    ok: true,
    message:
      `Undian Ronde ${g.round} Arisan #${group.group_id} diminta ke Chainlink VRF — biasanya cair dalam ` +
      `1-3 menit begitu oracle merespons.\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti permintaan on-chain</a>`,
  };
}

/**
 * Dipanggil dari event listener `RoundDrawn` (index.js), begitu VRF fulfill
 * on-chain — bukan dari command handler manapun. Mengumumkan pemenang ke
 * grup Telegram yang benar (dicari dari `groupId`) dan memicu sweep hadiah.
 */
export async function handleRoundDrawn({
  groupId,
  round,
  winner,
  prizeIdr,
  feeIdr,
  txHash,
  blockNumber,
  eventKey,
}) {
  // Backfill saat boot dan listener live pasti tumpang tindih di sebagian
  // event. Klaim atomik ini yang bikin pemenang tidak pernah diproses dua
  // kali (dua sweep, dua pengumuman, dua pencairan).
  if (eventKey && !(await store.claimEvent(eventKey, "RoundDrawn"))) return;

  // Sweep hadiah adalah satu-satunya efek yang tidak bisa ditarik balik. Sebelum
  // itu terjadi, kegagalan apa pun berarti klaimnya DILEPAS supaya pemindaian
  // berikutnya mencoba lagi -- kalau tidak, satu error DB/RPC sesaat bikin
  // pemenangnya hilang permanen. Sesudahnya klaim ditahan (mengulang sweep cuma
  // bakal gagal di wallet yang sudah kosong) dan admin yang dikabari.
  let sweepDone = false;
  try {
    const group = await store.getGroupById(groupId);
    const chatId = group?.chat_id || null;

    const member = await memberByWallet(groupId, winner);
    const who = member?.username ? `@${esc(member.username)}` : `pemenang`;

    const after = await chain.getGroup(groupId);

    if (member) {
      await _handlePrizeSweep({ member, groupId, round, prizeIdr });
      sweepDone = true;
    }

    if (after.finished && group) await store.setGroupStatus(groupId, "finished");

    // Ronde berikutnya (kalau masih ada) udah langsung dibuka di kontrak begitu
    // `_finishRound` selesai -- gak ada "tombol mulai ronde baru" yang kepencet
    // siapa pun. Jadi nudge ini SATU-SATUNYA sinyal yang bilang ke anggota
    // "boleh setor lagi sekarang", makanya digabung ke pesan pemenang.
    const nextRoundNudge = after.finished
      ? `\n\nArisan selesai — semua sudah kebagian.`
      : `\n\nRonde ${round + 1} resmi dibuka — yang belum setor, ketik <b>bayar</b> atau tekan tombol Ikut & Setor lagi ya.`;

    const msg =
      `<b>Pemenang Ronde ${round} Arisan #${groupId}:</b> ${who}\n` +
      `• Hadiah: <b>${rupiah(prizeIdr)}</b>\n` +
      `• Platform fee: ${rupiah(feeIdr)} (1%)\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>\n\n` +
      (member ? `${who}, cek <b>japri</b> dari bot buat status pencairan (privat).` : "") +
      nextRoundNudge;

    if (chatId) await notify(chatId, msg);

    // Kursor baru dimajukan SETELAH event ini benar-benar tuntas diproses, jadi
    // crash di tengah jalan berarti pemindaian berikutnya mengulang dari sini
    // (aman -- `claimEvent` yang menyaring duplikatnya).
    if (blockNumber != null) await store.setCursor(ROUND_DRAWN_CURSOR, blockNumber);
  } catch (e) {
    if (eventKey && !sweepDone) {
      await store.releaseEvent(eventKey);
    } else if (eventKey) {
      await notifyAdmins(
        `Hadiah Arisan #${groupId} Ronde ${round} SUDAH disapu, tapi langkah sesudahnya gagal.\n` +
          `Alasan: ${esc(e.message)}\n\n` +
          `Event-nya tidak bakal diulang otomatis (biar sweep-nya tidak dobel). ` +
          `Cek pengumuman grup dan status pencairan pemenang secara manual.`
      );
    }
    throw e;
  }
}

/** Nama kursor blok buat event RoundDrawn (lihat store.getCursor/setCursor). */
export const ROUND_DRAWN_CURSOR = "RoundDrawn";

/**
 * Susulkan semua event `RoundDrawn` yang terjadi selagi bot mati. Dipanggil
 * sekali saat boot, SEBELUM listener live dipasang.
 *
 * Tanpa ini, VRF yang fulfill pas bot restart bikin pemenangnya hilang
 * permanen: tidak ada pengumuman, hadiah tidak pernah disapu dari wallet
 * custodial, pencairan tidak pernah jalan.
 *
 * @param {number} lookbackBlocks berapa blok ke belakang dipindai kalau belum
 *        ada kursor sama sekali (deploy baru / DB kosong).
 */
export async function backfillRoundDrawn(lookbackBlocks = 50_000) {
  // Kursor bisa keburu melewati sebuah event yang gagal: kalau event blok 105
  // sukses lebih dulu dari event blok 103 (urutan listener tidak dijamin) lalu
  // yang 103 gagal dan klaimnya dilepas, memindai dari 106 bakal melewatkannya.
  // Makanya selalu mundur sedikit — memindai ulang itu gratis, `claimEvent`
  // yang menyaring duplikatnya.
  const SAFETY_BLOCKS = 500;
  const latest = await chain.currentBlock();
  const saved = await store.getCursor(ROUND_DRAWN_CURSOR);
  const from =
    saved != null ? Math.max(0, saved - SAFETY_BLOCKS) : Math.max(0, latest - lookbackBlocks);
  if (from > latest) return 0;

  const events = await chain.scanRoundDrawn(from, latest);
  let handled = 0;
  for (const ev of events) {
    try {
      await handleRoundDrawn(ev);
      handled += 1;
    } catch (e) {
      // Jangan lanjut melewati event yang gagal — kursornya belum maju, jadi
      // pemindaian berikutnya mencobanya lagi. Berhenti di sini biar urutan
      // ronde tidak kebalik.
      console.error(`[backfill] RoundDrawn ${ev.eventKey} gagal:`, e.message);
      await notifyAdmins(
        `Backfill undian berhenti di Arisan #${ev.groupId} Ronde ${ev.round}.\n` +
          `Alasan: ${esc(e.message)}\nSisa event bakal dicoba lagi saat restart berikutnya.`
      );
      return handled;
    }
  }
  await store.setCursor(ROUND_DRAWN_CURSOR, latest);
  return handled;
}

async function _handlePrizeSweep({ member, groupId, round, prizeIdr }) {
  const userId = member.telegram_user_id;
  try {
    const wallet = await store.getWallet(userId);
    if (wallet?.external_address) {
      const r = await sweepToExternal(
        userId,
        wallet.external_address,
        idrToUnits(prizeIdr),
        chain.provider,
        chain.treasurySigner
      );
      await notifyUser(
        userId,
        `Selamat! Kamu menang Arisan #${groupId} Ronde ${round} — hadiah <b>${rupiah(prizeIdr)}</b> (IDRX) sudah dikirim ke wallet kamu sendiri.\n` +
          `<a href="https://testnet.bscscan.com/tx/${r.txHash}">Bukti on-chain</a>`
      );
      return;
    }

    const r = await sweepToTreasury(userId, idrToUnits(prizeIdr), chain.provider, chain.treasurySigner);
    console.log(`[sweep] hadiah menang ${userId} disapu ke Treasury: ${r.txHash}`);

    const dest = await store.getPayoutDestination(userId);
    if (dest) {
      await _payout({ telegramUserId: userId, groupId, round, prizeIdr, dest });
    } else {
      // Hadiahnya SUDAH pindah ke Treasury di baris atas, jadi catatan "siapa
      // yang masih harus dibayar berapa" ini ditulis ke DB, bukan ke memori:
      // restart di antara sini dan balasan pemenang tidak boleh bikin
      // tagihannya lenyap.
      await store.setPendingPayout(userId, { groupId, round, prizeIdr });
      await notifyUser(
        userId,
        `Selamat! Kamu menang Arisan #${groupId} Ronde ${round} — hadiah <b>${rupiah(prizeIdr)}</b>.\n` +
          `Balas pesan ini dengan rekening/e-wallet buat pencairan.\n` +
          `Contoh: <code>GoPay 081234567890</code> atau <code>BCA 1234567890</code>\n\n` +
          `<i>Punya wallet BNB Chain sendiri? Ketik "pakai wallet sendiri 0x..." biar hadiah berikutnya langsung ke situ.</i>`
      );
    }
  } catch (e) {
    console.error("[sweep] gagal:", e.message);
    await notifyUser(
      userId,
      `Selamat menang Arisan #${groupId} Ronde ${round}! Ada kendala teknis saat memproses pencairan otomatis — admin akan bantu manual.`
    );
    await notifyAdmins(
      `Sweep hadiah GAGAL.\n` +
        `• Arisan #${groupId} Ronde ${round}\n` +
        `• Pemenang: ${member.username ? "@" + esc(member.username) : userId} (<code>${esc(member.wallet_address)}</code>)\n` +
        `• Hadiah: ${rupiah(prizeIdr)}\n` +
        `• Alasan: ${esc(e.message)}\n\n` +
        `Dana kemungkinan masih di wallet custodial pemenang. Cek saldo BNB Treasury buat gas top-up.`
    );
  }
}

/**
 * Kirim perintah pencairan ke Xendit DAN catat barisnya di buku besar
 * `payouts`. Barisnya ditulis DULUAN, sebelum request dikirim: kalau proses
 * mati tepat setelah Xendit menerima perintahnya, jejaknya tetap ada dan
 * callback-nya masih punya baris buat dicocokkan.
 */
async function _payout({ telegramUserId, groupId, round, prizeIdr, dest }) {
  const referenceId = `teko-payout-g${groupId}-r${round}-u${telegramUserId}-${Date.now().toString(36)}`;
  await store.savePayout({
    reference_id: referenceId,
    telegram_user_id: String(telegramUserId),
    group_id: groupId,
    round,
    amount_idr: prizeIdr,
    channel_code: dest.channel_code,
    account_number: dest.account_number,
    status: "requested",
  });

  try {
    const r = await createPayout({
      referenceId,
      amountIdr: prizeIdr,
      channelCode: dest.channel_code,
      accountNumber: dest.account_number,
      accountHolderName: dest.account_holder_name,
    });
    await store.updatePayout(referenceId, { status: "accepted", xendit_id: r.payoutId || null });
    await notifyUser(
      telegramUserId,
      `Pencairan <b>${rupiah(prizeIdr)}</b> ke <b>${esc(dest.channel_code)} ${esc(dest.account_number)}</b> sedang diproses (status: ${esc(r.status)}).\n` +
        `Aku kabarin lagi begitu dananya masuk.`
    );
  } catch (e) {
    console.error("[payout] gagal:", e.message);
    await store.updatePayout(referenceId, { status: "error", failure_reason: e.message });
    // Hadiah tetap terutang: kembalikan ke antrean supaya pemenang bisa
    // mengirim ulang rekening (mis. nomornya salah) tanpa campur tangan admin.
    await store.setPendingPayout(telegramUserId, { groupId, round, prizeIdr });
    await notifyUser(
      telegramUserId,
      `Pencairan <b>${rupiah(prizeIdr)}</b> gagal diproses otomatis.\n` +
        `Coba balas lagi dengan rekening/e-wallet kamu (pastikan nomornya benar), atau tunggu admin bantu manual.`
    );
    await notifyAdmins(
      `Payout Xendit DITOLAK.\n` +
        `• Ref: <code>${esc(referenceId)}</code>\n` +
        `• Arisan #${groupId} Ronde ${round}, ${rupiah(prizeIdr)}\n` +
        `• Tujuan: ${esc(dest.channel_code)} ${esc(dest.account_number)}\n` +
        `• Alasan: ${esc(e.message)}`
    );
  }
}

/**
 * Dipanggil webhook callback payout Xendit — status akhir sebuah pencairan.
 * Tanpa ini, sebuah payout yang gagal di sisi Xendit tidak pernah kelihatan:
 * user terus melihat "sedang diproses" padahal dananya tidak pernah sampai.
 */
export async function onPayoutCallback({ referenceId, status, failureCode, xenditId }) {
  const row = await store.getPayout(referenceId);
  if (!row) {
    console.warn("[payout] callback buat referensi tak dikenal:", referenceId);
    return;
  }
  if (row.status === "succeeded" || row.status === "failed") return; // sudah final

  if (status === "succeeded") {
    await store.updatePayout(referenceId, { status: "succeeded", xendit_id: xenditId || row.xendit_id });
    await notifyUser(
      row.telegram_user_id,
      `Pencairan <b>${rupiah(row.amount_idr)}</b> ke <b>${esc(row.channel_code)} ${esc(row.account_number)}</b> BERHASIL. ` +
        `Cek saldomu ya. Terima kasih sudah arisan bareng Teko.`
    );
    return;
  }

  await store.updatePayout(referenceId, {
    status: "failed",
    failure_reason: failureCode || "unknown",
    xendit_id: xenditId || row.xendit_id,
  });
  // Hadiahnya belum sampai ke pemenang, jadi hutangnya dihidupkan lagi dan
  // tujuan lama dihapus supaya dia tidak mengulang ke rekening yang ditolak.
  await store.setPendingPayout(row.telegram_user_id, {
    groupId: Number(row.group_id),
    round: Number(row.round),
    prizeIdr: Number(row.amount_idr),
  });
  await notifyUser(
    row.telegram_user_id,
    `Pencairan <b>${rupiah(row.amount_idr)}</b> ke <b>${esc(row.channel_code)} ${esc(row.account_number)}</b> DITOLAK ` +
      `(${esc(failureCode || "alasan tidak disebutkan")}).\n` +
      `Hadiahmu masih utuh. Balas pesan ini dengan rekening/e-wallet yang lain buat dicoba lagi.`
  );
  await notifyAdmins(
    `Payout GAGAL di Xendit.\n` +
      `• Ref: <code>${esc(referenceId)}</code>\n` +
      `• Arisan #${row.group_id} Ronde ${row.round}, ${rupiah(row.amount_idr)}\n` +
      `• Tujuan: ${esc(row.channel_code)} ${esc(row.account_number)}\n` +
      `• Kode: ${esc(failureCode || "-")}`
  );
}

/** Daftar pencairan yang belum tuntas — buat command rekonsiliasi admin. */
export async function unsettledPayouts() {
  const rows = await store.getUnsettledPayouts();
  if (!rows.length) return { ok: true, message: "Semua pencairan sudah tuntas. 👍" };
  const lines = rows.map(
    (r) =>
      `· <code>${esc(r.reference_id)}</code>\n  Arisan #${r.group_id} R${r.round} · ${rupiah(r.amount_idr)} · ` +
      `${esc(r.channel_code)} ${esc(r.account_number)} · <b>${esc(r.status)}</b>` +
      (r.failure_reason ? `\n  Alasan: ${esc(r.failure_reason)}` : "")
  );
  return { ok: true, message: `<b>Pencairan belum tuntas (${rows.length})</b>\n\n${lines.join("\n")}` };
}

/**
 * Status arisan di grup ini. Daftar nama siapa sudah/belum bayar hanya untuk admin
 * (privasi); anggota biasa cuma melihat progress angka.
 */
export async function statusArisan({ chatId, isAdmin = false }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const g = await chain.getGroup(group.group_id);
  const round = g.round === 0 ? 1 : g.round;

  let detail = "";
  if (isAdmin) {
    const members = await store.getMembers(group.group_id);
    const paid = await store.getPaidUserIds(group.group_id, round);
    const roster = members.length
      ? members
          .map((m) => {
            const name = m.username ? `@${esc(m.username)}` : "anggota";
            return paid.has(String(m.telegram_user_id))
              ? `✓ ${name} — sudah bayar`
              : `· ${name} — belum bayar`;
          })
          .join("\n")
      : "<i>belum ada anggota</i>";
    detail = `\n\n<b>Anggota (khusus admin):</b>\n${roster}`;
  }

  const target = g.rosterLocked ? g.activeCount : g.size;

  return {
    ok: true,
    message:
      `<b>Arisan #${group.group_id}</b> — Ronde ${round}\n` +
      `Setoran ${rupiah(g.contributionIdr)}/orang · Pot ${rupiah(g.contributionIdr * target)}\n` +
      `Sudah bayar: <b>${g.paidThisRound}/${target}</b> · Sudah menang: ${g.winnersCount}` +
      detail +
      `\n\n` +
      (g.finished ? `Status: <b>SELESAI</b>` : `Status: berjalan`),
  };
}

/** Proses pencairan fiat setelah pemenang mengirim nomor rekening/e-wallet. */
export async function processPayout(userId, destination) {
  const pending = await store.getPendingPayout(userId);
  if (!pending) return null;

  const parts = destination.trim().split(/\s+/);
  const channelCode = resolveChannelCode(parts[0]);
  const accountNumber = (parts[1] || "").replace(/\D/g, "");

  if (!channelCode || accountNumber.length < 6) {
    return {
      ok: false,
      message:
        "Format belum kebaca. Contoh: <code>GoPay 081234567890</code> atau <code>BCA 1234567890</code>.\n" +
        "Yang didukung: GoPay, OVO, DANA, ShopeePay, LinkAja, BCA, BRI, BNI, Mandiri, Permata, CIMB.",
    };
  }

  const member = await store.getMember(pending.groupId, userId);
  const accountHolderName = member?.username || "Pemenang Arisan";
  const dest = { channel_code: channelCode, account_number: accountNumber, account_holder_name: accountHolderName };

  await store.setPayoutDestination(userId, dest);
  await store.clearPendingPayout(userId);

  await _payout({ telegramUserId: userId, groupId: pending.groupId, round: pending.round, prizeIdr: pending.prizeIdr, dest });

  return { ok: true, message: `Pencairan <b>${rupiah(pending.prizeIdr)}</b> sedang diproses. Terima kasih.` };
}

/** Member daftarin wallet BNB Chain sendiri — hadiah berikutnya langsung ke situ. */
export async function setExternalWallet({ userId, address }) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, message: "Format address BNB Chain tidak valid (harus 0x... 42 karakter)." };
  }
  await store.setExternalAddress(userId, address);
  return {
    ok: true,
    message: `Wallet kamu sendiri (<code>${esc(address)}</code>) sudah didaftarkan. Hadiah arisan berikutnya langsung dikirim ke situ.`,
  };
}

// ---------------------------------------------------------------------
// Keluar / bayar utang / replace / priority-draw / governance
// ---------------------------------------------------------------------

export async function exitArisan({ chatId, userId }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const member = await store.getMember(group.group_id, userId);
  if (!member) return { ok: false, message: "Kamu belum ikut arisan ini." };

  try {
    const { refundIdr, debtChargedIdr, txHash } = await chain.exitMember(group.group_id, member.wallet_address);
    // Baris DB-nya ditandai (bukan dihapus) setelah on-chain sukses — riwayat
    // pembayarannya masih dipakai buat rekonsiliasi, tapi dia tidak boleh lagi
    // nongol di roster /status atau kena sapuan denda.
    await store.markMemberExited(group.group_id, userId);
    if (debtChargedIdr > 0) {
      return {
        ok: true,
        message:
          `Kamu keluar dari Arisan #${group.group_id}. Karena sudah pernah menang, kamu kena tanggungan ` +
          `<b>${rupiah(debtChargedIdr)}</b> — ketik <i>bayar utang</i> buat melunasi.\n` +
          `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>`,
      };
    }
    return {
      ok: true,
      message:
        `Kamu keluar dari Arisan #${group.group_id}. Refund <b>${rupiah(refundIdr)}</b> sudah dikirim ke wallet kamu.\n` +
        `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>`,
    };
  } catch (e) {
    return { ok: false, message: `Gagal keluar: ${esc(chain.describeError(e))}` };
  }
}

export async function requestPayDebt({ chatId, userId, amountIdr }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const member = await store.getMember(group.group_id, userId);
  if (!member) return { ok: false, message: "Kamu belum ikut arisan ini." };

  const m = await chain.getMember(group.group_id, member.wallet_address);
  if (m.balanceOwedIdr <= 0) return { ok: false, message: "Kamu tidak punya utang di arisan ini." };
  const pay = Math.min(amountIdr || m.balanceOwedIdr, m.balanceOwedIdr);

  const externalId = `teko-debt-g${group.group_id}-u${userId}-${Date.now().toString(36)}`;
  const { paymentUrl } = await createInvoice({
    externalId,
    grossIdr: pay,
    description: `Bayar utang Arisan #${group.group_id}`,
  });
  await store.savePayment({
    order_id: externalId,
    group_id: group.group_id,
    round: 0,
    telegram_user_id: String(userId),
    amount_idr: pay,
    fee_idr: 0,
    payment_url: paymentUrl,
    status: "pending",
    kind: "debt",
    member_wallet: member.wallet_address,
  });

  return {
    ok: true,
    message: `Utang kamu di Arisan #${group.group_id}: <b>${rupiah(m.balanceOwedIdr)}</b>. Bayar <b>${rupiah(pay)}</b> lewat link ini:`,
    paymentUrl,
  };
}

/**
 * Tawar posisi antrian `targetUsername` seharga `feeIdr` — adaptasi priority-
 * swap (piauw) Circa. Mode PerCycle: target WAJIB posisi terdepan (posisi
 * lain bakal keburu diacak ulang). Mode Upfront: kamu (requester) WAJIB di
 * posisi lebih belakang dari target (bayar buat maju, bukan mundur).
 */
export async function requestPriority({ chatId, userId, targetUsername, feeIdr }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const member = await store.getMember(group.group_id, userId);
  if (!member) return { ok: false, message: "Kamu belum ikut arisan ini." };
  if (!feeIdr || feeIdr < 1000) return { ok: false, message: "Sebutkan nominalnya, mis: <i>mau prioritas 50rb ke @budi</i>." };
  if (!targetUsername) return { ok: false, message: "Sebutkan mau gantiin posisi siapa, mis: <i>mau prioritas 50rb ke @budi</i>." };

  const target = await store.getMemberByUsername(group.group_id, targetUsername);
  if (!target) return { ok: false, message: `User @${esc(targetUsername)} gak ketemu di arisan ini.` };
  if (String(target.telegram_user_id) === String(userId))
    return { ok: false, message: "Gak bisa nawar posisi kamu sendiri." };

  const g = await chain.getGroup(group.group_id);
  if (!g.activated) return { ok: false, message: "Antrian belum ada — tunggu ronde pertama diundi dulu." };

  const externalId = `teko-priority-g${group.group_id}-u${userId}-${Date.now().toString(36)}`;
  const { paymentUrl } = await createInvoice({
    externalId,
    grossIdr: feeIdr,
    description: `Priority-swap Arisan #${group.group_id}`,
  });
  await store.savePayment({
    order_id: externalId,
    group_id: group.group_id,
    round: 0,
    telegram_user_id: String(userId),
    amount_idr: feeIdr,
    fee_idr: 0,
    payment_url: paymentUrl,
    status: "pending",
    kind: "priority",
    member_wallet: member.wallet_address,
    target_wallet: target.wallet_address,
  });

  return {
    ok: true,
    message: `Tawar posisi @${esc(targetUsername)} seharga <b>${rupiah(feeIdr)}</b>. Bayar lewat link ini:`,
    paymentUrl,
  };
}

/** Target dari sebuah priority-swap terima/tolak tawaran yang lagi nunggu. */
export async function respondPrioritySwap({ chatId, userId, accept }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const target = await store.getMember(group.group_id, userId);
  if (!target) return { ok: false, message: "Kamu belum ikut arisan ini." };

  const bid = await chain.getPriorityBid(group.group_id, target.wallet_address);
  if (!bid.feeIdr) return { ok: false, message: "Gak ada tawaran yang nunggu jawaban kamu." };

  try {
    if (accept) {
      await chain.acceptPrioritySwap(group.group_id, target.wallet_address, bid.requester);
      return { ok: true, message: `Tawaran <b>${rupiah(bid.feeIdr)}</b> diterima — posisi antrian udah ketuker.` };
    }
    await chain.rejectPrioritySwap(group.group_id, target.wallet_address);
    return { ok: true, message: "Tawaran ditolak. Dana penawar dikembalikan." };
  } catch (e) {
    return { ok: false, message: `Gagal memproses: ${esc(chain.describeError(e))}` };
  }
}

/** Ajukan tukeran posisi GRATIS (saling setuju, gak ada uang) dengan `targetUsername`. */
export async function requestFreeSwap({ chatId, userId, targetUsername }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const requester = await store.getMember(group.group_id, userId);
  if (!requester) return { ok: false, message: "Kamu belum ikut arisan ini." };
  if (!targetUsername)
    return { ok: false, message: "Sebutkan mau tuker sama siapa, mis: <i>tuker posisi sama @budi</i>." };

  const target = await store.getMemberByUsername(group.group_id, targetUsername);
  if (!target) return { ok: false, message: `User @${esc(targetUsername)} gak ketemu di arisan ini.` };

  try {
    await chain.requestSwap(group.group_id, requester.wallet_address, target.wallet_address);
  } catch (e) {
    return { ok: false, message: `Gagal ajukan tukeran: ${esc(chain.describeError(e))}` };
  }

  await notifyUser(
    target.telegram_user_id,
    `@${esc(requester.username || "Seseorang")} ngajak tuker posisi antrian di Arisan #${group.group_id}.\n` +
      `Ketik <i>terima tukeran</i> di grup arisan itu buat setuju.`
  );
  return { ok: true, message: `Ajakan tuker posisi ke @${esc(targetUsername)} udah dikirim, nunggu dia setuju.` };
}

/** Target dari sebuah ajakan tukeran gratis menyetujuinya. */
export async function acceptFreeSwap({ chatId, userId }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const target = await store.getMember(group.group_id, userId);
  if (!target) return { ok: false, message: "Kamu belum ikut arisan ini." };

  const requesterWallet = await chain.getPendingSwap(group.group_id, target.wallet_address);
  if (!requesterWallet || /^0x0+$/.test(requesterWallet))
    return { ok: false, message: "Gak ada ajakan tukeran yang nunggu jawaban kamu." };

  try {
    await chain.acceptSwap(group.group_id, target.wallet_address, requesterWallet);
  } catch (e) {
    return { ok: false, message: `Gagal terima tukeran: ${esc(chain.describeError(e))}` };
  }
  return { ok: true, message: "Tukeran posisi diterima — posisi kalian udah ketuker." };
}

/** Anggota lama minta diganti — hasilkan deep-link buat penggantinya buka & konfirmasi. */
export async function requestReplace({ chatId, oldUserId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const old = await store.getMember(group.group_id, oldUserId);
  if (!old) return { ok: false, message: "Kamu belum ikut arisan ini." };
  if (old.exited) return { ok: false, message: "Slot kamu sudah tidak aktif." };

  return { ok: true, groupId: group.group_id };
}

/** Dipanggil setelah calon pengganti buka deep-link & konfirmasi identitasnya. */
export async function completeReplace({ groupId, oldUserId, newUserId, newUsername }) {
  const old = await store.getMember(groupId, oldUserId);
  if (!old) return { ok: false, message: "Slot lama tidak ditemukan atau sudah tidak aktif." };

  const newWallet = await custodialAddress(newUserId);
  try {
    await chain.replaceMember(groupId, old.wallet_address, newWallet);
  } catch (e) {
    return { ok: false, message: `Gagal ganti anggota: ${esc(chain.describeError(e))}` };
  }
  await store.addMember({ groupId, telegramUserId: newUserId, username: newUsername, walletAddress: newWallet });
  // Tanpa ini, yang lama dan penggantinya sama-sama muncul di roster selamanya.
  await store.markMemberExited(groupId, oldUserId);

  return { ok: true, message: `@${esc(newUsername || "Anggota baru")} sekarang mengambil alih slot arisan ini di Arisan #${groupId}.` };
}

/** Admin ajukan proposal governance. kind: "skip" (lewati giliran ronde ini) | "kick" (keluarkan). */
export async function proposeGovernance({ chatId, kind, targetUserId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const target = await store.getMember(group.group_id, targetUserId);
  if (!target) return { ok: false, message: "User itu belum ikut arisan ini." };

  const kindNum = kind === "kick" ? 1 : 0;
  let result;
  try {
    result = await chain.propose(group.group_id, kindNum, target.wallet_address);
  } catch (e) {
    return { ok: false, message: `Gagal ajukan proposal: ${esc(chain.describeError(e))}` };
  }
  const label = kind === "kick" ? "keluarkan" : "lewati giliran menang ronde ini";
  return {
    ok: true,
    message:
      `Proposal #${result.proposalId}: <b>${label}</b> @${esc(target.username || "member")} diajukan (butuh 70% suara setuju).\n` +
      `Anggota lain ketik <i>setuju ${result.proposalId}</i> atau <i>tolak ${result.proposalId}</i>.\n` +
      `<a href="https://testnet.bscscan.com/tx/${result.txHash}">Bukti on-chain</a>`,
  };
}

export async function castVote({ chatId, userId, proposalId, approve }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const voter = await store.getMember(group.group_id, userId);
  if (!voter) return { ok: false, message: "Kamu belum ikut arisan ini." };

  try {
    await chain.vote(group.group_id, proposalId, voter.wallet_address, approve);
  } catch (e) {
    return { ok: false, message: `Gagal vote: ${esc(chain.describeError(e))}` };
  }

  const p = await chain.getProposal(group.group_id, proposalId);
  let extra = "";
  if (p.yesVotes >= p.requiredYes) {
    try {
      await chain.executeProposal(group.group_id, proposalId);
      extra = "\n\nKuorum tercapai — proposal langsung dieksekusi.";
    } catch {
      /* mungkin sudah dieksekusi duluan, atau bar berubah — biarkan, admin bisa /eksekusi manual */
    }
  }
  return {
    ok: true,
    message: `Suara kamu (${approve ? "setuju" : "tolak"}) buat proposal #${proposalId} tercatat on-chain. (${p.yesVotes}/${p.requiredYes} suara setuju)${extra}`,
  };
}

/** Denda semua anggota grup `groupId` yang belum setor & sudah lewat deadline ronde ini.
 *  Dipakai bareng dari command manual (`/denda`) maupun cron sweep otomatis. */
async function _penalizeGroup(groupId) {
  const g = await chain.getGroup(groupId);
  if (!g.cycleDeadline || Date.now() / 1000 <= g.cycleDeadline) return [];

  const members = await store.getMembers(groupId);
  const results = [];
  for (const m of members) {
    try {
      const r = await chain.penalize(groupId, m.wallet_address);
      if (r.chargeIdr > 0) results.push(`@${esc(m.username || "member")}: +${rupiah(r.chargeIdr)}`);
    } catch {
      /* sudah bayar / sudah keluar / belum ada yg perlu ditagih hari ini -> lewati */
    }
  }
  return results;
}

/** Command manual admin: `/denda`. */
export async function penalizeLateMembers({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const g = await chain.getGroup(group.group_id);
  if (!g.cycleDeadline || Date.now() / 1000 <= g.cycleDeadline)
    return { ok: false, message: "Belum lewat deadline ronde ini." };

  const results = await _penalizeGroup(group.group_id);
  if (!results.length) return { ok: true, message: "Tidak ada yang perlu didenda saat ini." };
  return { ok: true, message: `Denda keterlambatan diterapkan:\n${results.join("\n")}` };
}

/**
 * Cron: loop semua grup yang masih berjalan, denda otomatis siapa pun yang
 * telat lewat deadline ronde -- gak nunggu admin inget ketik `/denda`.
 * Dipanggil berkala dari `startDeadlineCron()` di index.js.
 */
export async function sweepAllDeadlines() {
  const groups = await store.getActiveGroups();
  for (const group of groups) {
    try {
      const results = await _penalizeGroup(group.group_id);
      if (results.length && group.chat_id) {
        await notify(
          group.chat_id,
          `⏰ Denda keterlambatan otomatis (Arisan #${group.group_id}, lewat deadline ronde):\n${results.join("\n")}`
        );
      }
    } catch (e) {
      console.error(`[cron] sweep deadline gagal utk grup ${group.group_id}:`, e.message);
    }
  }
}

/**
 * Cocokkan address on-chain ke identitas Telegram. Sengaja termasuk anggota
 * yang sudah keluar: event lama (mis. RoundDrawn yang baru disusulkan lewat
 * backfill) bisa menyebut address orang yang keluar setelah event itu, dan
 * "pemenang" tanpa nama bikin pengumumannya tidak kebaca.
 */
async function memberByWallet(groupId, wallet) {
  const members = await store.getMembers(groupId, { includeExited: true });
  return members.find((m) => m.wallet_address?.toLowerCase() === wallet.toLowerCase()) || null;
}

// ---------------------------------------------------------------------
// Pemulihan & kesehatan operasional
// ---------------------------------------------------------------------

/**
 * Coba ulang setoran yang uangnya sudah masuk tapi kreditnya on-chain gagal
 * (`deposit_failed`). Barisnya dikembalikan ke 'pending' lalu dilewatkan
 * `onPaymentSettled` seperti biasa, jadi klaim atomiknya tetap satu pintu dan
 * retry tidak bisa balapan sama webhook yang datang telat.
 *
 * Pemeriksaan nominal dilewati (`paidAmountIdr` = null) karena baris ini sudah
 * pernah lolos verifikasi itu waktu webhook pertama datang.
 */
export async function retryFailedPayments() {
  const rows = await store.getRetryablePayments();
  let ok = 0;
  for (const row of rows) {
    const requeued = await store.requeuePayment(row.order_id);
    if (!requeued) continue; // keburu diproses jalur lain
    try {
      await onPaymentSettled(row.order_id, null);
      const after = await store.getPayment(row.order_id);
      if (after?.status === "settled") ok += 1;
    } catch (e) {
      console.error(`[retry] ${row.order_id} gagal lagi:`, e.message);
    }
  }
  if (rows.length) console.log(`[retry] ${ok}/${rows.length} pembayaran gagal berhasil dikreditkan ulang.`);
  return { attempted: rows.length, succeeded: ok };
}

/**
 * Cek saldo operasional Treasury dan lapor ke admin kalau menipis.
 *
 * Ini penyebab paling mungkin di balik `deposit_failed`: setiap setoran member
 * dikreditkan dengan IDRX milik Treasury, dan setiap sweep hadiah butuh BNB
 * buat top-up gas wallet custodial. Kalau salah satunya habis, semua setoran
 * yang masuk gagal dikreditkan padahal uang fiat user sudah tertagih — jauh
 * lebih baik ketahuan sebelum itu terjadi.
 *
 * Ambang IDRX = biaya satu ronde penuh untuk SEMUA grup aktif, yaitu nominal
 * maksimum yang bisa ditagihkan ke Treasury sebelum ada kesempatan isi ulang.
 */
export async function checkTreasuryHealth({ alert = true } = {}) {
  const { idrxIdr, bnbWei } = await chain.treasuryBalances();

  let requiredIdr = 0;
  for (const group of await store.getActiveGroups()) {
    try {
      const g = await chain.getGroup(group.group_id);
      if (g.finished) continue;
      requiredIdr += g.contributionIdr * (g.rosterLocked ? g.activeCount : g.size);
    } catch {
      /* grup gak kebaca di chain -> lewati, jangan bikin health check ikut mati */
    }
  }

  // Cukup buat ~20 sweep/top-up sebelum benar-benar mentok.
  const bnbFloorWei = config.chain.sweepGasTopupWei * 20n;
  const idrxLow = requiredIdr > 0 && idrxIdr < requiredIdr;
  const bnbLow = bnbWei < bnbFloorWei;

  if (alert && (idrxLow || bnbLow)) {
    const lines = [];
    if (idrxLow)
      lines.push(
        `• IDRX: ${rupiah(idrxIdr)} — kurang buat 1 ronde penuh semua grup aktif (${rupiah(requiredIdr)}).`
      );
    if (bnbLow)
      lines.push(`• BNB: ${ethers.formatEther(bnbWei)} — tipis buat gas sweep/top-up.`);
    await notifyAdmins(
      `Saldo Treasury menipis.\n${lines.join("\n")}\n\n` +
        `Selama ini kurang, setoran yang masuk bakal gagal dikreditkan on-chain.`
    );
  }

  return { idrxIdr, bnbWei, requiredIdr, idrxLow, bnbLow };
}

/**
 * Skor reputasi lintas-grup seorang member. Kontraknya sudah merekam
 * tepat-waktu/telat/gagal-bayar sejak awal, tapi sebelumnya tidak ada satu pun
 * jalan buat melihatnya dari Telegram.
 */
export async function reputationCard({ chatId, userId, targetUsername }) {
  const group = await resolveGroupForUser(chatId, userId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };

  const member = targetUsername
    ? await store.getMemberByUsername(group.group_id, targetUsername)
    : await store.getMember(group.group_id, userId);
  if (!member)
    return {
      ok: false,
      message: targetUsername
        ? `User @${esc(targetUsername)} gak ketemu di arisan ini.`
        : "Kamu belum ikut arisan ini.",
    };

  const rep = await chain.reputationOf(member.wallet_address);
  if (!rep)
    return { ok: false, message: "Kontrak reputasi belum dipasang (REPUTATION_ADDRESS kosong)." };

  const who = member.username ? `@${esc(member.username)}` : "Kamu";
  const total = rep.onTime + rep.late + rep.defaulted;
  const verdict =
    total === 0
      ? "Belum ada riwayat — skor dimulai dari 0 dan naik tiap setoran tepat waktu."
      : rep.score >= 70
        ? "Rapornya bagus. 👍"
        : rep.score >= 40
          ? "Lumayan, tapi masih ada catatan telat."
          : "Perlu diperbaiki — banyak telat / nunggak.";

  return {
    ok: true,
    message:
      `<b>Reputasi ${who}</b> (berlaku lintas semua arisan)\n` +
      `Skor: <b>${rep.score}/100</b>\n` +
      `• Tepat waktu: ${rep.onTime}\n` +
      `• Telat: ${rep.late}\n` +
      `• Gagal bayar: ${rep.defaulted}\n\n` +
      `<i>${verdict}</i>`,
  };
}

/**
 * Tutup paksa grup yang macet (treasury-only, darurat). Sisa pot + reserve
 * dibagi rata ke anggota yang belum menang — lihat forceClose di kontrak.
 * Sebelumnya fungsi ini ada di chain.js tapi tidak bisa dipanggil dari mana
 * pun, jadi satu-satunya jalan keluar grup macet adalah lewat cast manual.
 */
export async function forceCloseArisan({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };

  try {
    const { txHash } = await chain.forceClose(group.group_id);
    await store.setGroupStatus(group.group_id, "finished");
    return {
      ok: true,
      message:
        `<b>Arisan #${group.group_id} ditutup paksa.</b>\n` +
        `Sisa pot dan cadangan dibagi rata ke anggota yang belum pernah menang.\n` +
        `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>`,
    };
  } catch (e) {
    return { ok: false, message: `Gagal tutup paksa: ${esc(chain.describeError(e))}` };
  }
}
