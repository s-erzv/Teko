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

test("tinta lembut hanya atas kertas, lolos ambang 4.5:1", () => {
  // --ink-soft dipakai untuk teks sekunder hanya di atas --paper.
  // Kalau desain masa depan memakai --ink-soft di atas warna sun-*,
  // assertion ini harus diperluas untuk cover latar yang baru itu.
  const t = readTokens();
  const rasio = contrastRatio(t["ink-soft"], t["paper"]);
  assert.ok(
    rasio >= 4.5,
    `--ink-soft di atas --paper cuma ${rasio.toFixed(2)}:1, di bawah ambang 4.5`
  );
});

test("putih di atas oranye TIDAK lolos -- ini alasan --ink harus ada", () => {
  const t = readTokens();
  const rasio = contrastRatio("#ffffff", t["sun-600"]);
  assert.ok(
    rasio < 4.5,
    "Kalau test ini gagal, palet berubah dan larangan teks putih perlu ditinjau ulang."
  );
});
