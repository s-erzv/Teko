-- Skema Supabase untuk Teko. Jalankan di SQL Editor Supabase.
-- SC = sumber kebenaran uang. Tabel ini = identitas Telegram + status pembayaran off-chain.

-- Grup arisan (mirror ringan dari on-chain, + konteks Telegram)
create table if not exists groups (
  group_id         bigint primary key,          -- groupId on-chain
  chat_id          text not null,               -- Telegram chat/group id
  size             smallint not null,
  contribution_idr bigint not null,             -- setoran per orang per ronde (Rupiah)
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
  created_at       timestamptz not null default now(),
  primary key (group_id, telegram_user_id)
);

-- Pembayaran via Payment Link Midtrans
create table if not exists payments (
  order_id         text primary key,            -- order_id Midtrans (unik per setoran)
  group_id         bigint not null references groups(group_id) on delete cascade,
  round            smallint not null,
  telegram_user_id text not null,
  amount_idr       bigint not null,             -- setoran on-chain (tanpa fee)
  fee_idr          bigint not null default 0,   -- convenience fee (revenue off-chain)
  payment_url      text,
  status           text not null default 'pending', -- pending | settled | deposit_failed
  tx_hash          text,                        -- hash tx deposit() on-chain
  created_at       timestamptz not null default now()
);
create index if not exists payments_group_round_idx on payments (group_id, round);
