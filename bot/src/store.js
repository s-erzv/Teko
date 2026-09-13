import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

/**
 * Store identitas & metadata off-chain.
 * - Pakai Supabase kalau SUPABASE_URL + SUPABASE_SERVICE_KEY diisi.
 * - Kalau tidak, fallback ke in-memory (cukup untuk demo/hackathon, hilang saat restart).
 *
 * Skema tabel ada di supabase/schema.sql.
 */
const useSupabase = Boolean(config.supabase.url && config.supabase.serviceKey);
const sb = useSupabase
  ? createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    })
  : null;

export const storeMode = useSupabase ? "supabase" : "in-memory";

/**
 * supabase-js TIDAK melempar exception buat error query (mis. tabel belum
 * dibuat) — dia balikin {data, error} dan diam-diam lanjut kalau errornya
 * gak dicek. Ini pernah bikin createArisan() KELIHATAN sukses (on-chain
 * beneran jalan) padahal baris `groups`-nya gak pernah kesimpen, dan baru
 * ketauan belakangan pas join gagal nyari grup yang "gak ada". Helper ini
 * mastiin error Supabase selalu jadi exception yang jelas, bukan senyap.
 */
function check(error, context) {
  if (error) throw new Error(`[store:${context}] ${error.message}`);
}

// ── Fallback in-memory ────────────────────────────────────────
const mem = {
  groups: new Map(), // groupId -> {group_id, chat_id, size, contribution_idr, status}
  members: [], // {group_id, telegram_user_id, username, wallet_address, exited}
  payments: new Map(), // order_id -> {order_id, group_id, round, telegram_user_id, amount_idr, fee_idr, status, payment_url, tx_hash}
  wallets: new Map(), // telegram_user_id -> {telegram_user_id, address, encrypted_key (json), external_address}
  payoutDestinations: new Map(), // telegram_user_id -> {channel_code, account_number, account_holder_name}
  pendingPayouts: new Map(), // telegram_user_id -> {group_id, round, prize_idr}
  payouts: new Map(), // reference_id -> baris buku besar pencairan
  pendingDms: [], // {id, telegram_user_id, body}
  processedEvents: new Set(), // event_key
  cursors: new Map(), // id -> last_block
  seq: 0,
};

// ── Groups ────────────────────────────────────────────────────
export async function saveGroup({ groupId, chatId, size, contributionIdr, adminUserId }) {
  const row = {
    group_id: groupId,
    chat_id: String(chatId),
    size,
    contribution_idr: contributionIdr,
    // Siapa yang ngetik "buat arisan" ini -- bukan pengganti ADMIN_USER_IDS
    // (admin platform tetap bisa di semua grup), tapi bikin pembuatnya bisa
    // ngurus /denda /draw /tutup_paksa /eksekusi buat arisan SENDIRI tanpa
    // perlu didaftarin manual ke env. undefined kalau dogfood/skrip lama
    // yang belum mengirim ini -- grup itu jatuhnya ke admin-platform-only,
    // sama seperti perilaku sebelum kolom ini ada.
    admin_user_id: adminUserId != null ? String(adminUserId) : null,
    status: "collecting",
  };
  if (sb) {
    const { error } = await sb.from("groups").upsert(row, { onConflict: "group_id" });
    check(error, "saveGroup");
  } else {
    mem.groups.set(groupId, row);
  }
  return row;
}

export async function getGroupByChat(chatId) {
  if (sb) {
    const { data, error } = await sb
      .from("groups")
      .select("*")
      .eq("chat_id", String(chatId))
      .in("status", ["collecting"])
      .order("group_id", { ascending: false })
      .limit(1);
    check(error, "getGroupByChat");
    return data?.[0] || null;
  }
  for (const g of [...mem.groups.values()].reverse()) {
    if (g.chat_id === String(chatId) && g.status === "collecting") return g;
  }
  return null;
}

/**
 * Cari grup aktif TERBARU tempat `telegramUserId` jadi anggota — dipakai buat
 * aksi yang dijalankan dari DM (mis. bayar utang, priority-swap) di mana
 * `ctx.chat.id` adalah chat DM itu sendiri, BUKAN chat grup arisannya, jadi
 * `getGroupByChat` gak akan pernah ketemu. Kalau user ikut lebih dari 1
 * arisan aktif, yang paling baru (group_id terbesar) yang dipakai.
 */
