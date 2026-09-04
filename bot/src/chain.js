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

/** Buat grup arisan on-chain. Semua parameter Rupiah dalam angka biasa. */
export async function createGroup({
  size,
  contributionIdr,
  cycleLengthSecs = config.chain.defaultCycleLengthSecs,
  penaltyPerDayIdr = config.chain.defaultPenaltyPerDayIdr,
  exitPenaltyIdr = config.chain.defaultExitPenaltyIdr,
  postPayoutExitPenaltyIdr = config.chain.defaultPostPayoutExitPenaltyIdr,
  reserveBps = config.chain.defaultReserveBps,
}) {
  const tx = await teko.createGroup(
    size,
    idrToUnits(contributionIdr),
    cycleLengthSecs,
    idrToUnits(penaltyPerDayIdr),
    idrToUnits(exitPenaltyIdr),
    idrToUnits(postPayoutExitPenaltyIdr),
    reserveBps
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
 * Undi pemenang ronde & cairkan. WAJIB pakai gasLimit eksplisit —
 * _random() baca block.prevrandao, jadi estimasi gas != eksekusi (bisa OutOfGas).
 */
export async function drawRound(groupId) {
  const tx = await teko.drawRound(groupId, { gasLimit: config.chain.drawGasLimit });
  const receipt = await tx.wait();

  const args = findEvent(receipt, "RoundDrawn");
  return {
    winner: args?.winner ?? null,
    prizeIdr: args ? unitsToIdr(args.prize) : 0,
    feeIdr: args ? unitsToIdr(args.fee) : 0,
    txHash: receipt.hash,
  };
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

/** Beli tiket ekstra di undian ronde berikutnya (adaptasi priority-swap/piauw). */
export async function requestPriorityDraw(groupId, memberAddress, feeIdr, extraTickets) {
  const tx = await teko.requestPriorityDraw(groupId, memberAddress, idrToUnits(feeIdr), extraTickets);
  const receipt = await tx.wait();
  const args = findEvent(receipt, "PriorityDrawRequested");
  return { newWeight: args ? Number(args.newWeight) : null, txHash: receipt.hash };
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

/** Tutup paksa grup (darurat, owner-only). */
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

export { teko, idrx };
