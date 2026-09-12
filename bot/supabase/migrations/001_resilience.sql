-- ═══════════════════════════════════════════════════════════════
-- Migration 001 — tahan restart & jejak pencairan
-- ───────────────────────────────────────────────────────────────
-- Jalankan di Supabase SQL Editor kalau schema.sql versi awal SUDAH pernah
-- dijalankan. Deploy baru cukup jalanin schema.sql (isinya sudah termasuk
-- semua di bawah ini), lalu rls.sql.
--
-- Semua statement aman diulang (idempotent).
-- ═══════════════════════════════════════════════════════════════

-- 1) Anggota yang keluar / diganti ditandai, bukan dihapus — riwayat
--    pembayarannya masih dipakai buat rekonsiliasi, tapi dia tidak boleh
--    muncul lagi di roster, didenda, atau dianggap slot aktif.
alter table members add column if not exists exited    boolean not null default false;
alter table members add column if not exists exited_at timestamptz;

-- 2) Kursor blok per event on-chain. Bot memindai ulang dari sini saat boot
--    supaya event yang terjadi selagi proses mati (mis. VRF fulfill pas bot
--    restart) tidak hilang selamanya — listener live saja tidak cukup.
create table if not exists chain_cursor (
  id         text primary key,            -- nama event, mis. 'RoundDrawn'
  last_block bigint not null,
  updated_at timestamptz not null default now()
);

-- 3) Jejak event yang sudah diproses. Backfill dan listener live bisa
--    melihat event yang SAMA; primary key di sini yang bikin pemrosesan
--    ganda mustahil (insert kedua langsung konflik).
create table if not exists processed_events (
  event_key    text primary key,          -- '<txHash>:<logIndex>'
  kind         text not null,
  processed_at timestamptz not null default now()
);

-- 4) Hadiah yang nunggu pemenang membalas nomor rekening. Dulu cuma Map di
--    memori: bot restart = balasan pemenang didiamkan padahal IDRX-nya sudah
--    disapu ke Treasury.
create table if not exists pending_payouts (
  telegram_user_id text primary key,
  group_id         bigint not null references groups(group_id) on delete cascade,
  round            smallint not null,
  prize_idr        bigint not null,
  created_at       timestamptz not null default now()
);

-- 5) Buku besar pencairan fiat — satu baris per percobaan payout Xendit,
--    ditulis SEBELUM request dikirim. Tanpa ini, payout yang gagal di sisi
--    Xendit tidak meninggalkan jejak apa pun.
create table if not exists payouts (
  reference_id     text primary key,
  telegram_user_id text not null,
  group_id         bigint not null references groups(group_id) on delete cascade,
  round            smallint not null,
  amount_idr       bigint not null,
  channel_code     text not null,
  account_number   text not null,
  status           text not null default 'requested', -- requested|accepted|succeeded|failed|error
  xendit_id        text,
  failure_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists payouts_status_idx on payouts (status);

-- 6) Antrean DM yang gagal terkirim (user belum pernah /start bot). Isinya
--    resi pembayaran & pemberitahuan menang, jadi tidak boleh hilang saat
--    proses restart.
create table if not exists pending_dms (
  id               bigserial primary key,
  telegram_user_id text not null,
  body             text not null,
  created_at       timestamptz not null default now()
);
create index if not exists pending_dms_user_idx on pending_dms (telegram_user_id, id);

-- 7) RLS buat tabel baru — sama seperti rls.sql: tutup rapat, backend pakai
--    service_role yang selalu bypass.
alter table chain_cursor     enable row level security;
alter table processed_events enable row level security;
alter table pending_payouts  enable row level security;
alter table payouts          enable row level security;
alter table pending_dms      enable row level security;

alter table chain_cursor     force row level security;
alter table processed_events force row level security;
alter table pending_payouts  force row level security;
alter table payouts          force row level security;
alter table pending_dms      force row level security;

revoke all on chain_cursor     from anon, authenticated;
revoke all on processed_events from anon, authenticated;
revoke all on pending_payouts  from anon, authenticated;
revoke all on payouts          from anon, authenticated;
revoke all on pending_dms      from anon, authenticated;
