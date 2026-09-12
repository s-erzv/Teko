import { Telegraf } from "telegraf";
import { config, esc } from "./config.js";
import { parseIntent } from "./ai.js";
import { setNotifier, flushPendingDMs } from "./notifier.js";
import { startWebhookServer } from "./webhook.js";
import {
  storeMode,
  getGroupByChat,
  getPayment,
  getMemberByUsername,
  setPendingCreation,
  getPendingCreation,
  clearPendingCreation,
} from "./store.js";
import * as chain from "./chain.js";
import * as svc from "./service.js";
import { parseInt10, parseRupiah, parseCycleAnswer, parseDrawModeAnswer } from "./parse.js";

const bot = new Telegraf(config.telegram.token);

const isAdmin = (ctx) => config.telegram.adminIds.includes(String(ctx.from?.id));

// Prefilter murah supaya Groq tidak dipanggil di tiap baris obrolan grup.
const TRIGGER =
  /\b(arisan|gabung|join|ikut|setor|bayar|undi|acak|status|teko|keluar|utang|denda|prioritas|tawaran|tuker|tukeran|ganti|setuju|tolak|terima|wallet|usul|skip|kick|siklus|upfront|reputasi|skor|rapor)\b/i;

const WELCOME_MESSAGE =
  "👋 Halo! Aku <b>Teko</b>, bendahara arisan digital — dana ditahan smart contract BNB Chain, " +
  "pemenang diundi jujur pakai Chainlink VRF, dan kamu gak perlu ribet bikin wallet crypto.\n\n" +
  "<b>Mulai:</b> di grup, ketik <i>buat arisan 5 orang 200rb</i> (admin) atau <i>gabung</i> (member).\n\n" +
  "Command lengkap: /help";

const HELP_MESSAGE =
  "<b>Daftar command Teko</b>\n\n" +
  "🆕 <i>buat arisan 5 orang 200rb tiap minggu upfront</i> — siklus &amp; cara undi opsional (default: 30 hari, diundi ulang tiap ronde)\n" +
  "📋 <i>status</i> — lihat progress arisan\n" +
  "💰 <i>gabung</i> · <i>bayar utang</i>\n" +
  "🔀 <i>tuker posisi sama @user</i> (gratis) · <i>terima tukeran</i>\n" +
  "💸 <i>mau prioritas 50rb ke @user</i> (berbayar, tawar posisi) · <i>terima tawaran</i> · <i>tolak tawaran</i>\n" +
  "🚪 <i>keluar</i> · <i>ganti orang</i> · <i>pakai wallet sendiri 0x...</i>\n" +
  "🗳️ <i>usul skip @user</i> · <i>usul keluarkan @user</i> · <i>setuju &lt;id&gt;</i> · <i>tolak &lt;id&gt;</i>\n" +
  "⭐ <i>reputasi</i> · <i>reputasi @user</i> — skor lintas semua arisan\n" +
  "👑 <i>undi</i> (admin) · /pencairan (admin) · /tutup_paksa (admin, darurat)\n\n" +
  "Ketik /start buat penjelasan lebih lengkap.";

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

// ── Alur tanya-jawab "buat arisan" ─────────────────────────────
// Kalau pesan pertama udah lengkap (size + setoran + siklus + mode undi),
// langsung dibikin — jalur cepat buat yang udah tau mau apa. Kalau ada yang
// belum disebutkan, bot NANYA satu-satu (bukan diam-diam pakai default),
// per keluhan user: default itu OK tapi harus ditawarkan, bukan ditetapkan sepihak.
async function askNextCreationQuestion(ctx, state) {
  if (!state.size) return ctx.reply("Mau berapa orang yang ikutan arisan ini?");
  if (!state.contributionIdr) return ctx.reply("Setoran per orang per ronde berapa? (contoh: 200rb)");
  if (!state.cycleDays) {
    return ctx.reply(
      "Siklusnya berapa hari sekali? Ketik jumlah harinya, atau <i>mingguan</i> / <i>bulanan</i> / <i>default</i> (30 hari).",
      { parse_mode: "HTML" }
    );
  }
  if (!state.drawMode) {
    return ctx.reply(
      "Cara undinya gimana?\n· Ketik <i>biasa</i> — antrian diacak ulang tiap ronde (rekomendasi)\n· Ketik <i>upfront</i> — urutan pemenang ditentukan sekali di awal, ronde berikutnya cair instan",
      { parse_mode: "HTML" }
    );
  }
  clearPendingCreation(ctx.chat.id);
  await ctx.reply("⏳ Bikin arisan di smart contract BNB Chain, tunggu sebentar ya (biasanya beberapa detik)...");
  const r = await svc.createArisan({
    chatId: ctx.chat.id,
    size: state.size,
    contributionIdr: state.contributionIdr,
    cycleDays: state.cycleDays === "default" ? undefined : state.cycleDays,
    drawMode: state.drawMode,
  });
  return ctx.reply(r.message, {
    parse_mode: "HTML",
    ...(r.ok && r.groupId ? joinButton(r.groupId) : {}),
  });
}

