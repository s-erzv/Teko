"use client";

import { useEffect, useState } from "react";
import Logo from "./Logo";
import { BOT_URL } from "../links";

const REDIRECT_SECS = 3;

/**
 * Halaman pendaratan setelah user kembali dari Xendit.
 *
 * Bahasanya sengaja INDONESIA walau sisa situs ini Inggris: landing page
 * ditulis untuk juri, sedangkan halaman ini cuma dilihat anggota arisan yang
 * barusan bayar -- orang yang sama yang ngobrol sama botnya dalam bahasa
 * Indonesia. Konsisten sama pembacanya lebih penting daripada konsisten sama
 * halaman sebelahnya.
 *
 * Yang sukses TIDAK mengklaim "pembayaran berhasil dicatat", cuma "diterima":
 * waktu Xendit memantulkan user ke sini, kredit on-chain-nya sering belum
 * kelar (jalannya lewat webhook, terpisah dari redirect ini). Konfirmasi yang
 * sebenarnya dikirim bot ke Telegram begitu transaksinya masuk.
 */
export default function PaymentReturn({ variant }) {
  const ok = variant === "success";
  // Yang gagal TIDAK dialihkan otomatis. Yang sukses gak ada yang perlu
  // dibaca -- konfirmasinya nyusul di Telegram -- tapi yang gagal justru
  // harus sempat baca kenapa, sebelum balik dan nyoba lagi.
  const [left, setLeft] = useState(ok ? REDIRECT_SECS : null);

  useEffect(() => {
    if (!ok) return;
    const tick = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    const go = setTimeout(() => {
      window.location.href = BOT_URL;
    }, REDIRECT_SECS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(go);
    };
  }, [ok]);

  return (
    <main className="goldenhour payreturn" id="content">
      <div className="wrap">
        <Logo size={56} />
        <h1>{ok ? "Pembayaran diterima" : "Pembayaran belum selesai"}</h1>
        <p className="lead">
          {ok
            ? "Setoran kamu lagi dicatat ke smart contract. Konfirmasinya dikirim ke Telegram sebentar lagi — nggak perlu bayar ulang."
            : "Pembayaranmu nggak jadi diproses, dan nggak ada dana yang terpotong. Balik ke Telegram, lalu ulangi dari tombol setoran di sana."}
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href={BOT_URL}>
            Buka Telegram
          </a>
        </div>
        {ok && (
          // aria-live off: hitungan mundurnya cuma info tambahan, dan kalau
          // dibacakan tiap detik malah ganggu pengguna screen reader.
          <p className="payreturn-note" aria-live="off">
            {left > 0
              ? `Membuka otomatis dalam ${left} detik…`
              : "Membuka Telegram…"}
          </p>
        )}
      </div>
    </main>
  );
}
