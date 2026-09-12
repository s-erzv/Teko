# Teko di Netlify: port bot ke serverless + landing page

Tanggal: 2026-09-12
Status: disetujui, siap masuk rencana implementasi

## Ringkasan

Pindahkan seluruh Teko ke satu situs Netlify: landing page statis untuk juri
hackathon, plus bot Telegram yang selama ini butuh proses Node menyala terus.
Setelah ini, satu kali deploy dan sistemnya jalan 24/7 tanpa server yang
dijaga, tanpa laptop menyala, dan tanpa biaya bulanan.

## Latar belakang & motivasi

Bot Teko sekarang adalah proses tunggal yang harus hidup selamanya: polling
Telegram, listener event Chainlink VRF, dan dua cron `setInterval`. Railway
dan Vercel milik pemilik proyek dua-duanya sudah kena limit, dan Hugging Face
Spaces tidak bisa dipakai karena Docker Spaces menuntut plan berbayar.

Yang membuat serverless mendadak layak adalah pekerjaan di commit sebelumnya
(`fix: tutup jalur kehilangan dana`). Listener VRF adalah satu-satunya bagian
yang benar-benar menuntut proses persisten, dan `backfillRoundDrawn()` yang
dibangun untuk menutup bug event hilang bekerja dengan `queryFilter`, bukan
listener. Fungsi yang membuat port ini mungkin sudah ada di repo.

Batas eksekusi Netlify Functions, semuanya tersedia di plan Free:

| Jenis | Batas |
|---|---|
| Sinkron | 60 detik |
| Scheduled (cron) | 30 detik |
| Background | 15 menit, dengan retry otomatis |

## Yang TIDAK berubah

Ditulis lebih dulu karena ini inti dari kenapa port-nya layak dikerjakan:

- `bot/src/service.js` — seluruh logika bisnis
- `bot/src/chain.js`, `wallet.js`, `xendit.js`, `parse.js`
- `bot/src/store.js` — kecuali penambahan tabel baru & penghapusan mode in-memory
- Seluruh handler Telegraf yang sekarang ada di `index.js`
- 25 test yang sudah ada, jalan tanpa disentuh
- Kontrak Solidity, test Foundry, dan skrip deploy

## Arsitektur

### Struktur repo

```
teko/
├── package.json              npm workspaces: ["bot", "web"]     BARU
├── netlify.toml                                                 BARU
├── contracts/ test/ script/  Foundry, tidak disentuh
├── bot/src/                  lapisan logika, sebagian besar tetap
├── web/                      Next.js statis, landing page        BARU
└── netlify/functions/        entry point tipis                   BARU
```

Build dijalankan dari root repo. `publish` menunjuk ke hasil export statis
Next.js; `functions` menunjuk ke `netlify/functions`. Workspaces dipakai supaya
satu `npm install` di root menyelesaikan dependensi `bot` dan `web` sekaligus,
dan supaya function bisa mengimpor `bot/src/*` langsung tanpa menyalin kode.

### Inventaris function

| Function | Jenis | Path | Tugas |
|---|---|---|---|
| `telegram` | sinkron | `/api/telegram` | `bot.handleUpdate()` |
| `xendit-invoice` | background | `/api/xendit/invoice` | `onPaymentSettled()` |
| `xendit-payout` | background | `/api/xendit/payout` | `onPayoutCallback()` |
| `cron` | scheduled | — | memicu `worker`, tidak bekerja sendiri |
| `worker` | background | `/api/worker` | retry, backfill, sweep denda, cek saldo |

Alasan tiap pilihan jenis:

**`telegram` sinkron.** Perintah terberat (`createArisan`, `castVote`) hanya
satu sampai dua transaksi on-chain, belasan detik, muat dalam 60 detik. Telegram
juga menuntut respons cepat.

**Callback Xendit background.** Kode sekarang membalas 200 lalu lanjut bekerja.
Pola itu rusak di serverless karena invokasi berakhir begitu respons dikirim.
Background function membalas 202 seketika lalu tetap berjalan sampai 15 menit,
jadi ini memperbaiki masalah, bukan mengompromikannya. Retry bawaan Netlify
(1 menit, lalu 2 menit) jadi lapisan pemulihan tambahan gratis.

**Cron terpisah dari worker.** Scheduled function dibatasi 30 detik, sementara
`sweepAllDeadlines()` memutar semua grup dikali semua anggota dengan transaksi
on-chain di tiap iterasi. Cron hanya menembak worker lewat HTTP lalu selesai.

