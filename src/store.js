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

// ── Fallback in-memory ────────────────────────────────────────
const mem = {
  groups: new Map(), // groupId -> {group_id, chat_id, size, contribution_idr, status}
  members: [], // {group_id, telegram_user_id, username, wallet_address}
  payments: new Map(), // order_id -> {order_id, group_id, round, telegram_user_id, amount_idr, fee_idr, status, payment_url, tx_hash}
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
    await sb.from("groups").upsert(row, { onConflict: "group_id" });
  } else {
    mem.groups.set(groupId, row);
  }
  return row;
}

export async function getGroupByChat(chatId) {
  if (sb) {
    const { data } = await sb
      .from("groups")
      .select("*")
      .eq("chat_id", String(chatId))
      .in("status", ["collecting"])
      .order("group_id", { ascending: false })
      .limit(1);
    return data?.[0] || null;
  }
  for (const g of [...mem.groups.values()].reverse()) {
    if (g.chat_id === String(chatId) && g.status === "collecting") return g;
  }
  return null;
}

export async function getGroupById(groupId) {
  if (sb) {
    const { data } = await sb.from("groups").select("*").eq("group_id", groupId).limit(1);
    return data?.[0] || null;
  }
  return mem.groups.get(groupId) || null;
}

export async function setGroupStatus(groupId, status) {
  if (sb) await sb.from("groups").update({ status }).eq("group_id", groupId);
  else if (mem.groups.has(groupId)) mem.groups.get(groupId).status = status;
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
    await sb.from("members").upsert(row, { onConflict: "group_id,telegram_user_id" });
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
    const { data } = await sb.from("members").select("*").eq("group_id", groupId);
    return data || [];
  }
  return mem.members.filter((m) => m.group_id === groupId);
}

export async function getMember(groupId, telegramUserId) {
  if (sb) {
    const { data } = await sb
      .from("members")
      .select("*")
      .eq("group_id", groupId)
      .eq("telegram_user_id", String(telegramUserId))
      .limit(1);
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
  if (sb) await sb.from("payments").upsert(row, { onConflict: "order_id" });
  else mem.payments.set(row.order_id, row);
  return row;
}

export async function getPayment(orderId) {
  if (sb) {
    const { data } = await sb
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .limit(1);
    return data?.[0] || null;
  }
  return mem.payments.get(orderId) || null;
}

export async function updatePayment(orderId, patch) {
  if (sb) await sb.from("payments").update(patch).eq("order_id", orderId);
  else if (mem.payments.has(orderId))
    Object.assign(mem.payments.get(orderId), patch);
}

/** Set telegram_user_id yang pembayarannya sudah settled di ronde tertentu. */
export async function getPaidUserIds(groupId, round) {
  if (sb) {
    const { data } = await sb
      .from("payments")
      .select("telegram_user_id")
      .eq("group_id", groupId)
      .eq("round", round)
      .eq("status", "settled");
    return new Set((data || []).map((p) => String(p.telegram_user_id)));
  }
  const s = new Set();
  for (const p of mem.payments.values()) {
    if (p.group_id === groupId && p.round === round && p.status === "settled")
      s.add(String(p.telegram_user_id));
  }
  return s;
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
