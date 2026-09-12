# Landing Page Summer Picnic + Fondasi Netlify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Landing page statis bertema summer picnic untuk juri hackathon, ter-deploy di Netlify, sekaligus memasang fondasi workspace yang nanti dipakai port bot.

**Architecture:** pnpm workspace di root repo Foundry yang sudah ada. `web/` berisi Next.js App Router dengan `output: 'export'`, menghasilkan HTML statis murni tanpa function sama sekali. Netlify build dari root, publish dari `web/out`. Tidak ada pembacaan on-chain: halaman ini dinilai pada satu hari tertentu dan tidak boleh terlihat rusak gara-gara RPC lambat.

**Tech Stack:** pnpm 10, Node 24, Next.js App Router (static export), CSS kustom dengan custom properties (tanpa Tailwind), `next/font/google` untuk self-host font saat build, `node:test` untuk uji kontras.

**Spec:** `docs/superpowers/specs/2026-09-12-netlify-port-and-landing-design.md`

## Global Constraints

- Paket manager **pnpm**, bukan npm. Repo sudah punya `bot/pnpm-lock.yaml`.
- `.npmrc` root wajib berisi `node-linker=hoisted` sejak Task 1. Tanpa ini, bundler function Netlify gagal menelusuri pohon symlink pnpm di Rencana 2.
- Palet warna, nilai persis, tidak boleh diubah: `--sun-600:#FF9A00`, `--sun-500:#FFAD01`, `--sun-400:#FFBE00`, `--sun-300:#FFD140`, `--sun-200:#FFE36E`, `--sun-100:#FEF58E`.
- Dua warna tambahan yang tidak ada di palet asli, wajib ada karena palet aslinya tidak punya warna cukup gelap untuk teks: `--ink:#3D2410`, `--paper:#FFFDF5`.
- **Teks putih di atas warna `sun-*` DILARANG.** Putih di atas `#FF9A00` rasio kontrasnya sekitar 2.1:1, jauh di bawah ambang 4.5:1. Semua teks memakai `--ink`.
- Tema: summer picnic. Ladang bunga matahari, golden hour, perkumpulan luar ruang, taplak piknik, sore musim panas yang riang. Bukan camping.
- Motif gingham dibuat dengan CSS gradient, bukan file gambar.
- Seluruh gerak dimatikan di bawah `prefers-reduced-motion: reduce`.
- Bahasa halaman: Indonesia.
- Folder `contracts/`, `test/`, `script/`, dan `bot/` TIDAK disentuh di rencana ini.

---

### Task 1: Fondasi workspace pnpm + Next.js statis yang bisa di-build

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `.npmrc`
- Create: `package.json`
- Create: `netlify.toml`
- Create: `web/package.json`
- Create: `web/next.config.mjs`
- Create: `web/app/layout.jsx`
- Create: `web/app/page.jsx`
- Create: `.gitignore` (modify existing di root)

**Interfaces:**
- Consumes: tidak ada, ini task pertama
- Produces: workspace `web` bernama `teko-web`; skrip root `pnpm run build:web`; direktori keluaran `web/out/`

- [x] **Step 1: Buat deklarasi workspace dan konfigurasi pnpm**

`pnpm-workspace.yaml`:

```yaml
packages:
  - bot
  - web
```

`.npmrc`:

```
# Bundler function Netlify (esbuild) tidak bisa menelusuri pohon symlink
# bawaan pnpm, sehingga dependensi tidak ikut terbundel dan function gagal
# saat runtime dengan error modul tidak ditemukan. Layout hoisted menghindari
# itu sepenuhnya. Dipasang sejak awal, bukan setelah deploy pertama gagal.
node-linker=hoisted
```

- [x] **Step 2: Buat package.json root**

```json
{
  "name": "teko",
  "private": true,
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build:web": "pnpm --filter teko-web build",
    "dev:web": "pnpm --filter teko-web dev",
    "test:web": "pnpm --filter teko-web test",
    "test:bot": "pnpm --filter teko-bot test",
    "test": "pnpm run test:bot && pnpm run test:web"
  }
}
```

- [x] **Step 3: Buat package.json workspace web**

```json
{
  "name": "teko-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "node --test \"test/*.test.mjs\""
  },
  "dependencies": {
    "next": "^15.5.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

- [x] **Step 4: Buat konfigurasi Next.js untuk export statis**

`web/next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keluaran HTML statis murni: tidak ada server, tidak ada function.
  // Netlify menyajikannya langsung dari CDN.
  output: "export",
  // Optimasi gambar Next butuh server; matikan untuk export statis.
  images: { unoptimized: true },
};

