// Jembatan agar modul non-bot (webhook) bisa kirim pesan ke Telegram.
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
 * dan dikirim otomatis begitu user /start (lihat flushPendingDMs).
 */
export async function notifyUser(userId, text) {
  if (!telegram) return;
  try {
    await telegram.sendMessage(userId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch {
    store.addPendingDM(userId, text);
    console.log(`[notify] DM diantre untuk ${userId} (user belum /start bot)`);
  }
}

/** Kirim semua DM yang tertunda untuk user (dipanggil saat user /start / chat japri). */
export async function flushPendingDMs(userId) {
  if (!telegram) return;
  const msgs = store.takePendingDMs(userId);
  for (const m of msgs) {
    try {
      await telegram.sendMessage(userId, m, { parse_mode: "HTML" });
    } catch {
      store.addPendingDM(userId, m); // masih gagal → kembalikan ke antrean
      break;
    }
  }
}
