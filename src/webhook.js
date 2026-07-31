import express from "express";
import { config } from "./config.js";
import { verifySignature, isPaid } from "./midtrans.js";
import { onPaymentSettled } from "./service.js";

/** Jalankan HTTP server penerima notifikasi Midtrans. */
export function startWebhookServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true, service: "teko" }));

  // Midtrans mengirim POST ke sini setelah user membayar.
  app.post("/midtrans/notification", async (req, res) => {
    const n = req.body || {};

    if (!verifySignature(n)) {
      console.warn("[webhook] signature invalid untuk order", n.order_id);
      return res.status(403).json({ error: "invalid signature" });
    }

    // Balas cepat 200 (Midtrans retry kalau lama), proses async.
    res.json({ ok: true });

    if (isPaid(n)) {
      try {
        await onPaymentSettled(n.order_id);
      } catch (e) {
        console.error("[webhook] proses settle gagal:", e.message);
      }
    } else {
      console.log(`[webhook] order ${n.order_id} status=${n.transaction_status}`);
    }
  });

  // Halaman "finish" setelah bayar (opsional, buat redirect user).
  app.get("/paid/finish", (_req, res) =>
    res.send("Pembayaran diproses. Silakan kembali ke Telegram.")
  );

  const server = app.listen(config.webhook.port, () => {
    console.log(`[webhook] server jalan di :${config.webhook.port}`);
    console.log(`   Set Payment Notification URL di dashboard Midtrans ke:`);
    console.log(
      `   ${config.webhook.publicBaseUrl || "https://<ngrok>"}/midtrans/notification`
    );
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
