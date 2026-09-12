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

### Database

Instalasi baru: jalankan `bot/supabase/schema.sql` lalu `bot/supabase/rls.sql`
di SQL Editor Supabase, sekali saja.

Kalau `schema.sql` versi awal SUDAH pernah dijalankan, jalankan juga
`bot/supabase/migrations/001_resilience.sql` — isinya kolom `members.exited` plus
tabel `chain_cursor`, `processed_events`, `pending_payouts`, `payouts`, dan
`pending_dms`. Semuanya idempotent, aman diulang.

Supabase praktis WAJIB buat dipakai beneran. Tanpa itu, store jatuh ke mode
in-memory dan tiga hal kritis hilang tiap restart: hadiah yang menunggu nomor
rekening pemenang, antrean resi yang belum terkirim, dan kursor blok yang dipakai
menyusulkan event undian yang terlewat. Backfill undian ikut dimatikan di mode ini
supaya tidak mengumumkan ulang ronde lama setiap kali boot.

### Webhook Xendit

Ada DUA URL yang harus didaftarkan di dashboard Xendit, bukan satu:

```
<PUBLIC_BASE_URL>/xendit/invoice-callback    Settings > Webhooks > Invoices paid
<PUBLIC_BASE_URL>/xendit/payout-callback     Settings > Webhooks > Payouts
```

Tanpa yang kedua, pencairan yang ditolak Xendit tidak pernah terlihat: bot cuma
tahu status "ACCEPTED" yang dikembalikan saat perintahnya dikirim.

### Test

```bash
cd bot
npm test          # store, parser Rupiah, parser callback Xendit — tanpa kredensial
pnpm verify       # dogfood end-to-end ke testnet + sandbox; butuh .env.verify.local
```