export default nextConfig;
```

- [x] **Step 5: Buat layout dan halaman placeholder minimal**

`web/app/layout.jsx`:

```jsx
export const metadata = {
  title: "Teko — Bendahara Arisan On-Chain",
  description:
    "Arisan lewat Telegram dengan dana ditahan smart contract BNB Chain dan pemenang diundi Chainlink VRF. Anggota tidak perlu punya wallet.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
```

`web/app/page.jsx`:

```jsx
export default function Home() {
  return <main>Teko</main>;
}
```

- [x] **Step 6: Tambahkan keluaran build ke .gitignore root**

Tambahkan baris berikut ke `.gitignore` yang sudah ada di root:

```
# Next.js (web/)
web/.next/
web/out/
node_modules/
```

- [x] **Step 7: Buat netlify.toml**

```toml
# Build dijalankan dari root repo, bukan dari web/, supaya nanti direktori
# netlify/functions di Rencana 2 ikut terbaca tanpa path relatif yang aneh.
[build]
  command = "pnpm install && pnpm run build:web"
  publish = "web/out"

[build.environment]
  NODE_VERSION = "24"
```

- [x] **Step 8: Pasang dependensi dan jalankan build**

Run:

```bash
pnpm install
pnpm run build:web
```

Expected: build selesai tanpa error, dan `web/out/index.html` ada.

- [x] **Step 9: Verifikasi keluaran statis benar-benar terbentuk**

Run:

```bash
test -f web/out/index.html && echo "OK: export statis terbentuk" || echo "GAGAL"
```

Expected: `OK: export statis terbentuk`

- [x] **Step 10: Commit**

```bash
git add pnpm-workspace.yaml .npmrc package.json netlify.toml .gitignore web/ pnpm-lock.yaml
git commit -m "build: fondasi pnpm workspace + Next.js statis buat landing page"
```

---

### Task 2: Token warna dengan uji kontras otomatis

Ini satu-satunya risiko desain yang bisa diuji mesin, dan risikonya nyata: enam warna palet semuanya kuning sampai oranye hangat, tidak ada yang cukup gelap untuk teks. Ujinya membaca CSS sungguhan, bukan salinan nilai di file test, supaya tidak bisa melenceng diam-diam.

**Files:**
- Create: `web/app/globals.css`
- Create: `web/test/contrast.test.mjs`
- Modify: `web/app/layout.jsx`

**Interfaces:**
- Consumes: workspace `teko-web` dari Task 1
- Produces: custom properties `--sun-100`..`--sun-600`, `--ink`, `--paper` di `:root`; fungsi uji `readTokens()` dan `contrastRatio(hexA, hexB)` di `web/test/contrast.test.mjs`

- [x] **Step 1: Tulis test yang gagal**

`web/test/contrast.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));

/** Baca semua custom property warna dari globals.css. CSS-nya yang jadi
 *  sumber kebenaran, bukan salinan nilai di file ini -- kalau seseorang
 *  mengubah warna di CSS, test ini ikut menguji nilai yang baru. */
