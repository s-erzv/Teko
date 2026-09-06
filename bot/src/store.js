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
  members: [], // {group_id, telegram_user_id, username, wallet_address}
  payments: new Map(), // order_id -> {order_id, group_id, round, telegram_user_id, amount_idr, fee_idr, status, payment_url, tx_hash}
  wallets: new Map(), // telegram_user_id -> {telegram_user_id, address, encrypted_key (json), external_address}
};

// ── Groups ────────────────────────────────────────────────────
export async function saveGroup({ groupId, chatId, size, contributionIdr }) {
  const row = {
    group_id: groupId,
    chat_id: String(chatId),
    size,
    contribution_idr: contributionIdr,
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

export async function getMembers(groupId) {
  if (sb) {
    const { data, error } = await sb.from("members").select("*").eq("group_id", groupId);
    check(error, "getMembers");
    return data || [];
  }
  return mem.members.filter((m) => m.group_id === groupId);
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
      .ilike("username", uname)
      .limit(1);
    check(error, "getMemberByUsername");
    return data?.[0] || null;
  }
  return (
    mem.members.find((m) => m.group_id === groupId && (m.username || "").toLowerCase() === uname) || null
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
    mem.payoutDestinations = mem.payoutDestinations || new Map();
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
  mem.payoutDestinations = mem.payoutDestinations || new Map();
  return mem.payoutDestinations.get(String(telegramUserId)) || null;
}

// ── Pending payout (state percakapan singkat; selalu in-memory) ─
const pendingPayouts = new Map(); // telegram_user_id -> {groupId, round, prizeIdr}

export function setPendingPayout(telegramUserId, data) {
  pendingPayouts.set(String(telegramUserId), data);
}
export function getPendingPayout(telegramUserId) {
  return pendingPayouts.get(String(telegramUserId)) || null;
}
export function clearPendingPayout(telegramUserId) {
  pendingPayouts.delete(String(telegramUserId));
}

// ── Alur tanya-jawab "buat arisan" (state percakapan singkat; in-memory) ─
// Kunci per CHAT (bukan per user) — arisan dibikin buat 1 grup, siapa pun
// admin di grup itu boleh lanjutin/jawab pertanyaannya.
const pendingCreations = new Map(); // chat_id -> {step, size, contributionIdr, cycleDays, drawMode}

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
const pendingDMs = new Map(); // telegram_user_id -> [text, ...]

export function addPendingDM(telegramUserId, text) {
  const k = String(telegramUserId);
  if (!pendingDMs.has(k)) pendingDMs.set(k, []);
  pendingDMs.get(k).push(text);
}
export function takePendingDMs(telegramUserId) {
  const k = String(telegramUserId);
  const arr = pendingDMs.get(k) || [];
  pendingDMs.delete(k);
  return arr;
}
