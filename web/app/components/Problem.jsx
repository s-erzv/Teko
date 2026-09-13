import Sunflower from "./Sunflower";

/**
 * Alasan Teko perlu ada, ditaruh paling awal: masalahnya dulu, baru
 * jawabannya. Sengaja dua kolom berhadapan (bukan kartu lagi) supaya
 * strukturnya sendiri yang membawa informasi -- ini perbandingan, bukan
 * daftar butir yang setara.
 */
const PAIRS = [
  {
    before: "One person holds everyone's money in their personal account.",
    after: "A smart contract holds it. Nobody can spend what isn't theirs.",
  },
  {
    before: "The draw happens in someone's living room. You trust whoever shuffles.",
    after: "Chainlink VRF draws the winner, on-chain, where anyone can check it.",
  },
  {
    before: "Chasing a late payment means nagging a friend in the group chat.",
    after: "A late fee applies itself, per day. Nobody has to be the bad guy.",
  },
  {
    before: "Records live in a notebook, and end when the group falls apart.",
    after: "Every payment, draw, and payout is recorded permanently.",
  },
];

export default function Problem() {
  return (
    <section className="section" id="problem">
      <div className="wrap">
        <header className="section-head">
          <h2>
            <Sunflower size={30} className="section-mark" />
            Arisan already works. Until it doesn&rsquo;t.
          </h2>
          <p className="section-intro">
            A savings circle only holds together while everyone trusts the
            person holding the pot. That one person is the whole risk — and
            when it breaks, it takes the friendships with it.
          </p>
        </header>

        <div className="compare">
          <div className="compare-col compare-before">
            <h3>Arisan today</h3>
            <ul>
              {PAIRS.map((p) => (
                <li key={p.before}>{p.before}</li>
              ))}
            </ul>
          </div>
          <div className="compare-col compare-after">
            <h3>Arisan with Teko</h3>
            <ul>
              {PAIRS.map((p) => (
                <li key={p.after}>{p.after}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
