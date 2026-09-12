import { ethers } from "ethers";
import { config, idrToUnits, unitsToIdr } from "./config.js";
import { TEKO_ABI, IDRX_ABI, REPUTATION_ABI } from "./abi.js";

const provider = new ethers.JsonRpcProvider(config.chain.rpc);
const treasury = new ethers.Wallet(config.chain.privateKey, provider);

const teko = new ethers.Contract(config.chain.contract, TEKO_ABI, treasury);
const idrx = new ethers.Contract(config.chain.idrx, IDRX_ABI, treasury);
const reputationContract = config.chain.reputation
  ? new ethers.Contract(config.chain.reputation, REPUTATION_ABI, provider)
  : null;

export const treasuryAddress = treasury.address;
export { provider, treasury as treasurySigner };

/** Pastikan Treasury sudah approve IDRX ke kontrak; kalau belum, approve max. */
export async function ensureApproval() {
  const allowance = await idrx.allowance(treasury.address, config.chain.contract);
  if (allowance < ethers.MaxUint256 / 2n) {
    const tx = await idrx.approve(config.chain.contract, ethers.MaxUint256);
    await tx.wait();
    return true;
  }
  return false;
}

/** Cari event bernama `name` di receipt; undefined kalau tidak ada. */
function findEvent(receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = teko.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    } catch {
      /* log dari kontrak lain, abaikan */
    }
  }
  return undefined;
}

/**
 * Ubah error ethers jadi nama custom error kontrak yang jelas (mis.
 * "GroupNotFound"), bukan "unknown custom error" mentah.
 *
 * ethers v6 OTOMATIS decode custom error pakai ABI kontrak untuk revert yang
 * kejadian SETELAH transaksi ke-mining, tapi TIDAK untuk revert yang kejadian
 * di tahap estimateGas (sebelum transaksi dikirim sama sekali) — kasus ini
 * gagal duluan di level provider (JsonRpcProvider.getRpcError), yang generik
 * dan gak tau apa-apa soal ABI kontrak kita. Karena hampir semua write call
 * di sini (deposit/exit/penalize/dst) gagal di tahap estimateGas kalau
 * bisnis logic-nya nolak, decode manual ini yang bikin pesan error ke user
 * kebaca jelas, bukan kriptik.
 */
export function describeError(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (data) {
    try {
      const parsed = teko.interface.parseError(data);
      if (parsed) return parsed.name + (parsed.args?.length ? `(${parsed.args.join(", ")})` : "");
    } catch {
      /* data ada tapi bukan custom error kontrak ini (mis. revert string polos) -> fallback di bawah */
    }
  }
  return e?.reason || e?.shortMessage || e?.message || String(e);
}

/** Mode undian: 0 = PerCycle (antrian diacak ulang tiap ronde), 1 = Upfront
 *  (urutan tetap sekali ditentukan pas aktivasi, ronde berikutnya cair instan). */
export const DRAW_MODE_PER_CYCLE = 0;
export const DRAW_MODE_UPFRONT = 1;

/** Buat grup arisan on-chain. Semua parameter Rupiah dalam angka biasa. */
export async function createGroup({
  size,
  contributionIdr,
  cycleLengthSecs = config.chain.defaultCycleLengthSecs,
  penaltyPerDayIdr = config.chain.defaultPenaltyPerDayIdr,
  exitPenaltyIdr = config.chain.defaultExitPenaltyIdr,
  postPayoutExitPenaltyIdr = config.chain.defaultPostPayoutExitPenaltyIdr,
  reserveBps = config.chain.defaultReserveBps,
  drawMode = DRAW_MODE_PER_CYCLE,
}) {
  const tx = await teko.createGroup(
    size,
    idrToUnits(contributionIdr),
    cycleLengthSecs,
    idrToUnits(penaltyPerDayIdr),
    idrToUnits(exitPenaltyIdr),
    idrToUnits(postPayoutExitPenaltyIdr),
    reserveBps,
    drawMode
  );
  const receipt = await tx.wait();
  const args = findEvent(receipt, "GroupCreated");
  return { groupId: args ? Number(args.groupId) : null, txHash: receipt.hash };
}

