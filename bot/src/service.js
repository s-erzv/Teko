import { config, rupiah, esc, idrToUnits } from "./config.js";
import * as chain from "./chain.js";
import * as store from "./store.js";
import { createInvoice, createPayout, resolveChannelCode } from "./xendit.js";
import { custodialAddress, sweepToTreasury, sweepToExternal } from "./wallet.js";
import { notify, notifyUser } from "./notifier.js";

/**
 * Buat arisan baru on-chain + simpan metadata. Parameter opsional
 * (cycleLengthSecs, penalty, dst) dipakai default dari config kalau tidak
 * disebutkan — lihat contracts/TekoArisan.sol untuk arti tiap parameter.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function createArisan({ chatId, size, contributionIdr }) {
  if (!size || size < 2 || size > 50)
    return { ok: false, message: "Jumlah anggota harus 2–50 ya. Contoh: <i>arisan 5 orang 200rb</i>." };
  if (!contributionIdr || contributionIdr < 1000)
    return { ok: false, message: "Setoran minimal Rp1.000. Contoh: <i>arisan 5 orang 200rb</i>." };

  const { groupId, txHash } = await chain.createGroup({ size, contributionIdr });
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
 * `paidAmountIdr` (dari `paid_amount` Xendit) diverifikasi cocok sama yang
 * ditagih SEBELUM kredit apa pun jalan on-chain — sama seperti pengecekan
 * amount-mismatch di webhook Xendit-nya Circa. Klaim baris pending->settled
 * dilakukan atomik (`claimPaymentPending`) supaya webhook yang di-retry
 * Xendit tidak memicu kredit dua kali.
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

  const expected = pay.kind === "contribution" || !pay.kind
    ? (pay.amount_idr || 0) + (pay.fee_idr || 0)
    : pay.amount_idr || 0;
  if (paidAmountIdr != null && Math.round(paidAmountIdr) !== Math.round(expected)) {
    console.error(`[settle] nominal tidak cocok untuk ${oid}: diharapkan ${expected}, diterima ${paidAmountIdr}`);
    await store.updatePayment(oid, { status: "amount_mismatch" });
    return;
  }

  const claimed = await store.claimPaymentPending(oid);
  if (!claimed) return; // sudah diklaim request lain, atau bukan 'pending' -> idempotent no-op

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

  const collected = g.paidThisRound * g.contributionIdr;
  const target = g.activeCount * g.contributionIdr;

  let msg =
    `Setoran baru masuk ke <b>pool arisan</b> on-chain.\n` +
    `Terkumpul: <b>${rupiah(collected)}</b> / ${rupiah(target)}  (${g.paidThisRound}/${g.activeCount} orang)\n` +
    `<a href="https://testnet.bscscan.com/tx/${depositTx}">Bukti on-chain</a>`;
  if (g.paidThisRound === g.activeCount) {
    msg += `\n\nPool penuh! Admin ketik <b>undi</b> untuk mengundi pemenang ronde ${g.round}.`;
  }
  if (chatId) await notify(chatId, msg);

  const total = (pay.amount_idr || 0) + (pay.fee_idr || 0);
  await notifyUser(
    pay.telegram_user_id,
    `Pembayaran kamu <b>${rupiah(total)}</b> diterima.\n` +
      `Kamu sudah setor Arisan #${pay.group_id} Ronde ${g.round}. Terima kasih.`
  );
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
    const r = await chain.requestPriorityDraw(pay.group_id, pay.member_wallet, pay.amount_idr, pay.extra_tickets);
    await store.updatePayment(oid, { tx_hash: r.txHash });
    await notifyUser(
      pay.telegram_user_id,
      `Kamu beli <b>${pay.extra_tickets} tiket ekstra</b> buat undian ronde berikutnya di Arisan #${pay.group_id}. Semoga beruntung!`
    );
  } catch (e) {
    console.error("[settle] requestPriorityDraw gagal:", e.message);
    await store.updatePayment(oid, { status: "deposit_failed" });
  }
}

/** ID arisan aktif di sebuah grup (untuk bikin deep-link). null bila tak ada. */
export async function activeGroupId(chatId) {
  const group = await store.getGroupByChat(chatId);
  return group?.group_id || null;
}

/**
 * Undi pemenang ronde berjalan (hanya admin). Begitu menang, hadiah IDRX
 * langsung disapu keluar dari wallet custodial pemenang (ke Treasury, atau ke
 * wallet sendiri kalau member sudah daftar address eksternal) — meminimalkan
 * berapa lama dana beneran nongkrong di wallet yang key-nya dipegang server.
 */