function startCreationFlow(ctx, intent) {
  const state = {
    size: intent.size || undefined,
    contributionIdr: intent.contribution_idr || undefined,
    cycleDays: intent.cycle_days || undefined,
    drawMode: intent.draw_mode || undefined,
  };
  setPendingCreation(ctx.chat.id, state);
  return askNextCreationQuestion(ctx, state);
}

/** @returns {Promise<boolean>} true kalau pesan ini ditangani sbg jawaban alur create_arisan. */
async function advanceCreationFlow(ctx, text) {
  const state = getPendingCreation(ctx.chat.id);
  if (!state) return false;

  if (!state.size) {
    const n = parseInt10(text);
    if (!n || n < 2 || n > 50) {
      await ctx.reply("Jumlah anggota harus 2–50 ya, ketik angkanya aja.");
      return true;
    }
    state.size = n;
  } else if (!state.contributionIdr) {
    const n = parseRupiah(text);
    if (!n || n < 1000) {
      await ctx.reply("Setoran minimal Rp1.000, contoh: 200rb");
      return true;
    }
    state.contributionIdr = n;
  } else if (!state.cycleDays) {
    const days = parseCycleAnswer(text);
    if (!days) {
      await ctx.reply("Gak kebaca — ketik jumlah harinya (mis. 7), atau 'mingguan'/'bulanan'/'default'.");
      return true;
    }
    state.cycleDays = days;
  } else if (!state.drawMode) {
    state.drawMode = parseDrawModeAnswer(text);
  }

  setPendingCreation(ctx.chat.id, state);
  await askNextCreationQuestion(ctx, state);
  return true;
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

  await ctx.reply(WELCOME_MESSAGE, { parse_mode: "HTML" });
  // Kirim resi/klaim yang tertunda selama user belum pernah /start.
  await flushPendingDMs(ctx.from.id);
});
bot.help((ctx) => ctx.reply(HELP_MESSAGE, { parse_mode: "HTML" }));

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

bot.command("reputasi", async (ctx) => {
  const target = ctx.message.text.split(/\s+/)[1];
  reply(ctx, await svc.reputationCard({ chatId: ctx.chat.id, userId: ctx.from.id, targetUsername: target }));
});

// Rekonsiliasi: pencairan yang belum tuntas (requested/accepted/failed/error).
bot.command("pencairan", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin.");
  reply(ctx, await svc.unsettledPayouts());
});

// Escape hatch darurat buat grup yang macet. Merusak & tidak bisa dibatalkan,
// jadi butuh konfirmasi eksplisit di teks command — bukan cuma satu kata.
bot.command("tutup_paksa", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin.");
  const gid = await svc.activeGroupId(ctx.chat.id);
  if (!gid) return ctx.reply("Belum ada arisan aktif di grup ini.");
  if (!/\bYA\b/.test(ctx.message.text)) {
    return ctx.reply(
      `⚠️ Ini menutup <b>Arisan #${gid}</b> secara permanen. Sisa pot dan cadangan langsung ` +
        `dibagi rata ke anggota yang belum pernah menang, dan arisannya <b>tidak bisa dilanjutkan lagi</b>.\n\n` +
        `Kalau yakin, ketik: <code>/tutup_paksa YA</code>`,
      { parse_mode: "HTML" }
    );
  }
  await ctx.reply("⏳ Menutup paksa arisan on-chain, tunggu sebentar...");
  reply(ctx, await svc.forceCloseArisan({ chatId: ctx.chat.id }));
});