function readTokens() {
  const css = readFileSync(cssPath, "utf8");
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

/** Luminansi relatif WCAG 2.1. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rasio kontras WCAG 2.1, antara 1 dan 21. */
function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

test("semua token palet ada dan formatnya benar", () => {
  const t = readTokens();
  for (const name of [
    "sun-100", "sun-200", "sun-300", "sun-400", "sun-500", "sun-600",
    "ink", "paper",
  ]) {
    assert.match(t[name] ?? "", /^#[0-9a-f]{6}$/, `token --${name} hilang`);
  }
});

test("nilai palet persis seperti yang diminta, tidak boleh melenceng", () => {
  const t = readTokens();
  assert.equal(t["sun-600"], "#ff9a00");
  assert.equal(t["sun-500"], "#ffad01");
  assert.equal(t["sun-400"], "#ffbe00");
  assert.equal(t["sun-300"], "#ffd140");
  assert.equal(t["sun-200"], "#ffe36e");
  assert.equal(t["sun-100"], "#fef58e");
});

test("tinta di atas tiap latar yang dipakai lolos ambang teks 4.5:1", () => {
  const t = readTokens();
  const latar = ["paper", "sun-100", "sun-200", "sun-300", "sun-400", "sun-500", "sun-600"];
  for (const bg of latar) {
    const rasio = contrastRatio(t["ink"], t[bg]);
    assert.ok(
      rasio >= 4.5,
      `--ink di atas --${bg} cuma ${rasio.toFixed(2)}:1, di bawah ambang 4.5`
    );
  }
});

test("teks utama di atas kertas lolos ambang AAA 7:1", () => {
  const t = readTokens();
  const rasio = contrastRatio(t["ink"], t["paper"]);
  assert.ok(rasio >= 7, `cuma ${rasio.toFixed(2)}:1`);
});

test("putih di atas oranye TIDAK lolos -- ini alasan --ink harus ada", () => {
  const t = readTokens();
  const rasio = contrastRatio("#ffffff", t["sun-600"]);
  assert.ok(
    rasio < 4.5,
    "Kalau test ini gagal, palet berubah dan larangan teks putih perlu ditinjau ulang."
  );
});
```

- [x] **Step 2: Jalankan test, pastikan gagal**

Run: `pnpm run test:web`
Expected: FAIL dengan error tidak bisa membaca `../app/globals.css` karena filenya belum ada.

- [x] **Step 3: Tulis globals.css dengan tokennya**

`web/app/globals.css`:

```css
/* ── Token ────────────────────────────────────────────────────
   Palet summer picnic. Enam warna matahari dipakai untuk permukaan,
   blok, dan aksen -- TIDAK untuk teks di atas teks. Tidak satu pun
   dari enam warna itu cukup gelap untuk dijadikan warna teks, jadi
   --ink ditambahkan: cokelat tua hangat yang masih terasa satu
   keluarga dengan matahari terbit tapi kebaca.

   Aturan yang dijaga test di web/test/contrast.test.mjs:
   teks SELALU --ink, tidak pernah putih di atas warna sun-*.
   ───────────────────────────────────────────────────────────── */
:root {
  --sun-600: #FF9A00;
  --sun-500: #FFAD01;
  --sun-400: #FFBE00;
  --sun-300: #FFD140;
  --sun-200: #FFE36E;
  --sun-100: #FEF58E;

  --ink: #3D2410;
  --paper: #FFFDF5;

  /* Tinta yang dilemahkan untuk teks sekunder. Tetap di atas ambang
     karena basisnya --ink, bukan abu-abu netral yang bikin halaman
     terasa dingin. */
  --ink-soft: #6B4A2F;

  --radius-card: 20px;
  --shadow-warm: 0 8px 24px rgba(61, 36, 16, 0.10);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [x] **Step 4: Impor globals.css di layout**

Ubah `web/app/layout.jsx`, tambahkan baris impor paling atas:

```jsx
import "./globals.css";

export const metadata = {
  title: "Teko — Bendahara Arisan On-Chain",
  description:
    "Arisan lewat Telegram dengan dana ditahan smart contract BNB Chain dan pemenang diundi Chainlink VRF. Anggota tidak perlu punya wallet.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
```

- [x] **Step 5: Jalankan test, pastikan lolos**

Run: `pnpm run test:web`
Expected: PASS, lima test.

- [x] **Step 6: Commit**

```bash
git add web/app/globals.css web/app/layout.jsx web/test/contrast.test.mjs
git commit -m "feat(web): token warna summer picnic + uji kontras otomatis"
```

---

### Task 3: Primitif visual piknik

**Files:**
- Modify: `web/app/globals.css`
- Create: `web/app/components/Sunflower.jsx`
- Create: `web/app/components/Gingham.jsx`

**Interfaces:**
- Consumes: token dari Task 2
- Produces: komponen `<Sunflower size={n} />` dan `<Gingham />`; kelas CSS `.goldenhour`, `.card`, `.wrap`, `.section`

- [x] **Step 1: Tambahkan primitif layout, gingham, dan golden hour ke globals.css**

Tambahkan di akhir `web/app/globals.css`:

```css
/* ── Tata letak ───────────────────────────────────────────── */
.wrap {
  max-width: 1060px;
  margin-inline: auto;
  padding-inline: 20px;
}

.section {
  padding-block: clamp(48px, 8vw, 96px);
}

/* ── Golden hour ──────────────────────────────────────────────
   Cahaya sore rendah: paling pekat di bawah, memudar ke atas.
   Arahnya sengaja terbalik dari gradien langit biasa. */
.goldenhour {
  background:
    radial-gradient(90% 70% at 50% 100%, var(--sun-400) 0%, transparent 70%),
    linear-gradient(180deg, var(--sun-100) 0%, var(--sun-200) 45%, var(--sun-300) 100%);
}

/* ── Taplak piknik ────────────────────────────────────────────
   Gingham asli dibuat dari dua pita semi-transparan yang saling
   silang: perpotongannya jadi lebih gelap dengan sendirinya,
   persis seperti kain sungguhan. Dibuat dengan gradient, bukan
   gambar, supaya tajam di layar mana pun dan nol beban unduh. */
.gingham {
  /* Sel HARUS jauh lebih kecil dari tinggi pita. Kalau sel dan pita sama
     tinggi, cuma satu baris sel yang terlihat dan persilangan dua gradient
     tidak pernah terbentuk -- hasilnya garis putus-putus, bukan gingham. */
  --gingham-size: 14px;
  background-color: var(--paper);
  background-image:
    repeating-linear-gradient(
      90deg,
      rgba(255, 154, 0, 0.68) 0 calc(var(--gingham-size) / 2),
      transparent calc(var(--gingham-size) / 2) var(--gingham-size)
    ),
    repeating-linear-gradient(
      0deg,
      rgba(255, 154, 0, 0.68) 0 calc(var(--gingham-size) / 2),
      transparent calc(var(--gingham-size) / 2) var(--gingham-size)
    );
}

/* Pita pembatas antar bagian. Gingham dipakai sebagai aksen selebar
   pita, BUKAN sebagai latar seluruh halaman -- kotak-kotak penuh satu
   layar bikin mata cepat lelah dan teks di atasnya susah dibaca. */
.gingham-band {
  /* ~3 baris sel: cukup untuk membaca anyaman kainnya. */
  height: 44px;
}

/* ── Kartu ────────────────────────────────────────────────────
   Sudut membulat besar dan bayangan hangat rendah: terasa seperti
   benda yang diletakkan di atas taplak, bukan panel aplikasi. */
.card {
  background: var(--paper);
  border: 2px solid var(--ink);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-warm);
  padding: 24px;
}
```

- [x] **Step 2: Buat komponen Sunflower**

`web/app/components/Sunflower.jsx`:

```jsx
/**
 * Kepala bunga matahari, SVG inline. Dipakai sebagai penanda bagian dan
 * butir daftar. Inline, bukan file, supaya warnanya ikut token CSS dan
 * tidak ada permintaan jaringan tambahan.
 */
export default function Sunflower({ size = 28, className = "" }) {
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {petals.map((deg) => (
        <ellipse
          key={deg}
          cx="50"
          cy="22"
          rx="8"
          ry="20"
          fill="var(--sun-400)"
          transform={`rotate(${deg} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="18" fill="var(--ink)" />
      <circle cx="50" cy="50" r="12" fill="var(--sun-600)" />
    </svg>
  );
}
```

- [x] **Step 3: Buat komponen Gingham**

`web/app/components/Gingham.jsx`:

```jsx
/** Pita taplak piknik sebagai pembatas antar bagian. */
export default function Gingham() {
  return <div className="gingham gingham-band" aria-hidden="true" />;
}
```

- [x] **Step 4: Pasang sementara di halaman untuk diperiksa mata**

Ganti isi `web/app/page.jsx`:

```jsx
import Sunflower from "./components/Sunflower";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <section className="goldenhour section">
        <div className="wrap">
          <Sunflower size={64} />
          <div className="card" style={{ marginTop: 24 }}>
            Kartu di atas golden hour.
          </div>
        </div>
      </section>
      <Gingham />
    </main>
  );
}
```

- [x] **Step 5: Periksa dengan mata di browser**

Run: `pnpm run dev:web`

Buka `http://localhost:3000` dan pastikan empat hal terlihat: gradien golden hour paling pekat di bagian bawah, bunga matahari punya dua belas kelopak dengan inti gelap, kartu punya sudut membulat besar dan garis tepi cokelat tua, dan pita gingham terlihat sebagai kotak-kotak silang dengan perpotongan yang lebih pekat.

