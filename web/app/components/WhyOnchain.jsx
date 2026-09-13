import Icon from "./Icon";
import Sunflower from "./Sunflower";

const REASONS = [
  {
    icon: "shield",
    badge: "Non-custodial",
    title: "Code is the treasurer",
    body: "Payments go into a smart contract, not anyone's personal account. No one can quietly spend it.",
    foot: "Rules enforced by the contract, not by group pressure",
  },
  {
    icon: "cube",
    badge: "Verifiable",
    title: "The draw is provable",
    body: "Randomness comes from Chainlink VRF and is recorded on-chain. Anyone can check that the draw wasn't rigged.",
    foot: "No slips of paper in a cup, no trusting the shuffler",
  },
  {
    icon: "users",
    badge: "Portable",
    title: "Reputation travels with you",
    body: "A record of on-time, late, and missed payments follows each member across every circle, not just one group.",
    foot: "A payment history you can bring to the next circle",
  },
  {
    icon: "lock",
    badge: "No gas, no wallet",
    title: "No crypto knowledge needed",
    body: "Members just use Telegram and pay in rupiah. A wallet is created for them and its key stays encrypted.",
    foot: "Keys are encrypted with AWS KMS, never stored in the clear",
  },
];

export default function WhyOnchain() {
  return (
    <section className="section section-alt" id="why-onchain">
      <div className="wrap">
        <header className="section-head">
          <h2>
            <Sunflower size={30} className="section-mark" />
            Why <span className="accent-underline">on-chain</span>
          </h2>
          <p className="section-intro">
            The hard part of a savings circle was never the math — it&rsquo;s
            trusting whoever&rsquo;s holding the money. Teko moves that trust
            into code.
          </p>
        </header>

        <ul className="reasons">
          {REASONS.map((r) => (
            <li className="card reason ticket-edge" key={r.title}>
              <div className="reason-top">
                <span className="reason-icon">
                  <Icon name={r.icon} size={20} />
                </span>
                <span className="chip">{r.badge}</span>
              </div>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
              <p className="reason-foot">
                <span className="proof-dot" aria-hidden="true" />
                {r.foot}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
