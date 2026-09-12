import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const authHeader = "Basic " + Buffer.from(config.xendit.secretKey + ":").toString("base64");

/**
 * `createInvoice`/`verifyCallbackToken`/`isPaid` di bawah ini dicocokkan ke
 * `web/src/lib/payments/xendit.ts` punya Circa — itu implementasi Xendit yang
 * sudah beneran jalan (bukan tebakan), jadi dipakai sebagai referensi persis:
 * endpoint `/v2/invoices`, Basic Auth (API key sbg username, password kosong),
 * status invoice cuma PENDING/PAID/EXPIRED (bukan "SETTLED" — itu istilah
 * Midtrans), dan verifikasi token pakai perbandingan constant-time.
 *
 * `createPayout` (Payouts API) TIDAK ada padanannya di Circa — Circa gak
 * butuh cash-out fiat sama sekali karena hadiahnya langsung ke passkey
 * wallet member sendiri. Bagian ini masih best-effort dari dokumentasi
 * publik Xendit, belum pernah didogfood ke sandbox — cek ulang di
 * dashboard.xendit.co begitu mau dipakai serius.
 */

/**
 * Buat Invoice Xendit (setoran masuk) — gantiin createPaymentLink() Midtrans.
 * @param {object} p
 * @param {string} p.externalId  unik per pembayaran (mis. teko-g<groupId>-r<round>-u<userId>-<ts>)
 * @param {number} p.grossIdr    total tagihan Rupiah (setoran + convenience fee)
 * @returns {Promise<{orderId:string, paymentUrl:string}>}
 */
export async function createInvoice({ externalId, grossIdr, description = "Setoran Arisan", customer }) {
  const body = {
    external_id: externalId,
    amount: Math.round(grossIdr),
    description,
    currency: "IDR",
    invoice_duration: 86400, // kadaluarsa 24 jam
    ...(customer?.email ? { payer_email: customer.email } : {}),
    ...(config.webhook.publicBaseUrl
      ? {
          success_redirect_url: `${config.webhook.publicBaseUrl}/paid/finish`,
          failure_redirect_url: `${config.webhook.publicBaseUrl}/paid/finish`,
        }
      : {}),
  };

  const res = await fetch("https://api.xendit.co/v2/invoices", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Xendit invoice ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return { orderId: data.external_id, paymentUrl: data.invoice_url };
}

/**
 * Verifikasi callback Xendit lewat header `x-callback-token` — token statis
 * dari dashboard Xendit (Settings > Webhooks). Dibandingkan constant-time
 * (`timingSafeEqual`) biar gak ada celah timing-attack buat nebak token
 * byte demi byte — sama seperti verifyWebhookToken() punya Circa.
 */
export function verifyCallbackToken(headerToken) {
  const expected = config.xendit.callbackToken;
  if (!expected || !headerToken) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(headerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Apakah notifikasi invoice menandakan pembayaran berhasil (lunas). Invoice
 *  API cuma punya 3 status: PENDING/PAID/EXPIRED — beda dari Midtrans yang
 *  punya "settlement". */
export function isPaid(n) {
  return n.status === "PAID";
}

/** Nominal yang beneran dibayar user — `paid_amount` kalau ada (bisa beda
 *  dari `amount` yang ditagih di kasus tertentu), fallback ke `amount`. */
export function paidAmount(n) {
  return n.paid_amount ?? n.amount;
}

// Pemetaan nama bank/e-wallet sehari-hari (yang diketik user) -> channel_code Xendit.
const CHANNEL_CODES = {
  gopay: "ID_GOPAY",
  ovo: "ID_OVO",
  dana: "ID_DANA",
  shopeepay: "ID_SHOPEEPAY",
  linkaja: "ID_LINKAJA",
  bca: "ID_BCA",
  bri: "ID_BRI",
  bni: "ID_BNI",
  mandiri: "ID_MANDIRI",
  permata: "ID_PERMATA",
  cimb: "ID_CIMB",
};

/** Cari channel_code dari nama bank/e-wallet yang diketik bebas oleh user. */
export function resolveChannelCode(rawName) {
  const key = String(rawName || "").trim().toLowerCase().replace(/\s+/g, "");
  return CHANNEL_CODES[key] || null;
}

/**
 * Disbursement: cairkan hadiah ke rekening/e-wallet pemenang (Xendit Payouts v2).
 * @param {object} p
 * @param {string} p.referenceId  unik per pencairan (dipakai jg sbg Idempotency-key)
 */
export async function createPayout({
  referenceId,
  amountIdr,
  channelCode,
  accountNumber,
  accountHolderName,
  description = "Hadiah Arisan Teko",
}) {
  const body = {
    reference_id: referenceId,
    channel_code: channelCode,
    channel_properties: {
      account_number: accountNumber,
      account_holder_name: accountHolderName,
    },
    amount: Math.round(amountIdr),
    currency: "IDR",
    description,
  };

  const res = await fetch("https://api.xendit.co/v2/payouts", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader,
      "Idempotency-key": referenceId,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Xendit payout ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return { payoutId: data.id, status: data.status };
}

/**
 * Baca notifikasi callback Payouts v2. Bentuknya `{event, data:{...}}` dengan
 * event `payout.succeeded` / `payout.failed`; sebagian akun lama mengirim
 * field-nya rata di root, jadi keduanya diterima di sini.
 *
 * Tanpa handler ini, sebuah pencairan yang GAGAL di sisi Xendit tidak pernah
 * terlihat oleh siapa pun: `createPayout` cuma balikin "ACCEPTED", dan itulah
 * status terakhir yang pernah diketahui bot.
 *
 * @returns {{referenceId:string|null, status:"succeeded"|"failed"|null,
 *            failureCode:string|null, xenditId:string|null}}
 */
export function parsePayoutCallback(n) {
  const d = n?.data && typeof n.data === "object" ? n.data : n || {};
  const rawEvent = String(n?.event || "").toLowerCase();
  const rawStatus = String(d.status || "").toUpperCase();

  let status = null;
  if (rawEvent === "payout.succeeded" || rawStatus === "SUCCEEDED") status = "succeeded";
  else if (rawEvent === "payout.failed" || rawStatus === "FAILED") status = "failed";

  return {
    referenceId: d.reference_id || null,
    status,
    failureCode: d.failure_code || d.failure_reason || null,
    xenditId: d.id || null,
  };
}