export async function getActiveGroupForMember(telegramUserId) {
  if (sb) {
    const { data: memberRows, error: mErr } = await sb
      .from("members")
      .select("group_id")
      .eq("telegram_user_id", String(telegramUserId));
    check(mErr, "getActiveGroupForMember:members");
    const groupIds = (memberRows || []).map((r) => r.group_id);
    if (!groupIds.length) return null;

    const { data, error } = await sb
      .from("groups")
      .select("*")
      .in("group_id", groupIds)
      .eq("status", "collecting")
      .order("group_id", { ascending: false })
      .limit(1);
    check(error, "getActiveGroupForMember:groups");
    return data?.[0] || null;
  }
  const myGroupIds = new Set(
    mem.members.filter((m) => m.telegram_user_id === String(telegramUserId)).map((m) => m.group_id)
  );
  for (const g of [...mem.groups.values()].reverse()) {
    if (g.status === "collecting" && myGroupIds.has(g.group_id)) return g;
  }
  return null;
}

/** Semua grup yang masih berjalan (buat cron sweep deadline) -- bukan grup tunggal. */
export async function getActiveGroups() {
  if (sb) {
    const { data, error } = await sb.from("groups").select("*").eq("status", "collecting");
    check(error, "getActiveGroups");
    return data || [];
  }
  return [...mem.groups.values()].filter((g) => g.status === "collecting");
}

export async function getGroupById(groupId) {
  if (sb) {
    const { data, error } = await sb.from("groups").select("*").eq("group_id", groupId).limit(1);
    check(error, "getGroupById");
    return data?.[0] || null;
  }
  return mem.groups.get(groupId) || null;
}

export async function setGroupStatus(groupId, status) {
  if (sb) {
    const { error } = await sb.from("groups").update({ status }).eq("group_id", groupId);
    check(error, "setGroupStatus");
  } else if (mem.groups.has(groupId)) {
    mem.groups.get(groupId).status = status;
  }
}

// ── Members ───────────────────────────────────────────────────
export async function addMember({ groupId, telegramUserId, username, walletAddress }) {
  const row = {
    group_id: groupId,
    telegram_user_id: String(telegramUserId),
    username: username || null,
    wallet_address: walletAddress,
    exited: false,
    exited_at: null,
  };
  if (sb) {
    const { error } = await sb.from("members").upsert(row, { onConflict: "group_id,telegram_user_id" });
    check(error, "addMember");
  } else {
    const i = mem.members.findIndex(
      (m) => m.group_id === groupId && m.telegram_user_id === String(telegramUserId)
    );
    if (i >= 0) mem.members[i] = row;
    else mem.members.push(row);
  }
  return row;
}

/**
 * Anggota grup. Default HANYA yang masih aktif — anggota yang keluar atau
 * diganti barisnya sengaja disimpan (riwayat pembayarannya masih dipakai buat
 * rekonsiliasi) tapi tidak boleh muncul lagi di roster `/status` maupun kena
 * sapuan denda. Pakai `includeExited` cuma buat lookup historis, mis.
 * mencocokkan address pemenang ke identitas Telegram.
 */
export async function getMembers(groupId, { includeExited = false } = {}) {
  if (sb) {
    let q = sb.from("members").select("*").eq("group_id", groupId);
    if (!includeExited) q = q.eq("exited", false);
    const { data, error } = await q;
    check(error, "getMembers");
    return data || [];
  }
  return mem.members.filter(
    (m) => m.group_id === groupId && (includeExited || !m.exited)
  );
}

/**
 * Tandai anggota sudah keluar / digantikan. Dipanggil SETELAH transaksi
 * on-chain-nya sukses (exit / replaceMember), jadi baris DB tidak pernah
 * bilang "keluar" untuk slot yang di kontrak masih aktif.
 */
