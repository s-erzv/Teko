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
