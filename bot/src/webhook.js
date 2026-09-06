import express from "express";
import { config } from "./config.js";
import { verifyCallbackToken, isPaid, paidAmount } from "./xendit.js";
import { onPaymentSettled } from "./service.js";

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

  // Halaman "finish" setelah bayar (opsional, buat redirect user).
  app.get("/paid/finish", (_req, res) =>
    res.send("Pembayaran diproses. Silakan kembali ke Telegram.")
  );

  const server = app.listen(config.webhook.port, () => {
    console.log(`[webhook] server jalan di :${config.webhook.port}`);
    console.log(`   Set Webhook URL di dashboard Xendit (Invoices > Callbacks) ke:`);
    console.log(
      `   ${config.webhook.publicBaseUrl || "https://<ngrok>"}/xendit/invoice-callback`
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
