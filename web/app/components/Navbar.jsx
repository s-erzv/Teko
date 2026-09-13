import Logo from "./Logo";
import { BOT_URL } from "../links";

export default function Navbar() {
  return (
    <header className="navbar">
      <div className="wrap navbar-inner">
        <a className="wordmark wordmark-nav" href="#content">
          <Logo size={30} />
          <span>Teko</span>
        </a>
        <nav className="nav-links" aria-label="Section">
          <a href="#how-it-works">How it works</a>
          <a href="#why-onchain">Why on-chain</a>
          <a href="#try-it-yourself">Try it yourself</a>
        </nav>
        <a className="btn btn-primary btn-nav" href={BOT_URL}>
          Open in Telegram
        </a>
      </div>
    </header>
  );
}