export async function markMemberExited(groupId, telegramUserId) {
  if (sb) {
    const { error } = await sb
      .from("members")
      .update({ exited: true, exited_at: new Date().toISOString() })
      .eq("group_id", groupId)
      .eq("telegram_user_id", String(telegramUserId));
    check(error, "markMemberExited");
    return;
  }
  const m = mem.members.find(
    (x) => x.group_id === groupId && x.telegram_user_id === String(telegramUserId)
  );
  if (m) {
    m.exited = true;
    m.exited_at = new Date().toISOString();
  }
}

/** Cari member lewat @username Telegram (case-insensitive) — dipakai buat
 *  proposal governance (usul skip/keluarkan @username). Username Telegram
 *  praktisnya unik, jadi kecocokan pertama di grup itu diambil. */
export async function getMemberByUsername(groupId, username) {
  const uname = String(username || "").replace(/^@/, "").toLowerCase();
  if (!uname) return null;
  if (sb) {
    const { data, error } = await sb
      .from("members")
      .select("*")
      .eq("group_id", groupId)
      .eq("exited", false)
      .ilike("username", uname)
      .limit(1);
    check(error, "getMemberByUsername");
    return data?.[0] || null;
  }
  return (
    mem.members.find(
      (m) => m.group_id === groupId && !m.exited && (m.username || "").toLowerCase() === uname
    ) || null
  );
}

export async function getMember(groupId, telegramUserId) {
  if (sb) {
    const { data, error } = await sb
      .from("members")
      .select("*")
      .eq("group_id", groupId)
      .eq("telegram_user_id", String(telegramUserId))
      .limit(1);
    check(error, "getMember");
    return data?.[0] || null;
  }
  return (
    mem.members.find(
      (m) => m.group_id === groupId && m.telegram_user_id === String(telegramUserId)
    ) || null
  );
}

// ── Payments ──────────────────────────────────────────────────
export async function savePayment(p) {
  const row = { ...p, status: p.status || "pending" };
  if (sb) {
    const { error } = await sb.from("payments").upsert(row, { onConflict: "order_id" });
    check(error, "savePayment");
  } else {
    mem.payments.set(row.order_id, row);
  }
  return row;
}

export async function getPayment(orderId) {
  if (sb) {
    const { data, error } = await sb
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .limit(1);
    check(error, "getPayment");
    return data?.[0] || null;
  }
  return mem.payments.get(orderId) || null;
}

export async function updatePayment(orderId, patch) {
  if (sb) {
    const { error } = await sb.from("payments").update(patch).eq("order_id", orderId);
    check(error, "updatePayment");
  } else if (mem.payments.has(orderId)) {
    Object.assign(mem.payments.get(orderId), patch);
  }
}

/**
 * Klaim 1 baris payment yang masih 'pending' -> 'settled', atomik. Dipakai
 * biar webhook Xendit yang retry (network blip, dsb) tidak memproses
 * kredit on-chain dua kali — sama seperti pola compare-and-swap yang dipakai
 * webhook Xendit-nya Circa (update ... where status = 'pending').
 * @returns {Promise<object|null>} baris yang berhasil diklaim, atau null
 *          kalau sudah diklaim request lain / tidak ditemukan.
 */
export async function claimPaymentPending(orderId) {
  if (sb) {
    const { data, error } = await sb
      .from("payments")
      .update({ status: "settled" })
      .eq("order_id", orderId)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    check(error, "claimPaymentPending");
    return data || null;
  }
  const row = mem.payments.get(orderId);
  if (!row || row.status !== "pending") return null;
  row.status = "settled";
  return row;
}

/** Set telegram_user_id yang pembayarannya sudah settled di ronde tertentu. */
export async function getPaidUserIds(groupId, round) {
  if (sb) {
    const { data, error } = await sb
      .from("payments")
      .select("telegram_user_id")
      .eq("group_id", groupId)
      .eq("round", round)
      .eq("status", "settled");
    check(error, "getPaidUserIds");
    return new Set((data || []).map((p) => String(p.telegram_user_id)));
  }
  const s = new Set();
  for (const p of mem.payments.values()) {
    if (p.group_id === groupId && p.round === round && p.status === "settled")
      s.add(String(p.telegram_user_id));
  }
  return s;
}

