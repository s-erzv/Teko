import express from "express";
import { config } from "./config.js";
import { verifyCallbackToken, isPaid, paidAmount, parsePayoutCallback } from "./xendit.js";
import { onPaymentSettled, onPayoutCallback } from "./service.js";

/** Jalankan HTTP server penerima notifikasi Xendit. */
export function startWebhookServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true, service: "teko" }));

  // Xendit mengirim POST ke sini setelah status invoice berubah (mis. lunas).
  app.post("/xendit/invoice-callback", async (req, res) => {
    const n = req.body || {};
    const token = req.headers["x-callback-token"];

    if (!verifyCallbackToken(token)) {
      console.warn("[webhook] callback token invalid untuk order", n.external_id);
      // 401 (bukan 403) -> samain sama verifyWebhookToken() punya Circa:
      // ini soal kredensial invalid, bukan soal larangan akses.
      return res.status(401).json({ error: "unauthorized" });
    }

    // Balas cepat 200 (Xendit retry kalau lama), proses async.
    res.json({ ok: true });

    if (isPaid(n)) {
      try {
        await onPaymentSettled(n.external_id, paidAmount(n));
      } catch (e) {
        console.error("[webhook] proses settle gagal:", e.message);
      }
    } else {
      console.log(`[webhook] order ${n.external_id} status=${n.status}`);
    }
  });

  // Status akhir pencairan hadiah (Payouts v2). Xendit cuma menjawab
  // "ACCEPTED" saat perintahnya dikirim; berhasil atau ditolaknya baru
  // diketahui lewat callback ini. Tanpa route ini, pencairan yang gagal tidak
  // pernah terlihat dan pemenang terus melihat "sedang diproses".
  app.post("/xendit/payout-callback", async (req, res) => {
    const token = req.headers["x-callback-token"];
    if (!verifyCallbackToken(token)) {
      console.warn("[webhook] callback token payout invalid");
      return res.status(401).json({ error: "unauthorized" });
    }

    res.json({ ok: true });

    const parsed = parsePayoutCallback(req.body || {});
    if (!parsed.referenceId || !parsed.status) {
      console.log("[webhook] callback payout diabaikan (status belum final):", req.body?.event);
      return;
    }
    try {
      await onPayoutCallback(parsed);
    } catch (e) {
      console.error("[webhook] proses callback payout gagal:", e.message);
    }
  });

  // Halaman "finish" setelah bayar (opsional, buat redirect user).
  app.get("/paid/finish", (_req, res) =>
    res.send("Pembayaran diproses. Silakan kembali ke Telegram.")
  );

  const server = app.listen(config.webhook.port, () => {
    console.log(`[webhook] server jalan di :${config.webhook.port}`);
    const base = config.webhook.publicBaseUrl || "https://<ngrok>";
    console.log(`   Set DUA Webhook URL di dashboard Xendit:`);
    console.log(`   · Invoices paid   -> ${base}/xendit/invoice-callback`);
    console.log(`   · Payouts         -> ${base}/xendit/payout-callback`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[webhook] Port ${config.webhook.port} sudah dipakai app lain. ` +
          `Ganti WEBHOOK_PORT di .env.local ke port bebas, lalu restart.`
      );
    } else {
      console.error("[webhook] server error:", err.message);
    }
  });
}
