import Icon from "./Icon";
import Sunflower from "./Sunflower";

/**
 * Fitur nyata Teko (bukan sekadar tautan repo), diambil langsung dari
 * kapabilitas bot: bot/src/config.js (denda, exit penalty, voting window,
 * draw mode, cron sweep) dan bot/src/index.js (command /reputasi,
 * /tutup_paksa, /draw, /denda, parser bahasa natural via Groq).
 */
const FEATURES = [
  {
    icon: "chat",
    title: "Type it in chat",
    body: "No form to fill. Teko reads “create a savings circle, 5 people, 200k” and asks for anything missing.",
  },
  {
    icon: "bell",
    title: "Reminders & late fees, automatic",
    body: "A background sweep checks every active circle's deadline and applies a late penalty per day — no one has to chase anyone.",
  },
  {
    icon: "vote",
    title: "Fair exit needs a vote",
    body: "Force-closing a circle needs the group to agree within a voting window, not one member's call — leaving after a win costs more.",
  },
  {
    icon: "shuffle",
    title: "Two ways to draw",
    body: "PerCycle reshuffles the queue every round; Upfront locks the order once at the start. Pick whichever your group trusts more.",
  },
  {
    icon: "refresh",
    title: "Money always lands",
    body: "A recovery sweep retries stuck on-chain credits and catches up any missed draw, so a network hiccup never loses a payment.",
  },
  {
    icon: "users",
    title: "Reputation follows you",
    body: "/reputasi shows on-time, late, and missed history — visible across every circle a member joins, not just one group.",
  },
];

export default function Features() {
  return (
    <section className="section section-cream" id="features">
      <div className="wrap">
        <header className="section-head">
          <h2>
            <Sunflower size={30} className="section-mark" />
            What Teko <span className="accent-underline">actually does</span>
          </h2>
          <p className="section-intro">
            Not just a repo link — six things the bot handles on its own,
            every round, without anyone in the group having to remember
            them.
          </p>
        </header>
        <ul className="feature-list">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="feature-list-icon">
                <Icon name={f.icon} size={17} />
              </span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