export async function drawWinner({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };

  const g = await chain.getGroup(group.group_id);
  if (g.finished) return { ok: false, message: `Arisan #${group.group_id} sudah selesai. 🎉` };
  if (g.paidThisRound !== g.activeCount)
    return {
      ok: false,
      message: `Belum semua setor (${g.paidThisRound}/${g.activeCount}). Tunggu semua bayar dulu.`,
    };

  const { winner, prizeIdr, feeIdr, txHash } = await chain.drawRound(group.group_id);
  const member = await memberByWallet(group.group_id, winner);
  const who = member?.username ? `@${esc(member.username)}` : `pemenang`;

  const after = await chain.getGroup(group.group_id);
  if (after.finished) await store.setGroupStatus(group.group_id, "finished");

  if (member) await _handlePrizeSweep({ member, groupId: group.group_id, round: g.round, prizeIdr });

  return {
    ok: true,
    message:
      `<b>Pemenang Ronde ${g.round} Arisan #${group.group_id}:</b> ${who}\n` +
      `• Hadiah: <b>${rupiah(prizeIdr)}</b>\n` +
      `• Platform fee: ${rupiah(feeIdr)} (1%)\n` +
      `<a href="https://testnet.bscscan.com/tx/${txHash}">Bukti on-chain</a>\n\n` +
      (member ? `${who}, cek <b>japri</b> dari bot buat status pencairan (privat).` : "") +
      (after.finished ? `\n\nArisan selesai — semua sudah kebagian.` : ``),
  };
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

  return {
    ok: true,
    message:
      `<b>Arisan #${group.group_id}</b> — Ronde ${round}\n` +
      `Setoran ${rupiah(g.contributionIdr)}/orang · Pot ${rupiah(g.contributionIdr * g.activeCount)}\n` +
      `Sudah bayar: <b>${g.paidThisRound}/${g.activeCount}</b> · Sudah menang: ${g.winnersCount}` +
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
  const group = await store.getGroupByChat(chatId);
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
    return { ok: false, message: `Gagal keluar: ${esc(e.reason || e.shortMessage || e.message)}` };
  }
}

export async function requestPayDebt({ chatId, userId, amountIdr }) {
  const group = await store.getGroupByChat(chatId);
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

export async function requestPriority({ chatId, userId, feeIdr, tickets = 1 }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const member = await store.getMember(group.group_id, userId);
  if (!member) return { ok: false, message: "Kamu belum ikut arisan ini." };
  if (!feeIdr || feeIdr < 1000) return { ok: false, message: "Sebutkan nominalnya, mis: <i>mau prioritas 50rb</i>." };

  const externalId = `teko-priority-g${group.group_id}-u${userId}-${Date.now().toString(36)}`;
  const { paymentUrl } = await createInvoice({
    externalId,
    grossIdr: feeIdr,
    description: `Tiket prioritas Arisan #${group.group_id}`,
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
    extra_tickets: tickets,
  });

  return {
    ok: true,
    message: `Beli ${tickets} tiket ekstra buat undian ronde berikutnya, seharga <b>${rupiah(feeIdr)}</b>. Bayar lewat link ini:`,
    paymentUrl,
  };
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
    return { ok: false, message: `Gagal ganti anggota: ${esc(e.reason || e.shortMessage || e.message)}` };
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
    return { ok: false, message: `Gagal ajukan proposal: ${esc(e.reason || e.shortMessage || e.message)}` };
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
    return { ok: false, message: `Gagal vote: ${esc(e.reason || e.shortMessage || e.message)}` };
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

/** Cron/admin: denda semua anggota yang belum setor & sudah lewat deadline ronde ini. */
export async function penalizeLateMembers({ chatId }) {
  const group = await store.getGroupByChat(chatId);
  if (!group) return { ok: false, message: "Belum ada arisan aktif di grup ini." };
  const g = await chain.getGroup(group.group_id);
  if (!g.cycleDeadline || Date.now() / 1000 <= g.cycleDeadline)
    return { ok: false, message: "Belum lewat deadline ronde ini." };

  const members = await store.getMembers(group.group_id);
  const results = [];
  for (const m of members) {
    try {
      const r = await chain.penalize(group.group_id, m.wallet_address);
      if (r.chargeIdr > 0) results.push(`@${esc(m.username || "member")}: +${rupiah(r.chargeIdr)}`);
    } catch {
      /* sudah bayar / sudah keluar / belum ada yg perlu ditagih hari ini -> lewati */
    }
  }
  if (!results.length) return { ok: true, message: "Tidak ada yang perlu didenda saat ini." };
  return { ok: true, message: `Denda keterlambatan diterapkan:\n${results.join("\n")}` };
}

async function memberByWallet(groupId, wallet) {
  const members = await store.getMembers(groupId);
  return members.find((m) => m.wallet_address?.toLowerCase() === wallet.toLowerCase()) || null;
}