/** Setor 1 slot atas nama member (proxy Treasury). */
export async function deposit(groupId, memberAddress) {
  const tx = await teko.deposit(groupId, memberAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * MINTA undian ronde via Chainlink VRF — dua tahap. Fungsi ini cuma
 * mengirim request; pemenang BELUM ditentukan begitu ini resolve.
 * VRFCoordinator memanggil balik `fulfillRandomWords` on-chain beberapa
 * blok kemudian, yang barulah memicu event `RoundDrawn` — dengar event itu
 * lewat `onRoundDrawn()` di bawah, bukan return value fungsi ini.
 */
export async function requestDraw(groupId) {
  // drawRound() sekarang cuma memanggil requestRandomWords() — gas-nya
  // predictable, gak perlu lagi override manual seperti draw pseudo-random
  // lama (yang butuh gasLimit eksplisit krn baca block.prevrandao bikin
  // estimasi gas != eksekusi).
  const tx = await teko.drawRound(groupId);
  const receipt = await tx.wait();
  const args = findEvent(receipt, "DrawRequested");
  return { requestId: args?.requestId ?? null, txHash: receipt.hash };
}

/**
 * Pasang listener permanen buat event `RoundDrawn` — dipanggil sekali saat
 * boot (lihat index.js). VRF fulfillment adalah transaksi TERPISAH yang
 * dikirim Chainlink sendiri (bukan bot), jadi ini satu-satunya cara andal
 * buat tau kapan & siapa pemenangnya, tidak peduli kapan/dari command mana
 * `requestDraw` sebelumnya dipanggil.
 */
export function onRoundDrawn(handler) {
  teko.on("RoundDrawn", (groupId, round, winner, prize, fee, event) => {
    handler(_roundDrawnPayload({ groupId, round, winner, prize, fee }, event.log));
  });
}

/** Bentuk payload RoundDrawn yang sama persis buat listener live & backfill. */
function _roundDrawnPayload(args, log) {
  return {
    groupId: Number(args.groupId),
    round: Number(args.round),
    winner: args.winner,
    prizeIdr: unitsToIdr(args.prize),
    feeIdr: unitsToIdr(args.fee),
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    // Kunci idempotensi: satu log on-chain = satu (txHash, logIndex). Dipakai
    // store.claimEvent biar backfill dan listener live tidak memproses
    // pemenang yang sama dua kali.
    eventKey: `${log.transactionHash}:${log.index}`,
  };
}

export const currentBlock = () => provider.getBlockNumber();

/**
 * Pindai event `RoundDrawn` yang terlewat antara `fromBlock` dan `toBlock`.
 *
 * Listener live saja TIDAK cukup: fulfillment VRF adalah transaksi terpisah
 * yang dikirim Chainlink kapan saja, termasuk saat proses bot mati atau lagi
 * restart. Tanpa pemindaian ulang ini, pemenangnya tidak pernah diumumkan dan
 * hadiahnya tidak pernah disapu — nyangkut di wallet custodial tanpa jejak.
 *
 * Dipecah per `CHUNK` blok karena RPC publik BSC menolak rentang eth_getLogs
 * yang lebar.
 */
export async function scanRoundDrawn(fromBlock, toBlock) {
  const CHUNK = 2000;
  const filter = teko.filters.RoundDrawn();
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const logs = await teko.queryFilter(filter, start, end);
    for (const log of logs) out.push(_roundDrawnPayload(log.args, log));
  }
  return out;
}

/**
 * Saldo operasional Treasury. IDRX dipakai buat mengkreditkan setoran member
 * on-chain, BNB buat gas (termasuk top-up wallet custodial sebelum sweep).
 * Kalau salah satunya habis, setiap setoran yang masuk bakal gagal
 * dikreditkan padahal uang fiat user sudah tertagih.
 */
export async function treasuryBalances() {
  const [idrxUnits, bnbWei] = await Promise.all([
    idrx.balanceOf(treasury.address),
    provider.getBalance(treasury.address),
  ]);
  return { idrxIdr: unitsToIdr(idrxUnits), bnbWei };
}

/** Denda member yang telat setor ronde berjalan. Permissionless di kontrak,
 *  tapi tetap dipanggil lewat Treasury sbg tx submitter (cron/bot). */
export async function penalize(groupId, memberAddress) {
  const tx = await teko.penalize(groupId, memberAddress);
  const receipt = await tx.wait();
  const args = findEvent(receipt, "Penalized");
  return {
    chargeIdr: args ? unitsToIdr(args.charge) : 0,
    balanceOwedIdr: args ? unitsToIdr(args.balanceOwed) : 0,
    txHash: receipt.hash,
  };
}

/** Lunasi utang member (ditarik dari saldo Treasury, dibayar member via fiat). */
export async function payDebt(groupId, memberAddress, amountIdr) {
  const tx = await teko.payDebt(groupId, memberAddress, idrToUnits(amountIdr));
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** Keluarkan member dari grup. */
export async function exitMember(groupId, memberAddress) {
  const tx = await teko.exit(groupId, memberAddress);
  const receipt = await tx.wait();
  const args = findEvent(receipt, "Exited");
  return {
    refundIdr: args ? unitsToIdr(args.refund) : 0,
    debtChargedIdr: args ? unitsToIdr(args.debtCharged) : 0,
    txHash: receipt.hash,
  };
}

/** Ganti anggota (replace) — newMember ambil alih slot oldMember. */
export async function replaceMember(groupId, oldMemberAddress, newMemberAddress) {
  const tx = await teko.replaceMember(groupId, oldMemberAddress, newMemberAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** Ajukan tukeran posisi GRATIS (saling setuju, gak ada uang) dengan `target`. */
export async function requestSwap(groupId, requesterAddress, targetAddress) {
  const tx = await teko.requestSwap(groupId, requesterAddress, targetAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** `target` menyetujui tukeran gratis yang diajukan `requester`. */
export async function acceptSwap(groupId, targetAddress, requesterAddress) {
  const tx = await teko.acceptSwap(groupId, targetAddress, requesterAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Tawar posisi `target` seharga `feeIdr` (priority-swap berbayar). Mode
 * PerCycle: `target` harus posisi terdepan. Mode Upfront: `requester` harus
 * di posisi lebih belakang dari `target`.
 */
export async function requestPrioritySwap(groupId, requesterAddress, targetAddress, feeIdr) {
  const tx = await teko.requestPrioritySwap(groupId, requesterAddress, targetAddress, idrToUnits(feeIdr));
  const receipt = await tx.wait();
  const args = findEvent(receipt, "PrioritySwapRequested");
  return { feeIdr: args ? unitsToIdr(args.fee) : null, txHash: receipt.hash };
}

/** `target` menerima tawaran priority-swap — posisi ketuker, fee masuk reserve grup. */
export async function acceptPrioritySwap(groupId, targetAddress, requesterAddress) {
  const tx = await teko.acceptPrioritySwap(groupId, targetAddress, requesterAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** `target` menolak tawaran priority-swap — fee balik ke Treasury. */
export async function rejectPrioritySwap(groupId, targetAddress) {
  const tx = await teko.rejectPrioritySwap(groupId, targetAddress);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

export async function getPriorityBid(groupId, targetAddress) {
  const bid = await teko.priorityBid(groupId, targetAddress);
  return { requester: bid.requester, feeIdr: unitsToIdr(bid.fee) };
}

export async function getPendingSwap(groupId, targetAddress) {
  return teko.pendingSwap(groupId, targetAddress);
}

/** Antrian undian aktif (kosong kalau grup belum activated). Indeks 0 = giliran berikutnya. */
export async function getQueue(groupId) {
  return teko.queue(groupId);
}

/** Ajukan proposal governance. kind: 0 = Skip, 1 = Kick. */
export async function propose(groupId, kind, subjectAddress, votingWindowSecs = config.chain.defaultVotingWindowSecs) {
  const tx = await teko.propose(groupId, kind, subjectAddress, votingWindowSecs);
  const receipt = await tx.wait();
  const args = findEvent(receipt, "ProposalCreated");
  return { proposalId: args ? Number(args.proposalId) : null, txHash: receipt.hash };
}

/** Rekam 1 suara (voter diverifikasi off-chain lewat identitas Telegram sebelum ini dipanggil). */
export async function vote(groupId, proposalId, voterAddress, approve) {
  const tx = await teko.vote(groupId, proposalId, voterAddress, approve);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** Eksekusi proposal yang sudah capai kuorum. Permissionless di kontrak. */
export async function executeProposal(groupId, proposalId) {
  const tx = await teko.executeProposal(groupId, proposalId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

export async function getProposal(groupId, proposalId) {
  const p = await teko.getProposal(groupId, proposalId);
  return {
    kind: Number(p.kind),
    subject: p.subject,
    deadline: Number(p.deadline),
    yesVotes: Number(p.yesVotes),
    noVotes: Number(p.noVotes),
    requiredYes: Number(p.requiredYes),
    executed: p.executed,
  };
}

/** Apakah grup ini sedang menunggu callback VRF (drawRound sudah diminta, belum di-fulfill). */
export async function hasPendingDraw(groupId) {
  const id = await teko.pendingRequestId(groupId);
  return id !== 0n;
}

/** Tutup paksa grup (darurat, treasury-only). */
export async function forceClose(groupId) {
  const tx = await teko.forceClose(groupId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/** Baca ringkasan status grup dari kontrak. */
export async function getGroup(groupId) {
  const [g, finished] = await Promise.all([teko.groups(groupId), teko.isFinished(groupId)]);
  return {
    contributionIdr: unitsToIdr(g.contribution),
    size: Number(g.size),
    round: Number(g.round),
    paidThisRound: Number(g.paidThisRound),
    winnersCount: Number(g.winnersCount),
    activeCount: Number(g.activeCount),
    remainingToWin: Number(g.remainingToWin),
    rosterLocked: g.rosterLocked,
    activated: g.activated,
    drawMode: Number(g.drawMode),
    cycleDeadline: Number(g.cycleDeadline),
    reserveBalanceIdr: unitsToIdr(g.reserveBalance),
    finished,
  };
}

export async function getMember(groupId, memberAddress) {
  const m = await teko.getMember(groupId, memberAddress);
  return {
    registered: m.registered,
    exited: m.exited,
    delinquent: m.delinquent,
    balanceOwedIdr: unitsToIdr(m.balanceOwed),
    lastPenalizedAt: Number(m.lastPenalizedAt),
  };
}

export async function hasWon(groupId, memberAddress) {
  return teko.hasWon(groupId, memberAddress);
}

/** Skor reputasi member (0-100), lintas semua grup. null kalau kontrak reputasi belum di-set. */
export async function reputationScore(memberAddress) {
  if (!reputationContract) return null;
  return Number(await reputationContract.score(memberAddress));
}

/**
 * Skor + hitungan mentahnya (tepat waktu / telat / gagal bayar). Skornya
 * sendiri tidak banyak arti tanpa angka mentah ini — 0 bisa berarti "belum
 * pernah arisan" atau "selalu nunggak", dua hal yang sangat berbeda.
 * @returns {Promise<null|{score:number, onTime:number, late:number, defaulted:number}>}
 */
export async function reputationOf(memberAddress) {
  if (!reputationContract) return null;
  const [score, rec] = await Promise.all([
    reputationContract.score(memberAddress),
    reputationContract.record(memberAddress),
  ]);
  return {
    score: Number(score),
    onTime: Number(rec.onTime),
    late: Number(rec.late),
    defaulted: Number(rec.defaulted),
  };
}

export { teko, idrx };
