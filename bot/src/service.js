import { config, rupiah, esc, idrToUnits } from "./config.js";
import * as chain from "./chain.js";
import * as store from "./store.js";
import { createInvoice, createPayout, resolveChannelCode } from "./xendit.js";
import { custodialAddress, sweepToTreasury, sweepToExternal } from "./wallet.js";
import { notify, notifyUser } from "./notifier.js";

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
    console.error("[settle] deposit on-chain gagal:", e.message);
    await store.updatePayment(oid, { status: "deposit_failed" });
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
    console.error("[settle] payDebt gagal:", e.message);
    await store.updatePayment(oid, { status: "deposit_failed" });
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
    console.error("[settle] requestPrioritySwap gagal:", chain.describeError(e));
    await store.updatePayment(oid, { status: "deposit_failed" });
  }
}

/** ID arisan aktif di sebuah grup (untuk bikin deep-link). null bila tak ada. */
export async function activeGroupId(chatId) {
  const group = await store.getGroupByChat(chatId);
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
export async function handleRoundDrawn({ groupId, round, winner, prizeIdr, feeIdr, txHash }) {
  const group = await store.getGroupById(groupId);
  const chatId = group?.chat_id || null;

  const member = await memberByWallet(groupId, winner);
  const who = member?.username ? `@${esc(member.username)}` : `pemenang`;

  const after = await chain.getGroup(groupId);
  if (after.finished && group) await store.setGroupStatus(groupId, "finished");

  if (member) await _handlePrizeSweep({ member, groupId, round, prizeIdr });

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
      store.setPendingPayout(userId, { groupId, round, prizeIdr });
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
  }
}

async function _payout({ telegramUserId, groupId, round, prizeIdr, dest }) {
  const referenceId = `teko-payout-g${groupId}-r${round}-u${telegramUserId}-${Date.now().toString(36)}`;
  try {
    const r = await createPayout({
      referenceId,
      amountIdr: prizeIdr,
      channelCode: dest.channel_code,
      accountNumber: dest.account_number,
      accountHolderName: dest.account_holder_name,
    });
    await notifyUser(
      telegramUserId,
      `Pencairan <b>${rupiah(prizeIdr)}</b> ke <b>${esc(dest.channel_code)} ${esc(dest.account_number)}</b> sedang diproses (status: ${esc(r.status)}).`
    );
  } catch (e) {
    console.error("[payout] gagal:", e.message);
    await notifyUser(
      telegramUserId,
      `Pencairan hadiah gagal diproses otomatis. Admin akan bantu manual, mohon tunggu.`
    );
  }
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
  const pending = store.getPendingPayout(userId);
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
  store.clearPendingPayout(userId);

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

async function memberByWallet(groupId, wallet) {
  const members = await store.getMembers(groupId);
  return members.find((m) => m.wallet_address?.toLowerCase() === wallet.toLowerCase()) || null;
}
