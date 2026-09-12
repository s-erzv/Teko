import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** CSS-nya yang jadi sumber kebenaran, sama seperti uji kontras. */
const css = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8"
);

/** Posisi karakter aturan pertama yang cocok, atau -1. */
function posisi(pola) {
  const m = css.match(pola);
  return m ? m.index : -1;
}

test("tombol punya keadaan hover yang menggeser posisinya", () => {
  assert.ok(
    /\.btn:hover\s*\{[^}]*transform:\s*translateY/.test(css),
    "aturan .btn:hover dengan translateY tidak ditemukan"
  );
});

test("reduced-motion meniadakan pergeseran, bukan cuma durasinya", () => {
  // Memangkas transition-duration saja tidak cukup: tombolnya tetap
  // melompat, hanya tanpa animasi, yang justru lebih mengagetkan.
  const blok = css.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g
  );
  assert.ok(blok, "tidak ada blok @media prefers-reduced-motion");
  const adaOverride = blok.some(
    (b) => /\.btn:hover/.test(b) && /transform:\s*none/.test(b)
  );
  assert.ok(
    adaOverride,
    "tidak ada blok reduced-motion yang menyetel .btn:hover { transform: none }"
  );
});

test("override reduced-motion ditulis SETELAH aturan hover dasarnya", () => {
  // Specificity .btn:hover sama di kedua tempat dan @media tidak menambah
  // specificity apa pun, jadi yang menang murni ditentukan urutan berkas.
  // Kalau blok reduced-motion pindah ke atas, override-nya kalah diam-diam
  // tanpa ada yang error -- justru itu yang dijaga assertion ini.
  const dasar = posisi(/\.btn:hover\s*\{[^}]*transform:\s*translateY/);
  const override = posisi(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*?\.btn:hover\s*\{[^}]*transform:\s*none/
  );
  assert.notEqual(dasar, -1, "aturan hover dasar tidak ditemukan");
  assert.notEqual(override, -1, "override reduced-motion tidak ditemukan");
  assert.ok(
    override > dasar,
    `override di posisi ${override} mendahului aturan dasar di ${dasar}, jadi tidak akan berlaku`
  );
});

test("tautan lompat-ke-konten tidak pernah display:none", () => {
  // display:none membuatnya hilang dari urutan Tab sepenuhnya, jadi
  // pengguna keyboard tidak akan pernah bisa memakainya. Sembunyikan
  // dengan memindahkannya ke luar layar, bukan dengan menghapusnya.
  const blok = css.match(/\.skiplink\s*\{[^}]*\}/);
  assert.ok(blok, "aturan .skiplink tidak ditemukan");
  assert.doesNotMatch(blok[0], /display:\s*none/);
  assert.match(blok[0], /position:\s*absolute/);
});