Dua jadwal: `*/10 * * * *` untuk pemulihan, `*/30 * * * *` untuk sweep denda.
Sama dengan nilai `setInterval` yang sekarang.

### Alur pemulihan pengganti listener VRF

`chain.onRoundDrawn()` dihapus. `backfillRoundDrawn()` dipanggil dari dua
tempat: worker terjadwal, dan ekor function `telegram`. Yang kedua bikin
pengumuman pemenang ikut segar tiap ada aktivitas chat, bukan hanya tiap
sepuluh menit.

## Perubahan state & konfigurasi

1. **Supabase wajib di lingkungan terdeploy, bukan di test.** Mode in-memory
   tidak punya arti ketika tiap invokasi dapat instance baru: state-nya hilang
   sebelum request berikutnya datang, dan bot akan tampak jalan sambil gagal
   diam-diam.

   Tapi implementasi in-memory itu sendiri TETAP ADA, karena 25 test yang
   sekarang justru menguji lewat jalur itu tanpa butuh kredensial apa pun.
   Yang berubah cuma satu: `store.js` menolak memakainya bila terdeteksi
   berjalan di Netlify (variabel `NETLIFY` ada) sementara kredensial Supabase
   kosong, dan melempar error yang jelas alih-alih diam-diam mundur ke Map.
   Jalur lokal dan test tidak terpengaruh.

2. **Tabel `pending_creations`.** Satu-satunya state yang sengaja ditinggal di
   memori pada commit sebelumnya. Jawaban "5 orang" dan "200rb" bisa mendarat
   di instance berbeda. Kolom waktu plus pembersihan baris terbengkalai
   (lebih tua dari 24 jam) dikerjakan worker.

3. **Tabel `chain_locks`.** Kunci singkat untuk penulisan on-chain, lihat bagian
   Risiko.

4. **`config.js` melempar error, bukan `process.exit(1)`.** Di dalam function,
   `process.exit` membunuh invokasi tanpa log yang berguna.

5. **`index.js` pecah dua.** Handler Telegraf pindah ke modul yang mengekspor
   instance bot yang sudah dikonfigurasi. `bot.launch()`, dua `setInterval`,
   dan listener VRF dihapus.

6. **`ensureApproval()` keluar dari jalur boot.** Kalau dibiarkan, dia jalan di
   setiap invokasi: panggilan RPC di tiap pesan masuk, dan berpotensi mengirim
   transaksi approve berulang. Dipindah jadi pekerjaan sekali jalan di worker.

7. **`notifier.js` menerima klien Telegram per invokasi**, bukan sekali saat
   boot.

8. **Variabel lingkungan pindah ke dashboard Netlify.** `WEBHOOK_PORT` dan
   `PUBLIC_BASE_URL` tidak terpakai; URL diambil dari yang disediakan Netlify.
   Variabel baru: `TELEGRAM_WEBHOOK_SECRET`, `WORKER_SECRET`.

## Risiko & mitigasi

### Endpoint Telegram jadi publik

Dengan polling, hanya bot yang bisa mengambil update. Dengan webhook, siapa pun
yang tahu URL-nya bisa mengirim update palsu dan menyamar jadi siapa saja,
termasuk admin, lalu memanggil `/tutup_paksa`.

Mitigasi: `setWebhook` dipanggil dengan `secret_token`. Telegram mengirimkannya
balik sebagai header `X-Telegram-Bot-Api-Secret-Token` di tiap request.
Function `telegram` memverifikasinya sebelum apa pun dikerjakan, dengan
perbandingan constant-time, sama seperti `verifyCallbackToken` milik Xendit.

Endpoint `worker` dilindungi `WORKER_SECRET` dengan cara yang sama.

### Tabrakan nonce wallet Treasury

Selama ini satu proses, jadi ethers mengantrikan transaksi secara berurutan.
Begitu jadi function, dua anggota membayar bersamaan berarti dua `deposit()`
berjalan paralel dari wallet Treasury yang sama. Keduanya membaca nonce yang
sama dan satu transaksi tertendang.

Idempotensi dari commit sebelumnya (`claimPaymentPending`, `claimEvent`)
mencegah kredit ganda, tapi **tidak** mencegah masalah ini. Ini risiko baru.

