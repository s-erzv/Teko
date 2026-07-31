import { ethers } from "ethers";
import { config, idrToUnits, unitsToIdr } from "./config.js";
import { TEKO_ABI, IDRX_ABI } from "./abi.js";

const provider = new ethers.JsonRpcProvider(config.chain.rpc);
const treasury = new ethers.Wallet(config.chain.privateKey, provider);

const teko = new ethers.Contract(config.chain.contract, TEKO_ABI, treasury);
const idrx = new ethers.Contract(config.chain.idrx, IDRX_ABI, treasury);

export const treasuryAddress = treasury.address;

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

/** Buat grup arisan on-chain. contributionIdr dalam Rupiah. */
export async function createGroup(size, contributionIdr) {
  const units = idrToUnits(contributionIdr);
  const tx = await teko.createGroup(size, units);
  const receipt = await tx.wait();

  // Ambil groupId dari event GroupCreated
  let groupId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = teko.interface.parseLog(log);
      if (parsed?.name === "GroupCreated") {
        groupId = Number(parsed.args.groupId);
        break;
      }
    } catch {
      /* log dari kontrak lain, abaikan */
    }
  }
  return { groupId, txHash: receipt.hash };
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

  let winner = null;
  let prizeIdr = 0;
  let feeIdr = 0;
  for (const log of receipt.logs) {
    try {
      const parsed = teko.interface.parseLog(log);
      if (parsed?.name === "RoundDrawn") {
        winner = parsed.args.winner;
        prizeIdr = unitsToIdr(parsed.args.prize);
        feeIdr = unitsToIdr(parsed.args.fee);
        break;
      }
    } catch {
      /* abaikan */
    }
  }
  return { winner, prizeIdr, feeIdr, txHash: receipt.hash };
}

/** Baca ringkasan status grup dari kontrak. */
export async function getGroup(groupId) {
  const [g, finished] = await Promise.all([
    teko.groups(groupId),
    teko.isFinished(groupId),
  ]);
  return {
    contributionIdr: unitsToIdr(g.contribution),
    size: Number(g.size),
    round: Number(g.round),
    paidThisRound: Number(g.paidThisRound),
    winnersCount: Number(g.winnersCount),
    rosterLocked: g.rosterLocked,
    finished,
  };
}

export { provider, teko, idrx };
