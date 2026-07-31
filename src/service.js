import { config, rupiah, esc } from "./config.js";
import * as chain from "./chain.js";
import * as store from "./store.js";
import { createPaymentLink } from "./midtrans.js";
import { custodialAddress } from "./wallet.js";
import { notify, notifyUser } from "./notifier.js";

/**
 * Buat arisan baru on-chain + simpan metadata.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function createArisan({ chatId, size, contributionIdr }) {
  if (!size || size < 2 || size > 50)
    return { ok: false, message: "Jumlah anggota harus 2–50 ya. Contoh: <i>arisan 5 orang 200rb</i>." };
  if (!contributionIdr || contributionIdr < 1000)
    return { ok: false, message: "Setoran minimal Rp1.000. Contoh: <i>arisan 5 orang 200rb</i>." };

  const { groupId, txHash } = await chain.createGroup(size, contributionIdr);
  if (!groupId) return { ok: false, message: "Gagal baca groupId dari transaksi. Coba lagi." };

  await store.saveGroup({ groupId, chatId, size, contributionIdr });

  return {
    ok: true,
    groupId,
    message:
      `<b>Arisan #${groupId} dibuat.</b>\n` +
      `• Anggota: ${size} orang\n` +
      `• Setoran: ${rupiah(contributionIdr)}/orang/ronde\n` +
      `• Pemenang tiap ronde diundi adil (tidak menang 2x)\n\n` +
      `Anggota tekan tombol <b>Ikut Arisan Ini</b> di bawah untuk setor — nggak perlu wallet.\n\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Lihat transaksi</a>`,
  };
}

/**
 * Member gabung / bayar ronde berjalan. Tidak perlu wallet — bot menurunkan
 * custodial address otomatis per user. Menghasilkan Payment Link Midtrans.
 */
