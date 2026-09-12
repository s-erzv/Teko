import { BOT_URL, CONTRACT_URL, REPO_URL, VRF_DOCS_URL } from "../links";

export default function Footer() {
  return (
    <footer className="closing section">
      <div className="wrap">
        <h2>Coba sendiri</h2>
        <p>
          Teko jalan di BNB Chain Testnet. Undang botnya ke grup, ketik{" "}
          <strong>buat arisan 5 orang 200rb</strong>, dan lihat sendiri
          transaksinya muncul di BscScan.
        </p>
        <div className="btn-row">
          <a className="btn btn-primary" href={BOT_URL}>
            Buka di Telegram
          </a>
        </div>
        <ul className="linkrow">
          <li>
            <a href={REPO_URL}>Kode sumber</a>
          </li>
          <li>
            <a href={CONTRACT_URL}>Kontrak di BscScan</a>
          </li>
          <li>
            <a href={VRF_DOCS_URL}>Chainlink VRF</a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
