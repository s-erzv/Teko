// Konfigurasi terpusat — baca & validasi env sekali di boot.
const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "GROQ_API_KEY",
  "TREASURY_PRIVATE_KEY",
  "BSC_TESTNET_RPC",
  "CONTRACT_ADDRESS",
  "IDRX_ADDRESS",
  "MIDTRANS_SERVER_KEY",
  "MIDTRANS_PAYMENT_LINK_API",
  "MASTER_MNEMONIC",
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
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  },
  chain: {
    rpc: process.env.BSC_TESTNET_RPC,
    privateKey: process.env.TREASURY_PRIVATE_KEY,
    contract: process.env.CONTRACT_ADDRESS,
    idrx: process.env.IDRX_ADDRESS,
    drawGasLimit: BigInt(process.env.DRAW_GAS_LIMIT || "300000"),
    // IDRX = 2 desimal (1 IDRX = Rp1). Rp -> unit token: idr * 100.
    idrxDecimals: 2,
    // Master seed untuk derive custodial wallet per user (user tak perlu punya wallet).
    masterMnemonic: process.env.MASTER_MNEMONIC,
  },
  midtrans: {
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    apiUrl: process.env.MIDTRANS_PAYMENT_LINK_API,
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
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
    // URL publik (mis. ngrok) untuk callbacks.finish Midtrans. Opsional.
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
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
