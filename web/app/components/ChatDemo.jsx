import Logo from "./Logo";
import Icon from "./Icon";
import Sunflower from "./Sunflower";

/** Jalur uangnya, ditaruh berdampingan dengan transkrip: yang di kiri
 *  adalah yang dilihat anggota, yang di kanan adalah yang sebenarnya
 *  terjadi di belakangnya. */
const FLOW = [
  { icon: "chat", label: "Chat", note: "Telegram group" },
  { icon: "link", label: "Pay", note: "bank / e-wallet" },
  { icon: "cube", label: "Smart contract", note: "BNB Chain escrow" },
  { icon: "shuffle", label: "Draw", note: "Chainlink VRF" },
  { icon: "wallet", label: "Payout", note: "back to rupiah" },
];

/**
 * Transkrip grup Telegram yang realistis, bukan tiket/kartu lagi -- ini
 * artefak paling khas dari produk Teko (semuanya memang terjadi di chat).
 * Menggantikan section "See it in action" versi kartu: alur yang sama
 * (setup, join, bayar, telat kena denda, menang lewat VRF, coba keluar
 * kena exit-fee + butuh vote) didramatisasi sebagai percakapan beneran.
 */
const PEOPLE = {
  budi: { name: "Budi", tone: "tone-1" },
  sari: { name: "Sari", tone: "tone-2" },
  made: { name: "Made", tone: "tone-3" },
  deni: { name: "Deni", tone: "tone-4" },
};

const THREAD = [
  { from: "budi", text: "create a savings circle, 5 people, 200k" },
  {
    from: "bot",
    text: "Got it — 5 people, Rp200,000/month. Who's joining? Tap Join or reply with @usernames.",
  },
  { system: "Sari, Made, Deni, and Wulan joined." },
  {
    from: "bot",
    text: "All 5 in. Round 1 payment links are in your DMs — pay by the 5th.",
  },
  { system: "💰 4 / 5 paid" },
  { from: "made", text: "sorry, running late — paying now" },
  {
    from: "bot",
    text: "No worries. A Rp5,000/day late fee kicked in automatically and gets added to your next round.",
  },
  { system: "💰 5 / 5 paid — drawing the winner" },
  {
    from: "bot",
    text: "🎉 Chainlink VRF drew Sari for Round 1. Rp970,000 sent to her bank account.",
  },
  { from: "sari", text: "omg it's already in my account, thank you!!" },
  { from: "deni", text: "since sari already won, can i just drop out now" },
  {
    from: "bot",
    text: "You can leave, but it costs more once someone's been paid out — and closing the whole circle needs 3 of 5 votes, not just yours.",
  },
];

const NOTES = [
  {
    title: "Plain language in, on-chain group out",
    body: "No forms, no wallet setup, no seed phrase. One sentence in the group creates a real contract-backed circle.",
  },
  {
    title: "The late fee is the bot's job",
    body: "Made's Rp5,000/day starts on its own. Nobody in the group has to be the one who nags.",
  },
  {
    title: "The draw was never Teko's call",
    body: "Chainlink VRF picks Sari, and the proof sits on BscScan for anyone in the group to open.",
  },
  {
    title: "Leaving has rules, and they hold",
    body: "Deni can go, but the exit fee and the 3-of-5 vote are enforced by the contract, not by argument.",
  },
];

export default function ChatDemo() {
  return (
    <section className="section section-cream" id="in-the-chat">
      <div className="wrap">
        <header className="section-head">
          <h2>
            <Sunflower size={30} className="section-mark" />
            It&rsquo;s just a{" "}
            <span className="accent-underline">group chat</span>
          </h2>
          <p className="section-intro">
            One real thread — setup, a late payment, a payout, and someone
            trying to bail. No dashboard, no wallet, no app to install.
            This is the whole product.
          </p>
        </header>
        <div className="chat-layout">
          <div className="chat-mock">
          <div className="chat-mock-head">
            <Logo size={22} />
            <div>
              <div className="chat-mock-title">Kantor Squad</div>
              <div className="chat-mock-sub">5 members · Teko added</div>
            </div>
          </div>
          <div className="chat-mock-body">
            {THREAD.map((m, i) =>
              m.system ? (
                <p className="chat-system" key={i}>
                  {m.system}
                </p>
              ) : (
                <div className="chat-msg" key={i}>
                  {m.from === "bot" ? (
                    <span className="chat-avatar chat-avatar-bot">
                      <Logo size={16} />
                    </span>
                  ) : (
                    <span className={`chat-avatar ${PEOPLE[m.from].tone}`}>
                      {PEOPLE[m.from].name[0]}
                    </span>
                  )}
                  <div className="chat-msg-content">
                    <div className="chat-msg-name">
                      {m.from === "bot" ? "Teko" : PEOPLE[m.from].name}
                    </div>
                    <p className={`chat-bubble${m.from === "bot" ? " bot" : ""}`}>
                      {m.text}
                    </p>
                  </div>
                </div>
              )
            )}
          </div>
        </div>

          <div className="chat-side">
            <ol className="flow-rail" aria-label="Where the money goes">
              {FLOW.map((f) => (
                <li key={f.label}>
                  <span className="flow-icon">
                    <Icon name={f.icon} size={18} />
                  </span>
                  <span>
                    <span className="flow-label">{f.label}</span>
                    <span className="flow-note">{f.note}</span>
                  </span>
                </li>
              ))}
            </ol>

            <ul className="chat-notes">
              {NOTES.map((n) => (
                <li key={n.title}>
                  <h3>{n.title}</h3>
                  <p>{n.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
