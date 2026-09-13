-- Skema Supabase untuk Teko. Jalankan di SQL Editor Supabase.
-- SC = sumber kebenaran uang. Tabel ini = identitas Telegram + status pembayaran off-chain.

-- Grup arisan (mirror ringan dari on-chain, + konteks Telegram)
create table if not exists groups (
  group_id         bigint primary key,          -- groupId on-chain
  chat_id          text not null,               -- Telegram chat/group id
  size             smallint not null,
  contribution_idr bigint not null,             -- setoran per orang per ronde (Rupiah)
  admin_user_id    text,                        -- Telegram user id yang bikin arisan ini;
                                                 -- boleh pakai /denda, /draw, /tutup_paksa,
                                                 -- /eksekusi buat grup ini SENDIRI meski dia
                                                 -- tidak ada di ADMIN_USER_IDS (admin platform
                                                 -- di ADMIN_USER_IDS tetap bisa di semua grup).
  status           text not null default 'collecting', -- collecting | finished
  created_at       timestamptz not null default now()
);
create index if not exists groups_chat_idx on groups (chat_id, status);

-- Anggota: mapping Telegram user -> wallet BSC
create table if not exists members (
  group_id         bigint not null references groups(group_id) on delete cascade,
  telegram_user_id text not null,
  username         text,
  wallet_address   text not null,
  exited           boolean not null default false, -- keluar / diganti; barisnya disimpan buat riwayat
  exited_at        timestamptz,
  created_at       timestamptz not null default now(),
  primary key (group_id, telegram_user_id)
);

-- Pembayaran via Invoice Xendit — kind menentukan apa yang dieksekusi
-- on-chain begitu lunas (lihat service.js: _settleContribution/_settleDebt/_settlePriority).
create table if not exists payments (
  order_id         text primary key,            -- external_id Xendit (unik per pembayaran)
  group_id         bigint not null references groups(group_id) on delete cascade,
  round            smallint not null default 0, -- 0 untuk kind != 'contribution'
  telegram_user_id text not null,
  kind             text not null default 'contribution', -- contribution | debt | priority
  amount_idr       bigint not null,             -- nominal on-chain (tanpa convenience fee)
  fee_idr          bigint not null default 0,   -- convenience fee (revenue off-chain)
  member_wallet    text,                        -- dibutuhkan buat kind debt/priority
  target_wallet    text,                        -- dibutuhkan buat kind priority (posisi siapa yang ditawar)
  payment_url      text,
  status           text not null default 'pending', -- pending | settled | deposit_failed
  tx_hash          text,                        -- hash tx on-chain (deposit/payDebt/requestPrioritySwap)
  created_at       timestamptz not null default now()
);
create index if not exists payments_group_round_idx on payments (group_id, round);

-- Wallet custodial: 1 baris per user Telegram. Private key TIDAK PERNAH
-- disimpan plaintext — encrypted_key adalah hasil AWS KMS envelope encryption
-- (lihat wallet.js). external_address opsional: kalau diisi, hadiah langsung
-- disapu ke situ (self-custody) alih-alih dicairkan otomatis via Xendit.
create table if not exists wallets (
  telegram_user_id text primary key,
  address          text not null unique,
  encrypted_key    jsonb not null,              -- {encryptedDataKey, iv, ciphertext, authTag}
  external_address text,
  created_at       timestamptz not null default now()
);

-- Tujuan pencairan fiat (rekening/e-wallet) per user, diisi otomatis begitu
-- pertama kali mereka balas nomor rekening setelah menang (lihat processPayout).
create table if not exists payout_destinations (
  telegram_user_id    text primary key,
  channel_code        text not null,             -- kode channel Xendit, mis. ID_GOPAY / ID_BCA
  account_number      text not null,
  account_holder_name text,
  updated_at          timestamptz not null default now()
);

-- Kursor blok per event on-chain. Bot memindai ulang dari sini saat boot supaya
-- event yang terjadi selagi proses mati (mis. VRF fulfill pas bot restart) tidak
-- hilang selamanya -- listener live saja tidak cukup.
create table if not exists chain_cursor (
  id         text primary key,            -- nama event, mis. 'RoundDrawn'
  last_block bigint not null,
  updated_at timestamptz not null default now()
);

-- Jejak event yang sudah diproses. Backfill dan listener live bisa melihat event
-- yang SAMA; primary key di sini yang bikin pemrosesan ganda mustahil.
create table if not exists processed_events (
  event_key    text primary key,          -- '<txHash>:<logIndex>'
  kind         text not null,
  processed_at timestamptz not null default now()
);

-- Hadiah yang nunggu pemenang membalas nomor rekening (lihat _handlePrizeSweep).
create table if not exists pending_payouts (
  telegram_user_id text primary key,
  group_id         bigint not null references groups(group_id) on delete cascade,
  round            smallint not null,
  prize_idr        bigint not null,
  created_at       timestamptz not null default now()
);

-- Buku besar pencairan fiat -- satu baris per percobaan payout Xendit, ditulis
-- SEBELUM request dikirim, lalu dimutakhirkan oleh callback payout.
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

-- Antrean DM yang gagal terkirim (user belum pernah /start bot). Isinya resi
-- pembayaran & pemberitahuan menang, jadi tidak boleh hilang saat proses restart.
create table if not exists pending_dms (
  id               bigserial primary key,
  telegram_user_id text not null,
  body             text not null,
  created_at       timestamptz not null default now()
);
create index if not exists pending_dms_user_idx on pending_dms (telegram_user_id, id);
