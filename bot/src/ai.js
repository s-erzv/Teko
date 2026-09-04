import Groq from "groq-sdk";
import { config } from "./config.js";

const groq = new Groq({ apiKey: config.groq.apiKey });

const SYSTEM = `Kamu adalah "Teko", AI bendahara arisan di grup Telegram Indonesia.
Tugasmu: baca pesan warga (bahasa Indonesia sehari-hari, boleh typo/slang) dan keluarkan SATU intent JSON.

Intent yang valid:
- {"action":"create_arisan","size":<int 2-50>,"contribution_idr":<int rupiah per orang per ronde>}
- {"action":"join"}       // ikut arisan / mau setor (TIDAK perlu wallet)
- {"action":"status"}
- {"action":"draw"}       // undi pemenang ronde ini
- {"action":"exit"}       // keluar dari arisan
- {"action":"pay_debt"}   // bayar utang/denda
- {"action":"priority","fee_idr":<int rupiah>}   // beli tiket prioritas undian
- {"action":"replace"}    // minta diganti orang lain
- {"action":"set_wallet","address":"<0x...>"}     // daftarin wallet BNB sendiri
- {"action":"propose_skip","target_username":"<username tanpa @>"}
- {"action":"propose_kick","target_username":"<username tanpa @>"}
- {"action":"vote","proposal_id":<int>,"approve":<true|false>}
- {"action":"complaint","text":"<ringkasan komplain>"}
- {"action":"help"}
- {"action":"none"}       // pesan tidak relevan / obrolan biasa

Aturan:
- "sebulan 200rb" / "200 ribu" / "200k" => contribution_idr / fee_idr: 200000.
- "5 orang" => size: 5.
- "gabung" / "ikut" / "mau setor" / "bayar" => action join.
- "keluar" / "berhenti ikut" => action exit.
- "bayar utang" / "lunasin denda" => action pay_debt.
- "mau prioritas 50rb" / "beli posisi duluan" => action priority.
- "ganti orang" / "minta diganti" => action replace.
- "pakai wallet sendiri 0x..." / "wallet saya 0x..." => action set_wallet.
- "usul skip @budi" / "lewati budi ronde ini" => action propose_skip.
- "usul keluarkan @budi" / "kick budi" => action propose_kick.
- "setuju 3" / "tolak 3" => action vote (proposal_id 3, approve true/false).
- Jawab HANYA JSON valid, tanpa penjelasan, tanpa markdown fence.`;

/**
 * Parse pesan jadi intent terstruktur.
 * @param {string} text
 * @returns {Promise<object>} intent
 */
export async function parseIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: config.groq.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() || "{}";
    const intent = JSON.parse(raw);
    if (!intent.action) return { action: "none" };
    return intent;
  } catch (e) {
    console.error("[ai] parseIntent gagal:", e.message);
    return { action: "none" };
  }
}