Hentikan server dengan Ctrl+C setelah selesai.

- [x] **Step 6: Pastikan uji kontras masih lolos**

Run: `pnpm run test:web`
Expected: PASS, lima test.

- [x] **Step 7: Commit**

```bash
git add web/app/globals.css web/app/components/ web/app/page.jsx
git commit -m "feat(web): primitif visual piknik (gingham, golden hour, bunga matahari)"
```

---

### Task 4: Bagian hero

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/app/layout.jsx`
- Create: `web/app/components/Hero.jsx`
- Modify: `web/app/page.jsx`

**Interfaces:**
- Consumes: `.goldenhour`, `.wrap`, `.section`, `<Sunflower />` dari Task 3
- Produces: komponen `<Hero />`

- [x] **Step 1: Pasang font lewat next/font**

Ubah `web/app/layout.jsx`:

```jsx
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

// Fraunces: serif hangat dengan sumbu "soft" dan "wonky" -- terasa
// seperti papan nama pasar tani, cocok untuk golden hour. Inter untuk
// teks isi. Keduanya diunduh saat BUILD lalu di-host sendiri oleh
// Next, jadi halaman jadi tidak punya ketergantungan ke Google saat
// dibuka -- penting karena halaman ini dinilai di jaringan yang tidak
// kita kendalikan.
// Fraunces adalah variable font, jadi JANGAN set `weight` maupun `axes`:
// kombinasi keduanya ditolak next/font saat build. Tanpa keduanya, seluruh
// rentang berat tersedia lewat CSS `font-weight` biasa.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata = {
  title: "Teko — Bendahara Arisan On-Chain",
  description:
    "Arisan lewat Telegram dengan dana ditahan smart contract BNB Chain dan pemenang diundi Chainlink VRF. Anggota tidak perlu punya wallet.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id" className={`${fraunces.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

- [x] **Step 2: Tambahkan gaya tipografi dan tombol ke globals.css**

Tambahkan di akhir `web/app/globals.css`:

```css
body {
  font-family: var(--font-body), system-ui, -apple-system, sans-serif;
}

h1, h2, h3 {
  font-family: var(--font-display), Georgia, serif;
  line-height: 1.15;
  margin: 0 0 16px;
}

h1 {
  font-size: clamp(2.2rem, 6vw, 4rem);
  letter-spacing: -0.02em;
}

h2 {
  font-size: clamp(1.6rem, 3.5vw, 2.4rem);
}

p {
  margin: 0 0 16px;
  max-width: 60ch;
}

.lead {
  font-size: clamp(1.05rem, 2vw, 1.25rem);
  color: var(--ink);
}

.muted {
  color: var(--ink-soft);
}

/* ── Tombol ───────────────────────────────────────────────────
   Teks SELALU --ink, tidak pernah putih. Putih di atas --sun-600
   rasionya sekitar 2.1:1; uji kontras di web/test menjaga aturan ini. */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-body), system-ui, sans-serif;
  font-weight: 600;
  font-size: 1rem;
  color: var(--ink);
  text-decoration: none;
  padding: 14px 24px;
  border-radius: 999px;
  border: 2px solid var(--ink);
  transition: transform 120ms ease, box-shadow 120ms ease;
}

