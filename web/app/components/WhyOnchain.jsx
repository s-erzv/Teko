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
