/**
 * Parser jawaban bebas dari user (alur tanya-jawab "buat arisan").
 *
 * Dipisah dari index.js supaya bisa dites tanpa mengimpor index.js — file itu
 * memanggil main() begitu diimpor, yang artinya menyalakan bot beneran.
 */

/** Angka pertama di dalam teks. null kalau tidak ada. */
export function parseInt10(text) {
  const m = String(text).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Nominal Rupiah dari teks bebas: "200rb", "1.5jt", "1.000.000", "200 ribu".
 * null kalau tidak ada angka yang kebaca.
 */
export function parseRupiah(text) {
  const t = String(text).toLowerCase();
  // Satuan nempel langsung ke angka (mis. "200rb", "1.5jt") jadi TIDAK boleh
  // pakai \b sebelum satuan -- digit dan huruf sama-sama \w, jadi gak ada
  // word-boundary di antara "200" dan "rb".
  const withUnit = t.match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/);
  if (withUnit) {
    // Ada satuan -> titik/koma di sini pasti desimal, mis. "1.5jt",
    // bukan pemisah ribuan, jadi JANGAN di-strip sebelum parseFloat.
    let n = parseFloat(withUnit[1].replace(",", "."));
    if (["rb", "ribu", "k"].includes(withUnit[2])) n *= 1000;
    else n *= 1_000_000;
    return Math.round(n) || null;
  }
  // Gak ada satuan -> anggap titik/koma itu pemisah ribuan gaya Rupiah
  // (mis. "1.000.000"), jadi aman di-strip semua.
  const numMatch = t.match(/[\d.,]+/);
  if (!numMatch) return null;
  const n = parseInt(numMatch[0].replace(/[.,]/g, ""), 10);
  return n || null;
}

/** Jawaban siklus: jumlah hari, "default", atau null kalau gak kebaca. */
export function parseCycleAnswer(text) {
  const t = String(text).toLowerCase();
  if (/default|standar|biasa|terserah|gpp|gapapa/.test(t)) return "default";
  if (/minggu/.test(t)) return 7;
  if (/bulan/.test(t)) return 30;
  return parseInt10(t);
}

/** Jawaban cara undi. Apa pun selain kata kunci upfront dianggap per-ronde. */
export function parseDrawModeAnswer(text) {
  return /upfront|awal|sekali/i.test(text) ? "upfront" : "percycle";
}