.btn-primary {
  background: var(--sun-400);
  box-shadow: 0 4px 0 var(--ink);
}

.btn-secondary {
  background: var(--paper);
  box-shadow: 0 4px 0 var(--ink);
}

.btn:hover {
  transform: translateY(2px);
  box-shadow: 0 2px 0 var(--ink);
}

.btn:focus-visible {
  outline: 3px solid var(--ink);
  outline-offset: 3px;
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 28px;
}
```

- [x] **Step 3: Buat komponen Hero**

`web/app/components/Hero.jsx`:

```jsx
import Sunflower from "./Sunflower";

export default function Hero() {
  return (
    <section className="goldenhour section">
      <div className="wrap">
        <Sunflower size={56} />
        <h1>
          Bendahara arisan yang
          <br />
          nggak bisa kabur bawa uang.
        </h1>
        <p className="lead">
          Teko mengurus arisan grup kamu lewat Telegram. Uangnya ditahan smart
          contract di BNB Chain, pemenang tiap ronde diundi Chainlink VRF, dan
          anggota nggak perlu punya wallet kripto sama sekali.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href="https://t.me/tekoarisan_bot">
            Buka di Telegram
          </a>
          <a
            className="btn btn-secondary"
            href="https://testnet.bscscan.com/"
            rel="noopener"
          >
            Lihat kontraknya
          </a>
        </div>
      </div>
    </section>
  );
}
```

- [x] **Step 4: Pasang Hero di halaman**

`web/app/page.jsx`:

```jsx
import Hero from "./components/Hero";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <Hero />
      <Gingham />
    </main>
  );
}
```

- [x] **Step 5: Periksa di browser**

Run: `pnpm run dev:web`

Buka `http://localhost:3000`. Pastikan judulnya memakai serif hangat, dua tombol punya bayangan padat di bawahnya dan bergeser turun saat disorot, dan teks tombol berwarna cokelat tua, bukan putih. Tekan Tab untuk memastikan cincin fokus terlihat jelas di kedua tombol. Hentikan dengan Ctrl+C.

- [x] **Step 6: Pastikan build dan test masih lolos**

