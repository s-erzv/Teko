import Sunflower from "./Sunflower";
import { BOT_URL, CONTRACT_URL } from "../links";

export default function Hero() {
  return (
    <section className="goldenhour section">
      <div className="wrap">
        <Sunflower size={56} />
        <h1>
          Bendahara arisan yang
          <br />
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
