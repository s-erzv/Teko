# Teko

AI Bendahara Virtual untuk Arisan on-chain — Telegram + Groq + BNB Chain.

Repo ini punya 3 project terpisah:

```
Teko/
├── contracts/        Kontrak Solidity (Foundry project — root repo ini)
├── test/              Foundry tests
├── script/            Deploy.s.sol
├── foundry.toml
├── bot/                Bot Telegram (Node.js project sendiri)
│   ├── src/
│   ├── supabase/       Skema DB (schema.sql, rls.sql)
│   └── package.json
└── web/                Landing page (Next.js, export statis)
    ├── app/
    └── test/           Uji kontras warna & reduced-motion
```

Repo ini sekaligus pnpm workspace (`pnpm-workspace.yaml`) berisi `bot` dan
`web`. Satu `pnpm install` di root menyelesaikan dependensi keduanya.

## Kontrak (Foundry — dijalankan dari root repo ini)

```bash
forge build
forge test -vv
forge script script/Deploy.s.sol:Deploy --rpc-url bscTestnet --broadcast
```

Butuh `.env` di root (JANGAN commit) berisi `TREASURY_PRIVATE_KEY` dan `BSC_TESTNET_RPC` — lihat `bot/.env.example` buat referensi nilainya.

## Landing page (Next.js — dijalankan dari root repo)

```bash
pnpm install
pnpm run dev:web      # http://localhost:3000
pnpm run build:web    # keluaran statis ke web/out/
pnpm run test:web
```

Halaman tunggal bertema summer picnic untuk juri hackathon. `output: 'export'`,
jadi hasilnya HTML statis murni tanpa server dan tanpa function. Tidak ada
pembacaan on-chain sama sekali: halaman ini dinilai pada satu hari tertentu
dan tidak boleh terlihat rusak gara-gara RPC sedang lambat. Juri memverifikasi
sendiri lewat tautan BscScan.

Font diunduh saat build lalu di-host sendiri oleh Next, jadi halaman yang
sudah jadi tidak pernah menghubungi Google saat dibuka.

Alamat kontrak dan URL bot dikumpulkan di `web/app/links.js`. Kalau kontraknya
di-deploy ulang atau username bot berubah, cukup berkas itu yang disunting.

### Kenapa ada test untuk CSS

Dua aturan desain di halaman ini bisa rusak tanpa memunculkan error apa pun,
jadi keduanya dijaga `node:test` yang membaca `globals.css` langsung:

- `contrast.test.mjs` — enam warna palet semuanya kuning sampai oranye hangat
  dan tidak ada yang cukup gelap untuk teks. Teks putih di atas `#FF9A00`
  rasionya sekitar 2.1:1. Test ini menolak palet yang melenceng dan menjaga
  semua teks tetap memakai `--ink`.
- `motion.test.mjs` — override `prefers-reduced-motion` menang murni karena
  urutan berkas, bukan specificity. Kalau bloknya pindah ke atas aturan hover
  dasarnya, dia kalah diam-diam. Test ini menguji urutannya.

## Deploy (Netlify)

Situsnya dibangun dari root repo, bukan dari `web/`:

```toml
[build]
  command = "pnpm install && pnpm run build:web"
  publish = "web/out"
```

Di dashboard Netlify, hubungkan repo lalu **biarkan base directory kosong** —
Netlify membaca `netlify.toml` sendiri, jadi build command dan publish
directory tidak perlu diisi manual.

Dua hal yang sudah dipasang supaya build pertama tidak gagal dengan error
yang membingungkan:

- `packageManager` di `package.json` root. Tanpa itu Netlify memilih sendiri
  versi pnpm, sementara `pnpm-lock.yaml` di repo ini formatnya
  lockfileVersion 9.0 yang menuntut pnpm 9 ke atas.
- `node-linker=hoisted` di `.npmrc`. Bundler function Netlify tidak bisa
  menelusuri pohon symlink bawaan pnpm; ini baru penting saat bot diport ke
  function, tapi dipasang dari awal.

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
