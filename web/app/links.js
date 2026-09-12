/**
 * Tautan luar dikumpulkan di satu tempat karena dipakai di beberapa bagian
 * halaman. Kalau username bot berubah atau kontrak di-deploy ulang, cukup
 * satu berkas ini yang disunting -- bukan berburu string yang sama di
 * Hero, Footer, dan WhyOnchain.
 */

/** Sama dengan nilai bawaan BOT_USERNAME di bot/src/index.js. */
export const BOT_URL = "https://t.me/tekoarisan_bot";

/** TekoArisan di BNB Chain Testnet (chain 97), hasil script/Deploy.s.sol. */
export const CONTRACT_ADDRESS = "0x3Be07E38716991ADD619115E61FeEaD312878949";
export const CONTRACT_URL = `https://testnet.bscscan.com/address/${CONTRACT_ADDRESS}`;

export const REPO_URL = "https://github.com/s-erzv/teko";
export const VRF_DOCS_URL = "https://docs.chain.link/vrf";