// ── Wallets custodial (private key terenkripsi KMS, 1 baris per user) ──
export async function saveWallet({ telegramUserId, address, encryptedKey }) {
  const row = {
    telegram_user_id: String(telegramUserId),
    address,
    encrypted_key: encryptedKey, // {encryptedDataKey, iv, ciphertext, authTag} — semua base64
    external_address: null,
  };
  if (sb) {
    const { error } = await sb.from("wallets").upsert(row, { onConflict: "telegram_user_id" });
    check(error, "saveWallet");
  } else {
    mem.wallets.set(row.telegram_user_id, row);
  }
  return row;
}

export async function getWallet(telegramUserId) {
  if (sb) {
    const { data, error } = await sb
      .from("wallets")
      .select("*")
      .eq("telegram_user_id", String(telegramUserId))
      .limit(1);
    check(error, "getWallet");
    return data?.[0] || null;
  }
  return mem.wallets.get(String(telegramUserId)) || null;
}

/** Opsional: member daftarin address wallet-nya sendiri (self-custody) —
 *  kalau diisi, hadiah diteruskan ke sini alih-alih di-cashout via Xendit. */
export async function setExternalAddress(telegramUserId, address) {
  if (sb) {
    const { error } = await sb
      .from("wallets")
      .update({ external_address: address })
      .eq("telegram_user_id", String(telegramUserId));
    check(error, "setExternalAddress");
  } else {
    const w = mem.wallets.get(String(telegramUserId));
    if (w) w.external_address = address;
  }
}

// ── Rekening/e-wallet cashout (buat Xendit Payout) ──────────────
export async function setPayoutDestination(telegramUserId, { channel_code, account_number, account_holder_name }) {
  const row = {
    telegram_user_id: String(telegramUserId),
    channel_code,
    account_number,
    account_holder_name,
  };
  if (sb) {
    const { error } = await sb.from("payout_destinations").upsert(row, { onConflict: "telegram_user_id" });
    check(error, "setPayoutDestination");
  } else {
    mem.payoutDestinations.set(row.telegram_user_id, row);
  }
}

export async function getPayoutDestination(telegramUserId) {
  if (sb) {
    const { data, error } = await sb
      .from("payout_destinations")
      .select("*")
      .eq("telegram_user_id", String(telegramUserId))
      .limit(1);
    check(error, "getPayoutDestination");
    return data?.[0] || null;
  }
  return mem.payoutDestinations.get(String(telegramUserId)) || null;
}

// ── Pembayaran yang perlu dicoba ulang ────────────────────────
/**
 * Setoran yang uangnya SUDAH masuk (invoice lunas) tapi kreditnya on-chain
 * gagal — mis. saldo IDRX Treasury habis atau RPC lagi ngambek. Dipakai cron
 * retry di index.js; tanpa ini baris `deposit_failed` cuma jadi catatan mati
 * padahal user sudah bayar beneran.
 */
export async function getRetryablePayments(limit = 25) {
  if (sb) {
    const { data, error } = await sb
      .from("payments")
      .select("*")
      .eq("status", "deposit_failed")
      .order("created_at", { ascending: true })
      .limit(limit);
    check(error, "getRetryablePayments");
    return data || [];
  }
  return [...mem.payments.values()].filter((p) => p.status === "deposit_failed").slice(0, limit);
}

/**
 * Kembalikan baris `deposit_failed` ke 'pending' supaya `onPaymentSettled`
 * bisa mengklaimnya lagi lewat jalur normal (`claimPaymentPending`) — satu
 * pintu klaim, jadi retry tidak pernah bisa balapan sama webhook yang telat.
 */
export async function requeuePayment(orderId) {
  if (sb) {
    const { data, error } = await sb
      .from("payments")
      .update({ status: "pending" })
      .eq("order_id", orderId)
      .eq("status", "deposit_failed")
      .select()
      .maybeSingle();
    check(error, "requeuePayment");
    return data || null;
  }
  const row = mem.payments.get(orderId);
  if (!row || row.status !== "deposit_failed") return null;
  row.status = "pending";
  return row;
}

