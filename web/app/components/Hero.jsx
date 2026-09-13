import Icon from "./Icon";
import Sunflower from "./Sunflower";
import { BOT_URL, CONTRACT_URL } from "../links";

/** Tiga keberatan pertama yang muncul di kepala pembaca, dijawab sebelum
 *  sempat ditanyakan. */
const PROOF = [
  "No wallet setup needed",
  "Rupiah in, rupiah out",
  "Chainlink VRF draws the winner",
];

export default function Hero() {
  return (
    <section className="goldenhour section hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="badge">
            <Sunflower size={15} />
            Telegram arisan · BNB Chain
          </span>
          <h1>
            A savings circle treasurer that can&rsquo;t run off with the{" "}
            <span className="hero-highlight">
              money.
              <Icon name="spark" size={22} className="hero-spark" />
            </span>
          </h1>
          <p className="lead">
            Teko runs your group&rsquo;s savings circle right inside Telegram.
            Funds are held in a BNB Chain smart contract, each round&rsquo;s
            winner is drawn with Chainlink VRF, and members never need a
            crypto wallet of their own.
          </p>
          <div className="btn-row">
            <a className="btn btn-primary" href={BOT_URL}>
              Open in Telegram
            </a>
            <a
              className="btn btn-secondary"
              href={CONTRACT_URL}
              rel="noopener"
            >
              View the contract
            </a>
          </div>
          <ul className="proof-row">
            {PROOF.map((p) => (
              <li key={p}>
                <span className="proof-dot" aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
        </div>

        <div className="hero-visual">
          <p className="doodle doodle-hero">good savings ☀</p>
          <div className="ticket ticket-hero">
            <span className="washi-tape" aria-hidden="true" />
            <div className="ticket-row">
              <span className="ticket-brand">TEKO</span>
              <span className="ticket-no">No. 001</span>
            </div>
            <p className="ticket-line">Arisan Kantor</p>
            <p className="ticket-sub">
              5 members · one collects every round
            </p>

            <div className="ticket-specs">
              <div>
                <span className="spec-label">Round</span>
                <span className="spec-value">01 of 05</span>
              </div>
              <div>
                <span className="spec-label">Each pays</span>
                <span className="spec-value">Rp200,000</span>
              </div>
              <div>
                <span className="spec-label">Pot this round</span>
                <span className="spec-value">Rp1,000,000</span>
              </div>
              <div>
                <span className="spec-label">Draw</span>
                <span className="spec-value">once all 5 pay</span>
              </div>
            </div>

            <p className="ticket-status">
              <span>
                <span className="proof-dot" aria-hidden="true" />
                Held by the contract
              </span>
              <span>Not by a person</span>
            </p>

            <div className="ticket-divider" aria-hidden="true" />
            <div className="ticket-row ticket-foot">
              <span className="barcode" aria-hidden="true" />
              <span className="ticket-tag">
                <span className="ticket-diamond" aria-hidden="true" />
                BNB CHAIN
                <br />
                POWERED
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