bot.command("draw", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Hanya admin yang bisa mengundi.");
  reply(ctx, await svc.requestDraw({ chatId: ctx.chat.id }));
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

  // Jawaban buat alur "buat arisan" yang lagi jalan (mis. cuma ketik "5" atau
  // "mingguan") gak bakal kena TRIGGER regex, makanya dicek duluan di sini.
  if (await advanceCreationFlow(ctx, text)) return;

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
        // Semua udah lengkap dari 1 pesan (mis. "arisan 5 orang 200rb tiap
        // minggu upfront") -> langsung bikin, jalur cepat buat yang udah tau
        // mau apa. Kalau ada yang belum disebut, TANYA dulu (lihat
        // startCreationFlow) — jangan diam-diam pakai default.
        if (intent.size && intent.contribution_idr && intent.cycle_days && intent.draw_mode) {
          await ctx.reply("⏳ Bikin arisan di smart contract BNB Chain, tunggu sebentar ya (biasanya beberapa detik)...");
          const r = await svc.createArisan({
            chatId: ctx.chat.id,
            size: intent.size,
            contributionIdr: intent.contribution_idr,
            cycleDays: intent.cycle_days,
            drawMode: intent.draw_mode,
          });
          return ctx.reply(r.message, {
            parse_mode: "HTML",
            ...(r.ok && r.groupId ? joinButton(r.groupId) : {}),
          });
        }
        return startCreationFlow(ctx, intent);
      }

      case "join": {
        // Di japri, langsung kasih link setorannya. Pesan pengumuman pemenang
        // menyuruh anggota ketik "bayar" buat ronde berikutnya, dan dulu itu
        // buntu di sini kalau diketik di japri.
        if (ctx.chat.type === "private") {
          const gid = await svc.activeGroupIdForUser(ctx.chat.id, ctx.from.id);
          if (!gid)
            return ctx.reply("Kamu belum ikut arisan aktif mana pun. Buka grup arisannya dulu ya.");
          return sendPayLink(
            ctx,
            await svc.joinOrPay({
              groupId: gid,
              userId: ctx.from.id,
              username: ctx.from.username,
              firstName: ctx.from.first_name,
              lastName: ctx.from.last_name,
            })
          );
        }
        return promptJoinPrivate(ctx);
      }

      case "status":
        return reply(ctx, await svc.statusArisan({ chatId: ctx.chat.id, isAdmin: isAdmin(ctx) }));

      case "draw":
        if (!isAdmin(ctx)) return ctx.reply("Hanya admin yang bisa mengundi.");
        return reply(ctx, await svc.requestDraw({ chatId: ctx.chat.id }));

      case "exit":
        await ctx.reply("⏳ Memproses keluar dari arisan on-chain, tunggu sebentar...");
        return reply(ctx, await svc.exitArisan({ chatId: ctx.chat.id, userId: ctx.from.id }));

      case "pay_debt": {
        if (ctx.chat.type !== "private")
          return ctx.reply("Buka japri bot buat proses bayar utang (biar link pembayarannya privat).");
        return reply(ctx, await svc.requestPayDebt({ chatId: ctx.chat.id, userId: ctx.from.id }));
      }

      case "priority": {
        if (ctx.chat.type !== "private")
          return ctx.reply("Buka japri bot buat tawar posisi (biar link pembayarannya privat).");
        return reply(
          ctx,
          await svc.requestPriority({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            targetUsername: intent.target_username,
            feeIdr: intent.fee_idr,
          })
        );
      }

      case "respond_priority":
        return reply(
          ctx,
          await svc.respondPrioritySwap({ chatId: ctx.chat.id, userId: ctx.from.id, accept: Boolean(intent.approve) })
        );

      case "free_swap":
        return reply(
          ctx,
          await svc.requestFreeSwap({ chatId: ctx.chat.id, userId: ctx.from.id, targetUsername: intent.target_username })
        );

      case "accept_free_swap":
        return reply(ctx, await svc.acceptFreeSwap({ chatId: ctx.chat.id, userId: ctx.from.id }));

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
        await ctx.reply("⏳ Ajukan proposal on-chain, tunggu sebentar...");
        return reply(
          ctx,
          await svc.proposeGovernance({ chatId: ctx.chat.id, kind, targetUserId: target.telegram_user_id })
        );
      }

      case "vote":
        await ctx.reply("⏳ Catat suara on-chain, tunggu sebentar...");
        return reply(
          ctx,
          await svc.castVote({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            proposalId: intent.proposal_id,
            approve: Boolean(intent.approve),
          })
        );

      case "reputation":
        return reply(
          ctx,
          await svc.reputationCard({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            targetUsername: intent.target_username,
          })
        );

      case "complaint":
        return ctx.reply(`Komplain dicatat: <i>${esc(intent.text || text)}</i>`, { parse_mode: "HTML" });

      case "help":
        return ctx.reply(HELP_MESSAGE, { parse_mode: "HTML" });

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
  if (storeMode !== "supabase") {
    console.warn(
      "[store] ⚠️  in-memory: hadiah yang nunggu rekening, antrean resi, dan kursor event " +
        "hilang tiap restart. Isi SUPABASE_URL + SUPABASE_SERVICE_KEY buat produksi."
    );
  }

  // Susulkan dulu event RoundDrawn yang terjadi selagi proses ini mati, BARU
  // pasang listener live. Urutannya penting: fulfillment VRF adalah transaksi
  // terpisah yang dikirim Chainlink kapan saja, jadi tanpa langkah ini setiap
  // restart berpotensi menelan satu pemenang tanpa jejak.
  //
  // Mode in-memory dilewati: kursor & jejak event-nya toh tidak bertahan, jadi
  // backfill di situ cuma bakal mengumumkan ulang ronde lama tiap kali boot.
  if (storeMode === "supabase") {
    try {
      const n = await svc.backfillRoundDrawn();
      console.log(`[chain] backfill RoundDrawn: ${n} event susulan diproses.`);
    } catch (e) {
      console.error("[chain] backfill RoundDrawn gagal:", e.message);
    }
  } else {
    console.log("[chain] backfill RoundDrawn dilewati (store in-memory).");
  }

  // Pengundi (drawRound) cuma MEMINTA randomness VRF — pemenang beneran
  // diketahui belakangan lewat event RoundDrawn ini, yang bisa muncul kapan
  // saja (transaksi terpisah dari Chainlink), bukan pas admin ngetik /undi.
  chain.onRoundDrawn((payload) => {
    svc.handleRoundDrawn(payload).catch((e) => console.error("[chain] handleRoundDrawn gagal:", e.message));
  });
  console.log("[chain] mendengar event RoundDrawn (VRF fulfillment)...");

  // Saldo Treasury dicek sekali di boot: kalau IDRX/BNB-nya sudah tipis
  // sekarang, setoran yang masuk hari ini bakal gagal dikreditkan.
  try {
    const h = await svc.checkTreasuryHealth();
    console.log(
      `[chain] Treasury IDRX: Rp${Math.round(h.idrxIdr).toLocaleString("id-ID")} ` +
        `(butuh Rp${Math.round(h.requiredIdr).toLocaleString("id-ID")}/ronde penuh)` +
        `${h.idrxLow || h.bnbLow ? " ⚠️ TIPIS" : ""}`
    );
  } catch (e) {
    console.error("[chain] cek saldo Treasury gagal:", e.message);
  }

  startWebhookServer();
  startDeadlineCron();
  startRecoveryCron();

  // Catatan: bot.launch() di Telegraf v4 baru resolve saat bot STOP, jadi log
  // sukses ditaruh sebelum await (polling sudah aktif begitu launch dipanggil).
  console.log("[bot] Teko online — mendengarkan chat Telegram.");
  await bot.launch();
}

