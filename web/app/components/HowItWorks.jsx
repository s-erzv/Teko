import Sunflower from "./Sunflower";

const LANGKAH = [
  {
    judul: "Bikin di grup",
    isi: "Ketik \"buat arisan 5 orang 200rb\" di grup Telegram. Teko bikin grupnya di smart contract dan nanya sisanya kalau ada yang belum disebut.",
  },
  {
    judul: "Setor pakai rupiah",
    isi: "Tiap anggota dapat link pembayaran privat. Bayar pakai bank atau e-wallet biasa. Teko yang mengurus sisi on-chain-nya.",
  },
  {
    judul: "Diundi Chainlink VRF",
    isi: "Begitu semua setor, pemenang ronde diundi dengan keacakan yang bisa diverifikasi siapa pun. Bukan Teko yang menentukan.",
  },
  {
    judul: "Hadiah cair",
    isi: "Pemenang terima hadiahnya ke rekening atau e-wallet. Punya wallet BNB Chain sendiri? Bisa langsung ke situ.",
  },
];

export default function HowItWorks() {
  return (
    <section className="section" id="cara-kerja">
      <div className="wrap">
        <div className="section-head">
          <Sunflower size={32} />
          <h2>Cara kerjanya</h2>
        </div>
        <p className="muted">
          Anggota cuma berurusan dengan chat dan rupiah. Bagian kriptonya
          disembunyikan, bukan dihilangkan.
        </p>
        <div className="gingham blanket">
          <ol className="steps">
            {LANGKAH.map((l, i) => (
              <li className="card step" key={l.judul}>
                <span className="step-num">{i + 1}</span>
                <h3>{l.judul}</h3>
                <p>{l.isi}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
