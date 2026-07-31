// Cek koneksi ke BSC Testnet + status kontrak & Treasury. Tidak launch bot.
import { ethers } from "ethers";
import { config, rupiah, unitsToIdr } from "../config.js";
import * as chain from "../chain.js";

async function main() {
  console.log("⛓️  Cek koneksi BSC Testnet...\n");

  const net = await chain.provider.getNetwork();
  console.log(`Network chainId : ${net.chainId}`);
  console.log(`Treasury        : ${chain.treasuryAddress}`);

  const bnb = await chain.provider.getBalance(chain.treasuryAddress);
  console.log(`Saldo tBNB (gas): ${ethers.formatEther(bnb)} BNB`);

  const idrxBal = await chain.idrx.balanceOf(chain.treasuryAddress);
  console.log(`Saldo IDRX      : ${rupiah(unitsToIdr(idrxBal))}`);

  const allowance = await chain.idrx.allowance(chain.treasuryAddress, config.chain.contract);
  console.log(`Allowance->SC   : ${allowance >= ethers.MaxUint256 / 2n ? "MAX ✅" : allowance}`);

  const count = await chain.teko.groupCount();
  console.log(`Total grup      : ${count}`);

  if (bnb === 0n) console.log("\n⚠️  tBNB 0 — isi faucet dulu biar bisa kirim transaksi.");
  console.log("\n✅ Chain wiring OK.");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Gagal:", e.message);
  process.exit(1);
});