/**
 * Cron denda otomatis: jalan di DALAM proses bot yang sama (bukan Supabase
 * Function/infra terpisah) -- bot ini emang udah harus nyala 24/7 buat
 * nge-poll Telegram, jadi setInterval sederhana di sini udah cukup, gak
 * nambah moving part baru. Konsekuensinya: kalau proses bot mati/restart,
 * sweep-nya ikut berhenti sampai proses hidup lagi (sama kayak semua fitur
 * lain di bot ini) -- bukan masalah asal proses dijaga tetap jalan (mis.
 * lewat pm2/systemd), tapi BEDA kalau nanti dipisah ke instance idle-aware
 * (mis. serverless) yang bisa "tidur"; di situ baru Supabase Scheduled
 * Function/pg_cron lebih pas karena jalannya independen dari proses bot.
 */
function startDeadlineCron() {
  const intervalMs = config.cron.deadlineSweepIntervalMs;
  setInterval(() => {
    svc.sweepAllDeadlines().catch((e) => console.error("[cron] sweepAllDeadlines gagal:", e.message));
  }, intervalMs);
  console.log(`[cron] sweep deadline tiap ${Math.round(intervalMs / 60000)} menit.`);
}

/**
 * Cron pemulihan. Tiga hal yang sama-sama soal "sesuatu sudah terjadi tapi
 * belum tercatat", makanya digabung di satu interval yang lebih rapat dari
 * sweep denda:
 *
 *   1. Setoran yang uangnya sudah masuk tapi kreditnya on-chain gagal.
 *   2. Event undian yang terlewat (jaring pengaman kalau listener live-nya
 *      diam-diam mati karena koneksi RPC putus tanpa error).
 *   3. Saldo Treasury menipis — penyebab paling umum dari nomor 1.
 */
function startRecoveryCron() {
  const intervalMs = config.cron.recoveryIntervalMs;
  const tick = async () => {
    try {
      await svc.retryFailedPayments();
    } catch (e) {
      console.error("[cron] retryFailedPayments gagal:", e.message);
    }
    if (storeMode === "supabase") {
      try {
        await svc.backfillRoundDrawn();
      } catch (e) {
        console.error("[cron] backfillRoundDrawn gagal:", e.message);
      }
    }
    try {
      await svc.checkTreasuryHealth();
    } catch (e) {
      console.error("[cron] checkTreasuryHealth gagal:", e.message);
    }
  };
  setInterval(() => void tick(), intervalMs);
  console.log(`[cron] pemulihan (retry + backfill + saldo) tiap ${Math.round(intervalMs / 60000)} menit.`);
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

main().catch((e) => {
  console.error("Boot gagal:", e);
  process.exit(1);
});
