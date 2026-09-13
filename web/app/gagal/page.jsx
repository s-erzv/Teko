import PaymentReturn from "../components/PaymentReturn";

// failure_redirect_url punya Xendit menunjuk ke sini (lihat bot/src/xendit.js).
export const metadata = {
  title: "Pembayaran belum selesai — Teko",
  robots: { index: false, follow: false },
};

export default function Gagal() {
  return <PaymentReturn variant="failure" />;
}
