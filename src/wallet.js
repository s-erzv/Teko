import { ethers } from "ethers";
import { config } from "./config.js";

/**
 * Custodial wallet: bot menurunkan (derive) satu alamat unik per Telegram user
 * dari 1 master seed. User tidak perlu punya/menyebut wallet sama sekali.
 * Alamat ini dipakai kontrak untuk memilih pemenang on-chain secara adil; hadiah
 * IDRX masuk ke sini, lalu di-off-ramp ke fiat oleh treasury.
 */
const BASE_PATH = "m/44'/60'/0'/0/";

// Telegram user ID -> index turunan (0..2^31-1)
function indexFor(telegramUserId) {
  const digits = String(telegramUserId).replace(/\D/g, "") || "0";
  return Number(BigInt(digits) % 2_000_000_000n);
}

/** Alamat custodial (read-only) untuk seorang user. */
export function custodialAddress(telegramUserId) {
  const w = ethers.HDNodeWallet.fromPhrase(
    config.chain.masterMnemonic,
    "",
    BASE_PATH + indexFor(telegramUserId)
  );
  return w.address;
}

/** Wallet custodial ber-signer (untuk sweep/off-ramp dana pemenang). */
export function custodialWallet(telegramUserId, provider) {
  const w = ethers.HDNodeWallet.fromPhrase(
    config.chain.masterMnemonic,
    "",
    BASE_PATH + indexFor(telegramUserId)
  );
  return provider ? w.connect(provider) : w;
}
