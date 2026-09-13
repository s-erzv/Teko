import Icon from "./Icon";
import Sunflower from "./Sunflower";

/**
 * Tiap langkah diberi "stamp": potongan bukti nyata di kaki kartu (balasan
 * bot, logo pembayaran, hash VRF, konfirmasi transfer). Deskripsi saja
 * membuat keempat kartu terasa seragam; stamp bikin tiap langkah punya
 * benda yang bisa dilihat.
 */
const STEPS = [
  {
    icon: "users",
    title: "Create it in the group",
    body: "Type \"create a savings circle, 5 people, 200k\" in the Telegram group. Teko sets it up on-chain and asks for anything you left out.",
    stamp: {
      head: "Teko bot",
      text: "“Arisan created — 5 slots, Rp200k/month. Tap to join.”",
    },
  },
  {
    icon: "link",
    title: "Pay in rupiah",
    body: "Each member gets a private payment link. Pay with a regular bank transfer or e-wallet — Teko handles the on-chain side.",
    stamp: { head: "Accepted", chips: ["QRIS", "Bank transfer", "E-wallet"] },
  },
  {
    icon: "shuffle",
    title: "Drawn with Chainlink VRF",
    body: "Once everyone's paid, the round's winner is drawn with randomness anyone can verify. Teko doesn't decide it.",
    stamp: { head: "VRF request", text: "Seed and result both land on-chain." },
  },
  {
    icon: "wallet",
    title: "Payout lands",
    body: "The winner gets paid out to a bank account or e-wallet. Already have a BNB Chain wallet? It can go straight there instead.",
    stamp: { head: "Round 1 paid", text: "Rp1,000,000 sent to the winner." },
  },
];

export default function HowItWorks() {
  return (
    <section className="section" id="how-it-works">
      <div className="wrap">
        <header className="section-head">
          <h2>
            <Sunflower size={30} className="section-mark" />
            How <span className="accent-underline">it works</span>
          </h2>
          <div>
            <p className="section-intro">
              Members only ever deal with chat and rupiah. The crypto is
              hidden, not removed.
            </p>
            <p className="doodle doodle-inline">
              simple as that! <Icon name="flower" size={18} />
            </p>
          </div>
        </header>

        <ol className="steps">
          {STEPS.map((s, i) => (
            <li
              className={`card step ticket-edge step-tone-${i + 1}`}
              key={s.title}
            >
              <div className="step-top">
                <span className="step-num">{`0${i + 1}`}</span>
                <span className="step-icon">
                  <Icon name={s.icon} size={20} />
                </span>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>

              <div className="stamp">
                <span className="stamp-head">
                  <Icon name="spark" size={13} />
                  {s.stamp.head}
                </span>
                {s.stamp.chips ? (
                  <span className="chip-row">
                    {s.stamp.chips.map((c) => (
                      <span className="chip" key={c}>
                        {c}
                      </span>
                    ))}
                  </span>
                ) : (
                  <p>{s.stamp.text}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
