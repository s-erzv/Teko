import PaymentReturn from "../components/PaymentReturn";

// success_redirect_url punya Xendit menunjuk ke sini (lihat bot/src/xendit.js).
export const metadata = {
  title: "Pembayaran diterima — Teko",
  // Halaman pendaratan pembayaran nggak ada gunanya di hasil pencarian, dan
  // bikin bingung kalau muncul di sana lepas dari alur bayarnya.
  robots: { index: false, follow: false },
};

export default function Selesai() {
  return <PaymentReturn variant="success" />;
}
