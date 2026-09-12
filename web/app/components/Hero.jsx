import Sunflower from "./Sunflower";
import { BOT_URL, CONTRACT_URL } from "../links";

export default function Hero() {
  return (
    <section className="goldenhour section">
      <div className="wrap">
        <div className="wordmark">
          <Sunflower size={40} />
          <span>Teko</span>
        </div>
        <h1>
          {/* JSX membuang whitespace di sekitar elemen yang berdiri di baris
              sendiri, jadi spasi ini harus ditulis eksplisit: tanpa itu,
              begitu <br> disembunyikan di ponsel kedua kata menempel jadi
              "yangnggak". */}
          Bendahara arisan yang{" "}
          <br className="br-lebar" />
          nggak bisa kabur bawa uang.
        </h1>
        <p className="lead">
          Teko mengurus arisan grup kamu lewat Telegram. Uangnya ditahan smart
          contract di BNB Chain, pemenang tiap ronde diundi Chainlink VRF, dan
          anggota nggak perlu punya wallet kripto sama sekali.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href={BOT_URL}>
            Buka di Telegram
          </a>
          <a className="btn btn-secondary" href={CONTRACT_URL} rel="noopener">
            Lihat kontraknya
          </a>
        </div>
      </div>
    </section>
  );
}
