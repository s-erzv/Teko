import Logo from "./Logo";
import Sunflower from "./Sunflower";
import { BOT_URL, CONTRACT_URL, REPO_URL, VRF_DOCS_URL } from "../links";

/** Lima anggota yang sama dengan transkrip di ChatDemo, supaya skemanya
 *  terbaca sebagai kelanjutan cerita yang sama, bukan contoh baru. */
const ROUNDS = [
  { who: "S", name: "Sari", tone: "tone-2" },
  { who: "B", name: "Budi", tone: "tone-1" },
  { who: "W", name: "Wulan", tone: "tone-5" },
  { who: "M", name: "Made", tone: "tone-3" },
  { who: "D", name: "Deni", tone: "tone-4" },
];

export default function Footer() {
  return (
    <footer className="closing section gingham-bg" id="try-it-yourself">
      <div className="wrap">
        <div className="closing-grid">
          <div className="schema card">
            <h2>
              <Sunflower size={28} className="section-mark" />
              Five friends, five rounds, everyone collects once
            </h2>
            <p>
              Each round every member pays in, and one of them takes the pot.
              Win a round and you&rsquo;re out of the draw, still paying in,
              until the last person has been paid. Then the circle is square
              and can start again.
            </p>
            <ol className="cycle">
              {ROUNDS.map((r, i) => (
                <li className="cycle-node" key={r.name}>
                  <span className={`cycle-avatar ${r.tone}`}>{r.who}</span>
                  <span className="cycle-round">Round {i + 1}</span>
                  <span className="cycle-name">{r.name} collects</span>
                </li>
              ))}
            </ol>
            <p className="cycle-note">
              Rp200,000 in each month · Rp1,000,000 out on your round
            </p>
          </div>

          <div>
            <div className="ticket ticket-cta">
              <span className="washi-tape washi-tape-cta" aria-hidden="true" />
              <h2>Join the circle</h2>
              <p>
                Teko runs on BNB Chain Testnet. Add the bot to a group, type{" "}
                <strong>create a savings circle, 5 people, 200k</strong>, and
                watch the transaction show up on BscScan.
              </p>
              <div className="btn-row">
                <a className="btn btn-primary" href={BOT_URL}>
                  Open in Telegram
                </a>
              </div>
              <p className="ticket-fineprint">
                Free to try · testnet rupiah · no gas tokens needed
              </p>
            </div>
            <p className="doodle doodle-cta">same goals, bigger dreams ♥</p>
          </div>
        </div>

        <div className="closing-foot">
          <div className="closing-brand">
            <span className="wordmark">
              <Logo size={26} />
              <span>Teko</span>
            </span>
            <p>
              A savings circle treasurer that can&rsquo;t run off with the
              money. Built for friend groups, settled on BNB Chain.
            </p>
          </div>
          <ul className="linkrow">
            <li>
              <a href={BOT_URL}>Telegram bot</a>
            </li>
            <li>
              <a href={REPO_URL}>Source code</a>
            </li>
            <li>
              <a href={CONTRACT_URL}>Contract on BscScan</a>
            </li>
            <li>
              <a href={VRF_DOCS_URL}>Chainlink VRF</a>
            </li>
          </ul>
        </div>

        <p className="closing-note">
          BNB Chain Testnet · IDRX · good things grow together 🌻
        </p>
      </div>
    </footer>
  );
}