export async function joinOrPay({ chatId, groupId: gid, userId, username, firstName, lastName }) {
  // gid diberikan bila datang lewat deep-link (chat japri); kalau tidak, cari dari grup.
  const group = gid ? await store.getGroupById(gid) : await store.getGroupByChat(chatId);
  if (!group)
    return { ok: false, message: "Belum ada arisan aktif. Buat dulu di grup: <i>arisan 5 orang 200rb</i>." };
  if (group.status !== "collecting")
    return { ok: false, message: "Arisan ini sudah selesai." };

  const groupId = group.group_id;
  let member = await store.getMember(groupId, userId);

  // Auto-daftar dengan custodial address (user tak perlu punya wallet)
  if (!member) {
    const walletAddress = custodialAddress(userId);
    member = await store.addMember({ groupId, telegramUserId: userId, username, walletAddress });
  }

  // Cek status ronde on-chain
  const g = await chain.getGroup(groupId);
  if (g.finished) return { ok: false, message: `Arisan #${groupId} sudah selesai. 🎉` };

  const round = g.round === 0 ? 1 : g.round;
  const grossIdr = group.contribution_idr + config.fee.convenienceIdr;
  const orderId = `teko-g${groupId}-r${round}-u${userId}-${Date.now().toString(36)}`;

  const { paymentUrl } = await createPaymentLink({
    orderId,
    grossIdr,
    name: `Setoran Arisan #${groupId} Ronde ${round}`,
    customer: {
      firstName: firstName || username || "Anggota",
      lastName,
      // email sengaja tidak di-prefill — user isi manual di halaman bayar.
    },
  });

  await store.savePayment({
    order_id: orderId,
    group_id: groupId,
    round,
    telegram_user_id: String(userId),
    amount_idr: group.contribution_idr,
    fee_idr: config.fee.convenienceIdr,
    payment_url: paymentUrl,
    status: "pending",
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
 * Dipanggil webhook Midtrans saat pembayaran lunas.
 * Treasury melakukan deposit() on-chain, lalu umumkan ke grup.
 */
export async function onPaymentSettled(orderId) {
  // Midtrans Payment Link menambah suffix "-<timestamp>" pada order_id notifikasi.
  // Coba exact match dulu, lalu fallback ke order_id dasar (tanpa suffix numerik).
  let pay = await store.getPayment(orderId);
  if (!pay) {
    const base = orderId.replace(/-\d+$/, "");
    if (base !== orderId) pay = await store.getPayment(base);
  }
  if (!pay) {
    console.warn("[settle] payment tidak ditemukan:", orderId);
    return;
  }
  const oid = pay.order_id; // order_id tersimpan (untuk update)
  if (pay.status === "settled") return; // idempotent

  const member = await store.getMember(pay.group_id, pay.telegram_user_id);
  if (!member?.wallet_address) {
    console.error("[settle] member/wallet tidak ada untuk", oid);
    return;
  }

  await store.updatePayment(oid, { status: "settled" });

  // Treasury deposit on-chain atas nama member
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

  const collected = g.paidThisRound * g.contributionIdr;
  const target = g.size * g.contributionIdr;

  // Pengumuman GRUP: anonim (tidak menyebut siapa yang bayar).
  let msg =
    `Setoran baru masuk ke <b>pool arisan</b> on-chain.\n` +
    `Terkumpul: <b>${rupiah(collected)}</b> / ${rupiah(target)}  (${g.paidThisRound}/${g.size} orang)\n` +
    `<a href="https://testnet.bscscan.com/tx/${depositTx}">Bukti on-chain</a>`;
  if (g.paidThisRound === g.size) {
    msg += `\n\nPool penuh! Admin ketik <b>undi</b> untuk mengundi pemenang ronde ${g.round}.`;
  }
  if (chatId) await notify(chatId, msg);

  // Resi PRIBADI ke pembayar (hanya terkirim bila user pernah /start bot).
  const total = (pay.amount_idr || 0) + (pay.fee_idr || 0);
  await notifyUser(
    pay.telegram_user_id,
    `Pembayaran kamu <b>${rupiah(total)}</b> diterima.\n` +
      `Kamu sudah setor Arisan #${pay.group_id} Ronde ${g.round}. Terima kasih.`
  );
}

/** ID arisan aktif di sebuah grup (untuk bikin deep-link). null bila tak ada. */
export async function activeGroupId(chatId) {
  const group = await store.getGroupByChat(chatId);
  return group?.group_id || null;
}

/** Undi pemenang ronde berjalan (hanya admin). */
export async function drawWinner({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };

  const g = await chain.getGroup(group.group_id);
  if (g.finished) return { ok: false, message: `Arisan #${group.group_id} sudah selesai. 🎉` };
  if (g.paidThisRound !== g.size)
    return {
      ok: false,
      message: `Belum semua setor (${g.paidThisRound}/${g.size}). Tunggu semua bayar dulu.`,
    };

  const { winner, prizeIdr, feeIdr, txHash } = await chain.drawRound(group.group_id);
  const member = await memberByWallet(group.group_id, winner);
  const who = member?.username ? `@${esc(member.username)}` : `pemenang`;

  const after = await chain.getGroup(group.group_id);
  if (after.finished) await store.setGroupStatus(group.group_id, "finished");

  // Siapkan pencairan fiat: minta nomor rekening lewat JAPRI (privasi), bukan di grup.
  if (member) {
    store.setPendingPayout(member.telegram_user_id, {
      groupId: group.group_id,
      round: g.round,
      prizeIdr,
    });
    await notifyUser(
      member.telegram_user_id,
      `Selamat! Kamu menang Arisan #${group.group_id} Ronde ${g.round} — hadiah <b>${rupiah(prizeIdr)}</b>.\n` +
        `Balas pesan ini dengan nomor e-wallet/rekening buat pencairan.\n` +
        "Contoh: <code>GoPay 081234567890</code> atau <code>BCA 1234567890</code>"
    );
  }

  return {
    ok: true,
    message:
      `<b>Pemenang Ronde ${g.round} Arisan #${group.group_id}:</b> ${who}\n` +
      `• Hadiah: <b>${rupiah(prizeIdr)}</b> (99%)\n` +
      `• Platform fee: ${rupiah(feeIdr)} (1%)\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>\n\n` +
      (member ? `${who}, cek <b>japri</b> dari bot buat klaim pencairan (privat).` : "") +
      (after.finished ? `\n\nArisan selesai — semua sudah kebagian.` : ``),
  };
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

  return {
    ok: true,
    message:
      `<b>Arisan #${group.group_id}</b> — Ronde ${round}\n` +
      `Setoran ${rupiah(g.contributionIdr)}/orang · Pot ${rupiah(g.contributionIdr * g.size)}\n` +
      `Sudah bayar: <b>${g.paidThisRound}/${g.size}</b> · Sudah menang: ${g.winnersCount}/${g.size}` +
      detail +
      `\n\n` +
      (g.finished ? `Status: <b>SELESAI</b>` : `Status: berjalan`),
  };
}

/**
 * Proses pencairan fiat setelah pemenang mengirim nomor rekening/e-wallet.
 * MVP: disimulasikan (Midtrans Payout/Iris butuh approval + saldo). Hadiah IDRX
 * sudah cair ke custodial address pemenang on-chain; ini merepresentasikan off-ramp.
 * @returns {{ok:boolean, message:string}|null} null bila tak ada pencairan tertunda.
 */
export async function processPayout(userId, destination) {
  const pending = store.getPendingPayout(userId);
  if (!pending) return null;

  const dest = destination.trim();
  if (dest.replace(/\D/g, "").length < 6)
    return { ok: false, message: "Nomor rekening/e-wallet kurang valid. Contoh: <code>GoPay 081234567890</code>" };

  store.clearPendingPayout(userId);

  // TODO produksi: panggil Midtrans Payout/Iris API di sini.
  return {
    ok: true,
    message:
      `Pencairan <b>${rupiah(pending.prizeIdr)}</b> ke <b>${esc(dest)}</b> sedang diproses. (simulasi)\n` +
      `Dana arisan Ronde ${pending.round} sudah cair ke rekeningmu. Terima kasih.`,
  };
}

async function memberByWallet(groupId, wallet) {
  const members = await store.getMembers(groupId);
  return members.find((m) => m.wallet_address?.toLowerCase() === wallet.toLowerCase()) || null;
}