Mitigasi: kunci singkat di Supabase yang dipegang selama penulisan on-chain
berlangsung, dengan TTL supaya invokasi yang mati tidak mengunci selamanya.
Pemanggil yang gagal mendapat kunci melempar error; background function
Netlify otomatis mencoba ulang setelah satu menit, yang persis perilaku yang
diinginkan.

Pembacaan on-chain (`getGroup`, `getMember`, `queue`) tidak butuh kunci.

### Cold start

Invokasi pertama setelah senggang lebih lambat karena provider ethers, klien
KMS, dan klien Supabase dibangun ulang. Telegram dan Xendit sama-sama
mengulang pengiriman, jadi ini soal latensi, bukan kehilangan data.

## Desain visual

Tema: **summer picnic**. Ladang bunga matahari, cahaya golden hour, perkumpulan
di luar ruang, taplak piknik, sore musim panas yang riang.

Arah ini bukan sekadar selera. Arisan adalah perkumpulan orang yang saling
percaya dan bergiliran, dan piknik membawa arti kebersamaan yang tepat: orang
berkumpul, duduk melingkar, dan setiap orang kebagian. Itu persis mekanika
produknya. Konsekuensinya untuk desain: hangat, analog, dan ramai-ramai, bukan
dingin dan individual seperti dasbor fintech.

Palet yang diminta:

| Token | Hex |
|---|---|
| `sun-600` | `#FF9A00` |
| `sun-500` | `#FFAD01` |
| `sun-400` | `#FFBE00` |
| `sun-300` | `#FFD140` |
| `sun-200` | `#FFE36E` |
| `sun-100` | `#FEF58E` |

**Masalah keterbacaan dan penyelesaiannya.** Enam warna itu semuanya kuning
sampai oranye hangat; tidak ada satu pun yang cukup gelap untuk teks. `#FF9A00`
di atas putih hanya sekitar 2.3:1, jauh di bawah ambang 4.5:1. Maka palet ini
dipakai untuk permukaan, blok, dan aksen, ditambah satu warna tinta:

| Token | Hex | Pemakaian |
|---|---|---|
| `ink` | `#3D2410` | Teks utama, cokelat tua hangat, masih satu keluarga dengan matahari terbit |
| `paper` | `#FFFDF5` | Latar dasar, putih hangat, bukan putih murni |

**Motif taplak piknik.** Kotak-kotak putih-oranye adalah gingham taplak piknik,
dibuat dengan CSS gradient berulang, bukan gambar, supaya tetap tajam di layar
mana pun dan tidak menambah beban unduh. Dipakai sebagai pita pembatas antar
bagian dan alas kartu, bukan sebagai latar seluruh halaman, supaya tidak
melelahkan mata.

**Bahasa visual pendukung**, semuanya CSS dan SVG inline, tanpa aset unduhan:

- Gradien golden hour dari `sun-600` ke `sun-100` di latar hero, meniru cahaya
  sore rendah
- Siluet kepala bunga matahari sebagai penanda bagian dan butir daftar
- Kartu dengan sudut membulat besar dan bayangan hangat rendah, terasa seperti
  benda yang diletakkan di atas taplak

Halaman tunggal, empat bagian: hero dengan proposisi dan dua tombol (buka bot,
lihat kontrak), diagram cara kerja, bagian kenapa on-chain dengan tangkapan
layar percakapan, dan penutup berisi tautan teknis.

Gerak dibuat seperlunya saja dan dimatikan penuh di bawah
`prefers-reduced-motion`.

Statis penuh, tanpa pembacaan on-chain langsung. Keputusan sadar: halaman ini
dinilai pada satu hari tertentu dan tidak boleh terlihat rusak gara-gara RPC
sedang lambat. Juri tetap bisa memverifikasi sendiri lewat tautan BscScan.

## Rencana pengujian

- 25 test yang ada tetap jalan tanpa perubahan
- Test baru untuk `pending_creations` dan mekanisme kunci on-chain, termasuk
  kasus dua pemanggil berebut kunci dan kasus kunci kedaluwarsa
- Test untuk verifikasi `secret_token` Telegram, meniru pola test
  `verifyCallbackToken` yang sudah ada
- `netlify dev` untuk uji manual function secara lokal sebelum deploy

## Di luar cakupan

Dashboard anggota, panel admin berbasis web, dan portal pembayaran. Ketiganya
sempat dipertimbangkan lalu dikesampingkan: landing page untuk juri adalah
satu-satunya kebutuhan yang dipilih. Struktur Next.js yang dipakai membuka
jalan ke sana nanti tanpa harus dibongkar ulang.