Run: `pnpm run test:web && pnpm run build:web`
Expected: test PASS, build sukses.

- [x] **Step 7: Commit**

```bash
git add web/app/
git commit -m "feat(web): bagian hero golden hour + tipografi"
```

---

### Task 5: Bagian "Cara kerjanya"

**Files:**
- Create: `web/app/components/HowItWorks.jsx`
- Modify: `web/app/globals.css`
- Modify: `web/app/page.jsx`

**Interfaces:**
- Consumes: `.card`, `.wrap`, `.section`, `<Sunflower />`
- Produces: komponen `<HowItWorks />`

- [x] **Step 1: Tambahkan gaya grid langkah ke globals.css**

Tambahkan di akhir `web/app/globals.css`:

```css
.steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
  margin-top: 32px;
  list-style: none;
  padding: 0;
}

.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--sun-300);
  border: 2px solid var(--ink);
  font-family: var(--font-display), Georgia, serif;
  font-weight: 700;
  margin-bottom: 12px;
}

.step h3 {
  font-size: 1.15rem;
  margin-bottom: 8px;
}

.step p {
  margin: 0;
  font-size: 0.95rem;
  color: var(--ink-soft);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
```

- [x] **Step 2: Buat komponen HowItWorks**

`web/app/components/HowItWorks.jsx`:

```jsx
import Sunflower from "./Sunflower";

const LANGKAH = [
  {
    judul: "Bikin di grup",
    isi: "Ketik \"buat arisan 5 orang 200rb\" di grup Telegram. Teko bikin grupnya di smart contract dan nanya sisanya kalau ada yang belum disebut.",
  },
  {
    judul: "Setor pakai rupiah",
    isi: "Tiap anggota dapat link pembayaran privat. Bayar pakai bank atau e-wallet biasa. Teko yang mengurus sisi on-chain-nya.",
  },
  {
    judul: "Diundi Chainlink VRF",
    isi: "Begitu semua setor, pemenang ronde diundi dengan keacakan yang bisa diverifikasi siapa pun. Bukan Teko yang menentukan.",
  },
  {
    judul: "Hadiah cair",
    isi: "Pemenang terima hadiahnya ke rekening atau e-wallet. Punya wallet BNB Chain sendiri? Bisa langsung ke situ.",
  },
];

export default function HowItWorks() {
  return (
    <section className="section" id="cara-kerja">
      <div className="wrap">
        <div className="section-head">
          <Sunflower size={32} />
          <h2>Cara kerjanya</h2>
        </div>
        <p className="muted">
          Anggota cuma berurusan dengan chat dan rupiah. Bagian kriptonya
          disembunyikan, bukan dihilangkan.
        </p>
        <ol className="steps">
          {LANGKAH.map((l, i) => (
            <li className="card step" key={l.judul}>
              <span className="step-num">{i + 1}</span>
              <h3>{l.judul}</h3>
              <p>{l.isi}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
```

- [x] **Step 3: Pasang di halaman**

`web/app/page.jsx`:

```jsx
import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <Hero />
      <Gingham />
      <HowItWorks />
      <Gingham />
    </main>
  );
}
```

- [x] **Step 4: Periksa di browser**

Run: `pnpm run dev:web`

Buka `http://localhost:3000`. Pastikan empat kartu langkah tersusun rapi dan nomornya berada di lingkaran kuning bergaris tua. Perkecil jendela sampai selebar ponsel dan pastikan kartunya menumpuk jadi satu kolom tanpa ada yang terpotong. Hentikan dengan Ctrl+C.

- [x] **Step 5: Pastikan test dan build lolos**

Run: `pnpm run test:web && pnpm run build:web`
Expected: test PASS, build sukses.

- [x] **Step 6: Commit**

```bash
git add web/app/
git commit -m "feat(web): bagian cara kerjanya"
```

---

### Task 6: Bagian "Kenapa on-chain" dan penutup

**Files:**
- Create: `web/app/components/WhyOnchain.jsx`
- Create: `web/app/components/Footer.jsx`
- Modify: `web/app/globals.css`
- Modify: `web/app/page.jsx`

**Interfaces:**
- Consumes: `.card`, `.wrap`, `.section`, `<Sunflower />`
- Produces: komponen `<WhyOnchain />` dan `<Footer />`

- [x] **Step 1: Tambahkan gaya untuk daftar alasan dan penutup**

Tambahkan di akhir `web/app/globals.css`:

