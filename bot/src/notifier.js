// Jembatan agar modul non-bot (webhook, cron) bisa kirim pesan ke Telegram.
import { config } from "./config.js";
import * as store from "./store.js";

let telegram = null;

export function setNotifier(t) {
  telegram = t;
}

/** Kirim ke chat (grup atau user yang sudah pernah chat bot). Pakai parse_mode HTML. */
export async function notify(chatId, text, extra = {}) {
  if (!telegram) return;
  try {
    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (e) {
    console.error("[notify] gagal:", e.message);
  }
}

/**
 * Kirim DM ke user; kalau gagal (mis. user belum /start bot), pesan diantre
 * di DB dan dikirim otomatis begitu user /start (lihat flushPendingDMs).
 */
export async function notifyUser(userId, text) {
  if (!telegram) return;
  try {
    await telegram.sendMessage(userId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await store.addPendingDM(userId, text);
    console.log(`[notify] DM diantre untuk ${userId} (user belum /start bot)`);
  }
}

/**
 * Lapor ke semua admin (ADMIN_USER_IDS) kalau ada yang butuh tangan manusia —
 * setoran yang gagal dikreditkan, pencairan yang ditolak Xendit, saldo
 * Treasury menipis. Tanpa ini kegagalan cuma mendarat di console.error, yang
 * praktisnya artinya tidak ada yang tahu.
 */
export async function notifyAdmins(text) {
  if (!telegram) return;
  const ids = config.telegram.adminIds;
  if (!ids.length) {
    console.warn("[notify] ADMIN_USER_IDS kosong — peringatan ini tidak terkirim ke siapa pun:", text);
    return;
  }
  for (const id of ids) {
    try {
      await telegram.sendMessage(id, `🚨 <b>Perlu perhatian admin</b>\n\n${text}`, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.error(`[notify] gagal lapor ke admin ${id}:`, e.message);
    }
  }
}

/** Kirim semua DM yang tertunda untuk user (dipanggil saat user /start / chat japri). */
export async function flushPendingDMs(userId) {
  if (!telegram) return;
  let msgs;
  try {
    msgs = await store.takePendingDMs(userId);
  } catch (e) {
    console.error("[notify] gagal baca antrean DM:", e.message);
    return;
  }
  for (let i = 0; i < msgs.length; i++) {
    try {
      await telegram.sendMessage(userId, msgs[i], { parse_mode: "HTML" });
    } catch {
      // Masih gagal → kembalikan SISA antrean (termasuk yang barusan gagal)
      // dengan urutan utuh, jangan cuma satu pesan itu.
      for (const rest of msgs.slice(i)) await store.addPendingDM(userId, rest);
      break;
    }
  }
}