// ── Kursor blok event on-chain ────────────────────────────────
/** Blok terakhir yang sudah dipindai buat `id` (nama event). null = belum pernah. */
export async function getCursor(id) {
  if (sb) {
    const { data, error } = await sb.from("chain_cursor").select("last_block").eq("id", id).limit(1);
    check(error, "getCursor");
    return data?.[0] ? Number(data[0].last_block) : null;
  }
  return mem.cursors.has(id) ? mem.cursors.get(id) : null;
}

/** Majukan kursor. Sengaja tidak pernah mundur — event lama sudah diproses. */
export async function setCursor(id, lastBlock) {
  const current = await getCursor(id);
  if (current !== null && current >= lastBlock) return;
  if (sb) {
    const { error } = await sb
      .from("chain_cursor")
      .upsert({ id, last_block: lastBlock, updated_at: new Date().toISOString() }, { onConflict: "id" });
    check(error, "setCursor");
    return;
  }
  mem.cursors.set(id, lastBlock);
}

/**
 * Klaim satu event on-chain buat diproses, atomik lewat primary key.
 * Backfill saat boot dan listener live pasti melihat sebagian event yang
 * SAMA — ini yang bikin cuma satu di antaranya yang jalan.
 * @returns {Promise<boolean>} true kalau kita yang berhak memproses.
 */
export async function claimEvent(eventKey, kind) {
  if (sb) {
    const { error } = await sb.from("processed_events").insert({ event_key: eventKey, kind });
    if (error) {
      if (error.code === "23505") return false; // sudah diproses duluan
      check(error, "claimEvent");
    }
    return true;
  }
  if (mem.processedEvents.has(eventKey)) return false;
  mem.processedEvents.add(eventKey);
  return true;
}

/**
 * Lepas lagi klaim sebuah event supaya bisa dicoba ulang.
 *
 * Tanpa ini, event yang gagal diproses SETELAH diklaim akan dilewati selamanya
 * oleh pemindaian berikutnya — persis kegagalan yang paling ingin dihindari
 * (pemenang yang tidak pernah diumumkan).
 */
export async function releaseEvent(eventKey) {
  if (sb) {
    const { error } = await sb.from("processed_events").delete().eq("event_key", eventKey);
    check(error, "releaseEvent");
    return;
  }
  mem.processedEvents.delete(eventKey);
}

// ── Hadiah yang nunggu nomor rekening pemenang ────────────────
// Dipersistensi (dulu Map in-memory): hadiah sudah disapu ke Treasury SEBELUM
// pemenang ditanya rekeningnya, jadi kalau state ini hilang gara-gara restart,
// balasan pemenang didiamkan sementara uangnya sudah pindah.
export async function setPendingPayout(telegramUserId, { groupId, round, prizeIdr }) {
  const row = {
    telegram_user_id: String(telegramUserId),
    group_id: groupId,
    round,
    prize_idr: prizeIdr,
  };
  if (sb) {
    const { error } = await sb.from("pending_payouts").upsert(row, { onConflict: "telegram_user_id" });
    check(error, "setPendingPayout");
  } else {
    mem.pendingPayouts.set(row.telegram_user_id, row);
  }
}

export async function getPendingPayout(telegramUserId) {
  let row;
  if (sb) {
    const { data, error } = await sb
      .from("pending_payouts")
      .select("*")
      .eq("telegram_user_id", String(telegramUserId))
      .limit(1);
    check(error, "getPendingPayout");
    row = data?.[0];
  } else {
    row = mem.pendingPayouts.get(String(telegramUserId));
  }
  if (!row) return null;
  return { groupId: Number(row.group_id), round: Number(row.round), prizeIdr: Number(row.prize_idr) };
}

export async function clearPendingPayout(telegramUserId) {
  if (sb) {
    const { error } = await sb
      .from("pending_payouts")
      .delete()
      .eq("telegram_user_id", String(telegramUserId));
    check(error, "clearPendingPayout");
  } else {
    mem.pendingPayouts.delete(String(telegramUserId));
  }
}

// ── Buku besar pencairan fiat ─────────────────────────────────
/** Catat percobaan payout SEBELUM request dikirim ke Xendit. */
export async function savePayout(row) {
  const full = { ...row, status: row.status || "requested", updated_at: new Date().toISOString() };
  if (sb) {
    const { error } = await sb.from("payouts").upsert(full, { onConflict: "reference_id" });
    check(error, "savePayout");
  } else {
    mem.payouts.set(full.reference_id, full);
  }
  return full;
}