```css
.reasons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
  margin-top: 32px;
  list-style: none;
  padding: 0;
}

.reason {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.reason h3 {
  font-size: 1.05rem;
  margin-bottom: 6px;
}

.reason p {
  margin: 0;
  font-size: 0.95rem;
  color: var(--ink-soft);
}

.closing {
  background: var(--sun-200);
  border-top: 2px solid var(--ink);
}

.closing a {
  color: var(--ink);
}

.linkrow {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  margin-top: 20px;
  padding: 0;
  list-style: none;
  font-size: 0.95rem;
}
```

- [x] **Step 2: Buat komponen WhyOnchain**

`web/app/components/WhyOnchain.jsx`:

```jsx
import Sunflower from "./Sunflower";

const ALASAN = [
  {
    judul: "Bendaharanya kode",
    isi: "Setoran masuk ke smart contract, bukan ke rekening pribadi siapa pun. Nggak ada yang bisa diam-diam memakainya.",
  },
  {
    judul: "Undiannya bisa dibuktikan",
    isi: "Keacakan datang dari Chainlink VRF dan tercatat on-chain. Siapa pun boleh memeriksa bahwa undiannya tidak diatur.",
  },
  {
    judul: "Reputasi ikut ke mana-mana",
    isi: "Catatan tepat waktu, telat, dan gagal bayar menempel di anggotanya lintas semua arisan, bukan cuma satu grup.",
  },
  {
    judul: "Nggak perlu ngerti kripto",
    isi: "Anggota cuma pakai Telegram dan bayar pakai rupiah. Wallet-nya dibuatkan dan kuncinya dienkripsi.",
  },
];

export default function WhyOnchain() {
  return (
    <section className="section" id="kenapa">
      <div className="wrap">
        <div className="section-head">
          <Sunflower size={32} />
          <h2>Kenapa harus on-chain</h2>
        </div>
        <p className="muted">
          Masalah terbesar arisan bukan hitungannya, tapi kepercayaan ke orang
          yang pegang uangnya. Itu yang dipindahkan Teko ke kode.
        </p>
        <ul className="reasons">
          {ALASAN.map((a) => (
            <li className="card reason" key={a.judul}>
              <Sunflower size={26} />
              <div>
                <h3>{a.judul}</h3>
                <p>{a.isi}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [x] **Step 3: Buat komponen Footer**

`web/app/components/Footer.jsx`:

```jsx
export default function Footer() {
  return (
    <footer className="closing section">
      <div className="wrap">
        <h2>Coba sendiri</h2>
        <p>
          Teko jalan di BNB Chain Testnet. Undang botnya ke grup, ketik{" "}
          <strong>buat arisan 5 orang 200rb</strong>, dan lihat sendiri
          transaksinya muncul di BscScan.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href="https://t.me/tekoarisan_bot">
            Buka di Telegram
          </a>
        </div>
        <ul className="linkrow">
          <li>
            <a href="https://github.com/s-erzv/teko">Kode sumber</a>
          </li>
          <li>
            <a href="https://testnet.bscscan.com/">BNB Chain Testnet</a>
          </li>
          <li>
            <a href="https://docs.chain.link/vrf">Chainlink VRF</a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
```

- [x] **Step 4: Rangkai halaman lengkap**

`web/app/page.jsx`:

```jsx
import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import WhyOnchain from "./components/WhyOnchain";
import Footer from "./components/Footer";
import Gingham from "./components/Gingham";

export default function Home() {
  return (
    <main>
      <Hero />
      <Gingham />
      <HowItWorks />
      <Gingham />
      <WhyOnchain />
      <Footer />
    </main>
  );
}
```

- [x] **Step 5: Periksa di browser**

Run: `pnpm run dev:web`

Buka `http://localhost:3000` dan gulir dari atas sampai bawah. Pastikan urutannya hero, pita gingham, cara kerjanya, pita gingham, kenapa on-chain, lalu penutup kuning. Hentikan dengan Ctrl+C.

- [x] **Step 6: Pastikan test dan build lolos**

Run: `pnpm run test:web && pnpm run build:web`
Expected: test PASS, build sukses.

- [x] **Step 7: Commit**

```bash
git add web/app/
git commit -m "feat(web): bagian kenapa on-chain + penutup"
```

---

### Task 7: Responsif, aksesibilitas, dan deploy

**Files:**
- Modify: `web/app/globals.css`

**Interfaces:**
- Consumes: seluruh komponen dari Task 4 sampai 6
- Produces: situs ter-deploy dengan URL publik

- [x] **Step 1: Tambahkan pemolesan responsif dan perbaiki reduced-motion**

Tambahkan di akhir `web/app/globals.css`:

```css
/* Blok reduced-motion di awal berkas cuma memangkas DURASI transisi, jadi
   tombolnya tetap melompat saat disorot, cuma tanpa animasi -- yang justru
   lebih mengagetkan. Pergeserannya sendiri yang harus ditiadakan. */
@media (prefers-reduced-motion: reduce) {
  .btn:hover {
    transform: none;
    box-shadow: 0 4px 0 var(--ink);
  }
}

@media (max-width: 600px) {
  .btn {
    width: 100%;
    justify-content: center;
  }
  .card {
    padding: 20px;
  }
}

img,
svg {
  max-width: 100%;
}
```

- [x] **Step 2: Periksa di lebar ponsel**

Run: `pnpm run dev:web`

Buka `http://localhost:3000`, kecilkan jendela sampai sekitar 380px. Pastikan tidak ada gulir mendatar sama sekali, tombolnya melebar penuh, dan semua kartu jadi satu kolom. Tekan Tab dan pastikan cincin fokus terlihat jelas di tiap tautan dan tombol. Hentikan dengan Ctrl+C.

- [x] **Step 3: Periksa dengan gerak dimatikan**

Di DevTools, buka Rendering lalu setel `prefers-reduced-motion` ke `reduce`. Muat ulang halaman dan pastikan tombol benar-benar diam saat disorot, tidak bergeser sama sekali.

- [x] **Step 4: Jalankan seluruh test repo**

Run:

```bash
pnpm run test
forge test
```

Expected: test bot 25 PASS, test web 5 PASS, test Foundry 26 PASS.

- [x] **Step 5: Commit**

```bash
git add web/app/
git commit -m "feat(web): responsif ponsel, lompat-ke-konten, hormati reduced-motion"
```

- [ ] **Step 6: Deploy ke Netlify**

Lewat dashboard Netlify, hubungkan repo `s-erzv/teko`. Netlify membaca `netlify.toml`, jadi perintah build dan direktori publish tidak perlu diisi manual. Biarkan base directory kosong supaya build jalan dari root repo.

Setelah deploy pertama selesai, buka URL yang diberikan dan pastikan halamannya tampil sama seperti di lokal.

- [ ] **Step 7: Commit apa pun yang berubah saat deploy**

```bash
git status
# kalau ada perubahan (mis. lockfile), commit:
git add -A
git commit -m "build: penyesuaian setelah deploy Netlify pertama"
```

---

## Self-Review

**Cakupan spec.** Bagian "Desain visual" di spec tercakup Task 2 sampai 7:
palet dan warna tinta di Task 2, motif taplak dan golden hour dan bunga
matahari di Task 3, empat bagian halaman di Task 4 sampai 6, reduced-motion di
Task 2 dan 7. Bagian "Struktur repo" tercakup Task 1, termasuk `.npmrc`
`node-linker=hoisted` dan pilihan pnpm. Bagian "Rencana pengujian" tercakup
sebagian: uji kontras ada di Task 2, dan 25 test bot dijalankan ulang di Task 7.
Sisa rencana pengujian (kunci on-chain, `secret_token` Telegram,
`pending_creations`) milik Rencana 2, bukan rencana ini.

**Yang sengaja TIDAK ada di rencana ini**, dan semuanya masuk Rencana 2:
lima Netlify Function, tabel `pending_creations` dan `chain_locks`, perubahan
`config.js` dan `notifier.js`, pemecahan `index.js`, `ensureApproval()` keluar
dari jalur boot, dan variabel `TELEGRAM_WEBHOOK_SECRET` serta `WORKER_SECRET`.

**Konsistensi nama.** `teko-web` dipakai konsisten di `web/package.json`
dan di semua skrip root. Token `--sun-100` sampai `--sun-600`, `--ink`,
`--ink-soft`, `--paper` dipakai dengan ejaan sama di CSS, test, dan komponen.
Komponen `Sunflower` dan `Gingham` dibuat di Task 3 lalu dipakai dengan nama
dan prop yang sama di Task 4 sampai 6.

**Satu hal yang perlu diisi pelaksana.** URL bot di Task 4 dan Task 6 ditulis
`https://t.me/tekoarisan_bot`, diambil dari nilai bawaan `BOT_USERNAME` di
`bot/src/index.js`. Kalau username bot sungguhan berbeda, ganti di kedua
tempat. Tautan BscScan sengaja menunjuk ke akar testnet karena alamat kontrak
hasil deploy belum tetap; ganti ke alamat kontrak begitu deploy final.
