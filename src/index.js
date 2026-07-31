import { Telegraf } from "telegraf";
import { config, esc } from "./config.js";
import { parseIntent } from "./ai.js";
import { setNotifier, flushPendingDMs } from "./notifier.js";
import { startWebhookServer } from "./webhook.js";
import { storeMode, getGroupByChat, getPayment } from "./store.js";
import * as chain from "./chain.js";
import * as svc from "./service.js";

const bot = new Telegraf(config.telegram.token);

const isAdmin = (ctx) => config.telegram.adminIds.includes(String(ctx.from?.id));

// Prefilter murah supaya Groq tidak dipanggil di tiap baris obrolan grup.
const TRIGGER = /\b(arisan|gabung|join|ikut|setor|bayar|undi|acak|status|teko)\b/i;

const reply = (ctx, r) =>
  ctx.reply(r.message, {
    parse_mode: "HTML",
    ...(r.paymentUrl
      ? { reply_markup: { inline_keyboard: [[{ text: "Bayar Sekarang", url: r.paymentUrl }]] } }
      : {}),
  });

let BOT_USERNAME = "tekoarisan_bot";
// Deep-link: buka japri bot + auto /start dgn payload → link setoran privat per user.
const deepJoinLink = (gid) => `https://t.me/${BOT_USERNAME}?start=ikut_${gid}`;
const joinButton = (gid) => ({
  reply_markup: { inline_keyboard: [[{ text: "Ikut & Setor (buka japri)", url: deepJoinLink(gid) }]] },
});

// Kirim balasan berisi payment link (hanya dipakai di chat japri).
const sendPayLink = (ctx, r) =>
  ctx.reply(r.message, {
    parse_mode: "HTML",
    ...(r.paymentUrl
      ? { reply_markup: { inline_keyboard: [[{ text: "Bayar Sekarang", url: r.paymentUrl }]] } }
      : {}),
  });

// Di grup: jangan pernah post link; arahkan buka japri (link privat khusus dia).
async function promptJoinPrivate(ctx) {
  const gid = await svc.activeGroupId(ctx.chat.id);
  if (!gid) return ctx.reply("Belum ada arisan aktif. Buat dulu: buat arisan 5 orang 200rb");
  return ctx.reply(
    "Link setoran itu <b>privat khusus kamu</b> (biar nggak kebayar orang lain). Tekan tombol buat buka japri.",
    { parse_mode: "HTML", ...joinButton(gid) }
  );
}

// ── Commands eksplisit (andal, tanpa AI) ──────────────────────
bot.start(async (ctx) => {
  // Deep-link dari grup: "?start=ikut_<groupId>" → langsung kirim link setoran privat.
  const payload = ctx.startPayload || "";
  if (payload.startsWith("ikut_")) {
    const gid = Number(payload.slice(5));
    await flushPendingDMs(ctx.from.id);
    const r = await svc.joinOrPay({
      groupId: gid,
      userId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
    return sendPayLink(ctx, r);
  }

  await ctx.reply(
    "<b>Teko</b> — bendahara arisan on-chain.\n\n" +
      "Cukup chat natural, contoh:\n" +
      "• <i>buat arisan 5 orang 200rb</i>\n" +
      "• <i>gabung</i> (nggak perlu wallet, tinggal ketik)\n" +
      "• <i>status</i> · <i>undi</i> (admin)\n\n" +
      "Setoran lewat Payment Link, hadiah cair ke rekening/e-wallet. Uang ditahan smart contract di BNB Chain, pemenang diundi adil tiap ronde.",
    { parse_mode: "HTML" }
  );
  // Kirim resi/klaim yang tertunda selama user belum pernah /start.
  await flushPendingDMs(ctx.from.id);
});
bot.help((ctx) => ctx.reply("Ketik: buat arisan / gabung / status / undi (admin)."));

bot.command("status", async (ctx) =>
  reply(ctx, await svc.statusArisan({ chatId: ctx.chat.id, isAdmin: isAdmin(ctx) }))
);

// Tombol callback lama (pesan lama) → arahkan ke alur japri privat.
bot.action("ikut", async (ctx) => {
  try {
    await ctx.answerCbQuery("Buka japri buat setor privat.");
    return promptJoinPrivate(ctx);
  } catch (e) {
    console.error("[bot] action ikut error:", e.message);
  }
});

bot.command("draw", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin yang bisa mengundi.");
  await ctx.reply("Mengundi pemenang...");
  reply(ctx, await svc.drawWinner({ chatId: ctx.chat.id }));
});

// Fallback demo: simulasi pembayaran manual tanpa nunggu webhook Midtrans.
// Pakai: /webhook_paid <order_id>
bot.command("webhook_paid", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin.");
  const orderId = ctx.message.text.split(/\s+/)[1];
  if (!orderId) return ctx.reply("Format: <code>/webhook_paid &lt;order_id&gt;</code>", { parse_mode: "HTML" });
  const pay = await getPayment(orderId);
  if (!pay) return ctx.reply("Order tidak ditemukan.");
  await ctx.reply(`Simulasi pembayaran untuk ${orderId}...`);
  await svc.onPaymentSettled(orderId);
});