export async function updatePayout(referenceId, patch) {
  const full = { ...patch, updated_at: new Date().toISOString() };
  if (sb) {
    const { error } = await sb.from("payouts").update(full).eq("reference_id", referenceId);
    check(error, "updatePayout");
  } else if (mem.payouts.has(referenceId)) {
    Object.assign(mem.payouts.get(referenceId), full);
  }
}

export async function getPayout(referenceId) {
  if (sb) {
    const { data, error } = await sb
      .from("payouts")
      .select("*")
      .eq("reference_id", referenceId)
      .limit(1);
    check(error, "getPayout");
    return data?.[0] || null;
  }
  return mem.payouts.get(referenceId) || null;
}

/** Pencairan yang belum tuntas (buat command rekonsiliasi admin). */
export async function getUnsettledPayouts(limit = 50) {
  if (sb) {
    const { data, error } = await sb
      .from("payouts")
      .select("*")
      .in("status", ["requested", "accepted", "failed", "error"])
      .order("created_at", { ascending: true })
      .limit(limit);
    check(error, "getUnsettledPayouts");
    return data || [];
  }
  return [...mem.payouts.values()]
    .filter((p) => ["requested", "accepted", "failed", "error"].includes(p.status))
    .slice(0, limit);
}

// ── Alur tanya-jawab "buat arisan" ────────────────────────────
// SENGAJA tetap in-memory: ini state percakapan berumur detik, isinya cuma
// jawaban setengah jadi ("5 orang", "200rb"), tidak ada uang yang bergantung
// padanya. Hilang saat restart = user mengetik ulang permintaannya, bukan
// kehilangan dana. Kunci per CHAT (bukan per user) — arisan dibikin buat 1
// grup, siapa pun admin di grup itu boleh lanjutin/jawab pertanyaannya.
const pendingCreations = new Map(); // chat_id -> {size, contributionIdr, cycleDays, drawMode}

export function setPendingCreation(chatId, data) {
  pendingCreations.set(String(chatId), data);
}
export function getPendingCreation(chatId) {
  return pendingCreations.get(String(chatId)) || null;
}
export function clearPendingCreation(chatId) {
  pendingCreations.delete(String(chatId));
}

// ── Antrean DM (resi/klaim yang gagal terkirim karena user belum /start) ─
// Ikut dipersistensi: isinya resi pembayaran dan pemberitahuan menang, bukan
// basa-basi — kalau hilang saat restart, user tidak pernah tahu uangnya masuk.
export async function addPendingDM(telegramUserId, text) {
  if (sb) {
    const { error } = await sb
      .from("pending_dms")
      .insert({ telegram_user_id: String(telegramUserId), body: text });
    check(error, "addPendingDM");
    return;
  }
  mem.pendingDms.push({ id: ++mem.seq, telegram_user_id: String(telegramUserId), body: text });
}

/**
 * Ambil DM tertunda milik user, urut lama->baru, dan hapus dari antrean.
 * Pengirimannya bisa gagal lagi (user masih belum /start) — pemanggil yang
 * mengembalikan sisanya lewat `addPendingDM`, lihat notifier.flushPendingDMs.
 */
export async function takePendingDMs(telegramUserId) {
  const uid = String(telegramUserId);
  if (sb) {
    const { data, error } = await sb
      .from("pending_dms")
      .select("*")
      .eq("telegram_user_id", uid)
      .order("id", { ascending: true });
    check(error, "takePendingDMs:select");
    const rows = data || [];
    if (!rows.length) return [];
    const { error: delErr } = await sb
      .from("pending_dms")
      .delete()
      .in("id", rows.map((r) => r.id));
    check(delErr, "takePendingDMs:delete");
    return rows.map((r) => r.body);
  }
  const mine = mem.pendingDms.filter((d) => d.telegram_user_id === uid).sort((a, b) => a.id - b.id);
  mem.pendingDms = mem.pendingDms.filter((d) => d.telegram_user_id !== uid);
  return mine.map((d) => d.body);
}
