import { Telegraf } from "telegraf";
import { config, esc } from "./config.js";
import { parseIntent } from "./ai.js";
import { setNotifier, flushPendingDMs } from "./notifier.js";
import { startWebhookServer } from "./webhook.js";
import { storeMode, getGroupByChat, getPayment, getMemberByUsername } from "./store.js";
import * as chain from "./chain.js";
import * as svc from "./service.js";

const bot = new Telegraf(config.telegram.token);

const isAdmin = (ctx) => config.telegram.adminIds.includes(String(ctx.from?.id));

// Prefilter murah supaya Groq tidak dipanggil di tiap baris obrolan grup.
const TRIGGER =
  /\b(arisan|gabung|join|ikut|setor|bayar|undi|acak|status|teko|keluar|utang|denda|prioritas|ganti|setuju|tolak|wallet|usul|skip|kick)\b/i;

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
// Deep-link buat pengganti (replace_member): pengganti buka japri, /start dgn
// payload ini otomatis eksekusi replaceMember on-chain begitu dia konfirmasi.
const deepReplaceLink = (gid, oldUserId) => `https://t.me/${BOT_USERNAME}?start=ganti_${gid}_${oldUserId}`;
const replaceButton = (gid, oldUserId) => ({
  reply_markup: {
    inline_keyboard: [[{ text: "Aku Gantiin (buka japri)", url: deepReplaceLink(gid, oldUserId) }]],
  },
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
  const payload = ctx.startPayload || "";

  // Deep-link dari grup: "?start=ikut_<groupId>" → langsung kirim link setoran privat.
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

  // Deep-link replace_member: "?start=ganti_<groupId>_<oldUserId>" → pengganti
  // konfirmasi identitasnya sendiri (require_auth versi off-chain: dia sendiri
  // yang buka link & tekan Start, bukan diklaimkan orang lain).
  if (payload.startsWith("ganti_")) {
    const [, groupIdStr, oldUserId] = payload.split("_");
    await flushPendingDMs(ctx.from.id);
    const r = await svc.completeReplace({
      groupId: Number(groupIdStr),
      oldUserId,
      newUserId: ctx.from.id,
      newUsername: ctx.from.username,
    });
    return ctx.reply(r.message, { parse_mode: "HTML" });
  }

  await ctx.reply(
    "<b>Teko</b> — bendahara arisan on-chain.\n\n" +
      "Cukup chat natural, contoh:\n" +
      "• <i>buat arisan 5 orang 200rb</i>\n" +
      "• <i>gabung</i> (nggak perlu wallet, tinggal ketik)\n" +
      "• <i>status</i> · <i>undi</i> (admin)\n" +
      "• <i>keluar</i> · <i>bayar utang</i> · <i>mau prioritas 50rb</i> · <i>ganti orang</i>\n" +
      "• <i>usul skip @user</i> / <i>usul keluarkan @user</i> · <i>setuju &lt;id&gt;</i> / <i>tolak &lt;id&gt;</i>\n\n" +
      "Setoran lewat Invoice Xendit, hadiah cair ke rekening/e-wallet (atau wallet BNB kamu sendiri kalau sudah didaftarkan). Uang ditahan smart contract di BNB Chain, pemenang diundi adil tiap ronde.",
    { parse_mode: "HTML" }
  );
  // Kirim resi/klaim yang tertunda selama user belum pernah /start.
  await flushPendingDMs(ctx.from.id);
});
bot.help((ctx) =>
  ctx.reply(
    "Ketik: buat arisan / gabung / status / undi (admin) / keluar / bayar utang / mau prioritas <jumlah> / " +
      "ganti orang / usul skip @user / usul keluarkan @user / setuju <id> / tolak <id> / pakai wallet sendiri 0x..."
  )
);

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

bot.command("denda", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin.");
  reply(ctx, await svc.penalizeLateMembers({ chatId: ctx.chat.id }));
});

bot.command("eksekusi", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin.");
  const idStr = ctx.message.text.split(/\s+/)[1];
  if (!idStr) return ctx.reply("Format: <code>/eksekusi &lt;id_proposal&gt;</code>", { parse_mode: "HTML" });
  const gid = await svc.activeGroupId(ctx.chat.id);
  if (!gid) return ctx.reply("Belum ada arisan aktif.");
  try {
    await chain.executeProposal(gid, Number(idStr));
    return ctx.reply(`Proposal #${idStr} dieksekusi.`);
  } catch (e) {
    return ctx.reply(`Gagal eksekusi (mungkin kuorum belum tercapai): ${esc(e.reason || e.shortMessage || e.message)}`, {
      parse_mode: "HTML",
    });
  }
});

// Fallback demo: simulasi pembayaran manual tanpa nunggu webhook Xendit.
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

      case "exit":
        return reply(ctx, await svc.exitArisan({ chatId: ctx.chat.id, userId: ctx.from.id }));

      case "pay_debt": {
        if (ctx.chat.type !== "private")
          return ctx.reply("Buka japri bot buat proses bayar utang (biar link pembayarannya privat).");
        return reply(ctx, await svc.requestPayDebt({ chatId: ctx.chat.id, userId: ctx.from.id }));
      }

      case "priority": {
        if (ctx.chat.type !== "private")
          return ctx.reply("Buka japri bot buat beli tiket prioritas (biar link pembayarannya privat).");
        return reply(
          ctx,
          await svc.requestPriority({ chatId: ctx.chat.id, userId: ctx.from.id, feeIdr: intent.fee_idr })
        );
      }

      case "replace": {
        const r = await svc.requestReplace({ chatId: ctx.chat.id, oldUserId: ctx.from.id });
        if (!r.ok) return ctx.reply(r.message, { parse_mode: "HTML" });
        return ctx.reply(
          "Minta orang penggantimu tekan tombol di bawah buat ambil alih slot kamu.",
          { parse_mode: "HTML", ...replaceButton(r.groupId, ctx.from.id) }
        );
      }

      case "set_wallet":
        return reply(ctx, await svc.setExternalWallet({ userId: ctx.from.id, address: intent.address }));

      case "propose_skip":
      case "propose_kick": {
        const gid = await svc.activeGroupId(ctx.chat.id);
        if (!gid) return ctx.reply("Belum ada arisan aktif.");
        const target = await getMemberByUsername(gid, intent.target_username);
        if (!target) return ctx.reply(`User @${esc(intent.target_username || "")} tidak ditemukan di arisan ini.`, { parse_mode: "HTML" });
        const kind = intent.action === "propose_kick" ? "kick" : "skip";
        return reply(
          ctx,
          await svc.proposeGovernance({ chatId: ctx.chat.id, kind, targetUserId: target.telegram_user_id })
        );
      }

      case "vote":
        return reply(
          ctx,
          await svc.castVote({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            proposalId: intent.proposal_id,
            approve: Boolean(intent.approve),
          })
        );

      case "complaint":
        return ctx.reply(`Komplain dicatat: <i>${esc(intent.text || text)}</i>`, { parse_mode: "HTML" });

      case "help":
        return ctx.reply("Ketik: buat arisan / gabung / status / undi (admin) / keluar / bayar utang / mau prioritas <jumlah> / ganti orang.");

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
