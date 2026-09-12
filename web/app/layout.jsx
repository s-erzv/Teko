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
