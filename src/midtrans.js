import crypto from "node:crypto";
import { config } from "./config.js";

const authHeader =
  "Basic " + Buffer.from(config.midtrans.serverKey + ":").toString("base64");

/**
 * Buat Payment Link Midtrans (FIXED_AMOUNT) yang bisa dibagikan ke warga.
 * @param {object} p
 * @param {string} p.orderId   unik per pembayaran (mis. teko-<groupId>-r<round>-<userId>)
 * @param {number} p.grossIdr  total tagihan Rupiah (setoran + convenience fee)
 * @param {string} [p.name]    nama untuk item detail
 * @returns {Promise<{orderId:string, paymentUrl:string}>}
 */
export async function createPaymentLink({ orderId, grossIdr, name = "Setoran Arisan", customer }) {
  const body = {
    transaction_details: {
      order_id: orderId,
      gross_amount: Math.round(grossIdr),
    },
    payment_link_type: "FIXED_AMOUNT",
    usage_limit: 1,
    item_details: [
      {
        id: "setoran",
        name,
        price: Math.round(grossIdr),
        quantity: 1,
      },
    ],
  };
  // Prefill data pembeli dari Telegram (nama + email turunan). HP tak tersedia
  // dari Telegram, jadi tidak dipaksa.
  if (customer) {
    body.customer_details = {
      first_name: customer.firstName || "Anggota",
      ...(customer.lastName ? { last_name: customer.lastName } : {}),
      ...(customer.email ? { email: customer.email } : {}),
    };
    body.customer_required = false;
  }
  if (config.webhook.publicBaseUrl) {
    body.callbacks = { finish: `${config.webhook.publicBaseUrl}/paid/finish` };
  }

  const res = await fetch(config.midtrans.apiUrl, {
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
    throw new Error(
      `Midtrans ${res.status}: ${data.error_messages?.join(", ") || JSON.stringify(data)}`
    );
  }
  return { orderId: data.order_id, paymentUrl: data.payment_url };
}

/**
 * Verifikasi signature notifikasi Midtrans.
 * signature_key = SHA512(order_id + status_code + gross_amount + serverKey)
 */
export function verifySignature(n) {
  const raw =
    String(n.order_id) +
    String(n.status_code) +
    String(n.gross_amount) +
    config.midtrans.serverKey;
  const expected = crypto.createHash("sha512").update(raw).digest("hex");
  return expected === n.signature_key;
}

/** Apakah notifikasi menandakan pembayaran berhasil (lunas). */
export function isPaid(n) {
  const ok = n.transaction_status === "settlement" || n.transaction_status === "capture";
  const fraudOk = !n.fraud_status || n.fraud_status === "accept";
  return ok && fraudOk;
}
