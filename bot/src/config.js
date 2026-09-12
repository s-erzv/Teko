// Konfigurasi terpusat — baca & validasi env sekali di boot.
import { ethers } from "ethers";

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "GROQ_API_KEY",
  "TREASURY_PRIVATE_KEY",
  "BSC_TESTNET_RPC",
  "CONTRACT_ADDRESS",
  "IDRX_ADDRESS",
  "XENDIT_SECRET_KEY",
  "XENDIT_CALLBACK_TOKEN",
  "TEKO_AWS_REGION",
  "TEKO_KMS_KEY_ID",
  "TEKO_AWS_ACCESS_KEY_ID",
  "TEKO_AWS_SECRET_ACCESS_KEY",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Env belum lengkap di .env.local: ${missing.join(", ")}`);
  process.exit(1);
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: (process.env.ADMIN_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  },
  chain: {
    rpc: process.env.BSC_TESTNET_RPC,
    privateKey: process.env.TREASURY_PRIVATE_KEY,
    contract: process.env.CONTRACT_ADDRESS,
    idrx: process.env.IDRX_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS || "",
    // IDRX = 2 desimal (1 IDRX = Rp1). Rp -> unit token: idr * 100.
    idrxDecimals: 2,
    // Parameter default grup arisan (dipakai kalau user tak menyebutkan sendiri).
    defaultCycleLengthSecs: BigInt(process.env.DEFAULT_CYCLE_LENGTH_SECS || String(30 * 24 * 3600)), // 30 hari
    defaultPenaltyPerDayIdr: Number(process.env.DEFAULT_PENALTY_PER_DAY_IDR || "5000"),
    defaultExitPenaltyIdr: Number(process.env.DEFAULT_EXIT_PENALTY_IDR || "20000"),
    defaultPostPayoutExitPenaltyIdr: Number(process.env.DEFAULT_POST_PAYOUT_EXIT_PENALTY_IDR || "50000"),
    defaultReserveBps: Number(process.env.DEFAULT_RESERVE_BPS || "200"), // 2%
    // 0 = PerCycle (antrian diacak ulang tiap ronde), 1 = Upfront (urutan tetap
    // sekali di awal). Lihat contracts/TekoArisan.sol buat penjelasan lengkap.
    defaultDrawMode: Number(process.env.DEFAULT_DRAW_MODE || "0"),
    defaultVotingWindowSecs: BigInt(process.env.DEFAULT_VOTING_WINDOW_SECS || String(3 * 24 * 3600)), // 3 hari
    // BNB gas top-up yang dikirim ke wallet custodial pemenang sebelum sweep —
    // wallet custodial tidak pernah pegang BNB sendiri, jadi butuh disponsori
    // sesaat sebelum bisa menandatangani transfer IDRX balik ke Treasury.
    sweepGasTopupWei: ethers.parseEther(process.env.SWEEP_GAS_TOPUP_BNB || "0.0006"),
  },
  aws: {
    region: process.env.TEKO_AWS_REGION,
    kmsKeyId: process.env.TEKO_KMS_KEY_ID,
    accessKeyId: process.env.TEKO_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.TEKO_AWS_SECRET_ACCESS_KEY,
  },
  xendit: {
    secretKey: process.env.XENDIT_SECRET_KEY,
    callbackToken: process.env.XENDIT_CALLBACK_TOKEN,
    isProduction: process.env.XENDIT_IS_PRODUCTION === "true",
  },
  fee: {
    convenienceIdr: Number(process.env.CONVENIENCE_FEE_IDR || "2500"),
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
  },
  webhook: {
    port: Number(process.env.WEBHOOK_PORT || "3000"),
    // URL publik (mis. ngrok) untuk callback/redirect Xendit. Opsional.
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  },
  cron: {
    // Seberapa sering cek deadline semua grup aktif & denda otomatis yang telat.
    deadlineSweepIntervalMs: Number(process.env.DEADLINE_SWEEP_INTERVAL_MINUTES || "30") * 60_000,
    // Seberapa sering coba ulang pembayaran yang gagal dikreditkan on-chain,
    // susulkan event undian yang terlewat, dan cek saldo Treasury. Lebih
    // rapat dari sweep denda: yang ini menyangkut uang user yang sudah masuk
    // tapi belum tercatat.
    recoveryIntervalMs: Number(process.env.RECOVERY_SWEEP_INTERVAL_MINUTES || "10") * 60_000,
  },
};

/** Escape untuk parse_mode HTML (aman dari username ber-underscore dll). */
export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rupiah -> unit terkecil token IDRX (2 desimal). */
export const idrToUnits = (idr) => BigInt(Math.round(idr * 100));
/** Unit token IDRX -> Rupiah (number). */
export const unitsToIdr = (units) => Number(units) / 100;
/** Format Rupiah untuk pesan Telegram. */
export const rupiah = (idr) =>
  "Rp" + Math.round(idr).toLocaleString("id-ID");
