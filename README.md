# Teko

AI Bendahara Virtual untuk Arisan on-chain — Telegram + Groq + BNB Chain.

Repo ini punya 2 project terpisah:

```
teko/
├── contracts/        Kontrak Solidity (Foundry project — root repo ini)
├── test/              Foundry tests
├── script/            Deploy.s.sol
├── foundry.toml
└── bot/                Bot Telegram (Node.js project sendiri)
    ├── src/
    ├── supabase/       Skema DB (schema.sql, rls.sql)
    └── package.json
```

## Kontrak (Foundry — dijalankan dari root repo ini)

```bash
forge build
forge test -vv
forge script script/Deploy.s.sol:Deploy --rpc-url bscTestnet --broadcast
```

Butuh `.env` di root (JANGAN commit) berisi `TREASURY_PRIVATE_KEY` dan `BSC_TESTNET_RPC` — lihat `bot/.env.example` buat referensi nilainya.

## Bot (Node.js — dijalankan dari `bot/`)

```bash
cd bot
pnpm install
cp .env.example .env.local   # isi semua kredensial
pnpm dev
```

Env yang dibutuhkan ada di `bot/.env.example` — Telegram, Groq, BNB Chain (RPC + alamat kontrak hasil deploy di atas), AWS KMS (enkripsi wallet custodial), Xendit (Invoice + Payout), dan Supabase (opsional; kosong = in-memory store).

Skema database (`bot/supabase/schema.sql` lalu `bot/supabase/rls.sql`) dijalankan manual sekali di SQL Editor Supabase.