// ── Natural language via Groq ─────────────────────────────────
bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/")) return; // command sudah ditangani di atas

  // Pemenang kirim nomor rekening → proses pencairan. HANYA di japri (privat)
  // supaya nomor rekening tidak ke-post di grup.
  if (ctx.chat.type === "private") {
    await flushPendingDMs(ctx.from.id); // kirim resi tertunda kalau ada
    const payout = await svc.processPayout(ctx.from.id, text);
    if (payout) return ctx.reply(payout.message, { parse_mode: "HTML" });
  }

  if (!TRIGGER.test(text)) return; // bukan untuk Teko

  let intent;
  try {
    intent = await parseIntent(text);
  } catch {
    return;
  }

  try {
    switch (intent.action) {
      case "create_arisan": {
        const r = await svc.createArisan({
          chatId: ctx.chat.id,
          size: intent.size,
          contributionIdr: intent.contribution_idr,
        });
        return ctx.reply(r.message, {
          parse_mode: "HTML",
          ...(r.ok && r.groupId ? joinButton(r.groupId) : {}),
        });
      }

      case "join":
        if (ctx.chat.type === "private")
          return ctx.reply("Buka arisannya dari grup, lalu tekan tombol Ikut & Setor ya.");
        return promptJoinPrivate(ctx);

      case "status":
        return reply(ctx, await svc.statusArisan({ chatId: ctx.chat.id, isAdmin: isAdmin(ctx) }));

      case "draw":
        if (!isAdmin(ctx)) return ctx.reply("Hanya admin yang bisa mengundi.");
        await ctx.reply("Mengundi pemenang...");
        return reply(ctx, await svc.drawWinner({ chatId: ctx.chat.id }));

      case "complaint":
        return ctx.reply(`Komplain dicatat: <i>${esc(intent.text || text)}</i>`, { parse_mode: "HTML" });

      case "help":
        return ctx.reply("Ketik: buat arisan / gabung / status / undi (admin).");

      default:
        return; // none — diamkan
    }
  } catch (e) {
    console.error("[bot] handler error:", e);
    return ctx.reply("Ada error di sisi server. Coba lagi sebentar.");
  }
});

// Global error handler — cegah satu error handler mematikan seluruh bot.
bot.catch((err, ctx) => {
  console.error(`[bot] error di update ${ctx?.updateType}:`, err?.message || err);
});

// ── Boot ──────────────────────────────────────────────────────
async function main() {
  setNotifier(bot.telegram);

  const me = await bot.telegram.getMe();
  if (me?.username) BOT_USERNAME = me.username;
  console.log(`[bot] @${BOT_USERNAME}`);

  // Sanity check koneksi chain + approval Treasury
  const count = await chain.teko.groupCount();
  console.log(`[chain] OK. Treasury: ${chain.treasuryAddress}. Total grup: ${count}`);
  const approved = await chain.ensureApproval();
  if (approved) console.log("[chain] Treasury approve IDRX ke kontrak.");

  console.log(`[store] mode: ${storeMode}`);

  startWebhookServer();

  // Catatan: bot.launch() di Telegraf v4 baru resolve saat bot STOP, jadi log
  // sukses ditaruh sebelum await (polling sudah aktif begitu launch dipanggil).
  console.log("[bot] Teko online — mendengarkan chat Telegram.");
  await bot.launch();
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

main().catch((e) => {
  console.error("Boot gagal:", e);
  process.exit(1);
});
