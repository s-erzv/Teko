import localFont from "next/font/local";
import Navbar from "./components/Navbar";
import "./globals.css";

// Fraunces (judul) & Inter (isi), keduanya variable font subset latin dan
// disimpan langsung di app/fonts. Sengaja next/font/local, BUKAN
// next/font/google: yang versi Google mengunduh font saat build, jadi build
// ikut gagal setiap kali jaringan ke fonts.gstatic.com bermasalah -- itu
// pernah kejadian dan memblokir build di sini. File lokal bikin build
// deterministik, offline-friendly, dan lebih cepat.
// Catatan kecil ala tulisan tangan (--font-hand di globals.css) memakai
// fallback cursive sistem, tidak menambah berkas font lagi.
const fraunces = localFont({
  src: "./fonts/fraunces-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-body",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "sans-serif"],
});

export const metadata = {
  title: "Teko — On-Chain Savings Circle Treasurer",
  description:
    "A Telegram savings circle with funds held in a BNB Chain smart contract and winners drawn by Chainlink VRF. Members don't need a crypto wallet.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        <a className="skiplink" href="#content">
          Skip to content
        </a>
        <Navbar />
        {children}
      </body>
    </html>
  );
}
