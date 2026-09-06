import Groq from "groq-sdk";
import { config } from "./config.js";

const groq = new Groq({ apiKey: config.groq.apiKey });

const SYSTEM = `Kamu adalah "Teko", AI bendahara arisan di grup Telegram Indonesia.
Tugasmu: baca pesan warga (bahasa Indonesia sehari-hari, boleh typo/slang) dan keluarkan SATU intent JSON.

Intent yang valid:
- {"action":"create_arisan","size":<int 2-50>,"contribution_idr":<int rupiah per orang per ronde>,"cycle_days":<int hari per ronde, opsional>,"draw_mode":<"percycle"|"upfront", opsional>}
- {"action":"join"}       // ikut arisan / mau setor (TIDAK perlu wallet)
- {"action":"status"}
- {"action":"draw"}       // undi pemenang ronde ini
- {"action":"exit"}       // keluar dari arisan
- {"action":"pay_debt"}   // bayar utang/denda
- {"action":"priority","target_username":"<username tanpa @>","fee_idr":<int rupiah>}   // tawar posisi antrian orang lain, berbayar
- {"action":"respond_priority","approve":<true|false>}   // target terima/tolak tawaran priority-swap yg masuk
- {"action":"free_swap","target_username":"<username tanpa @>"}   // ajak tuker posisi antrian, GRATIS
- {"action":"accept_free_swap"}   // target setuju ajakan tuker gratis yg masuk
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
- "tiap minggu" => cycle_days: 7. "tiap bulan"/"bulanan" => cycle_days: 30. "tiap N hari" => cycle_days: N. Kalau gak disebut, JANGAN isi cycle_days sama sekali (biar dipakai default).
- "diundi di awal"/"upfront"/"sekali diundi semua"/"urutan langsung ditentukan" => draw_mode: "upfront". "diundi ulang tiap ronde"/gak disebut => draw_mode: "percycle" atau jangan diisi.
- "gabung" / "ikut" / "mau setor" / "bayar" => action join.
- "keluar" / "berhenti ikut" => action exit.
- "bayar utang" / "lunasin denda" => action pay_debt.
- "mau prioritas 50rb ke @budi" / "tawar posisi budi 50rb" / "bayar buat gantiin budi" => action priority (target_username: "budi", fee_idr: 50000).
- "terima tawaran" / "oke gantiin aku" (soal priority-swap, TANPA nomor) => action respond_priority (approve true). "tolak tawaran" => respond_priority (approve false).
- "tuker posisi sama @budi" / "mau tuker sama budi" => action free_swap (target_username: "budi").
- "terima tukeran" / "oke tuker" => action accept_free_swap.
- "ganti orang" / "minta diganti" => action replace.
- "pakai wallet sendiri 0x..." / "wallet saya 0x..." => action set_wallet.
- "usul skip @budi" / "lewati budi ronde ini" => action propose_skip.
- "usul keluarkan @budi" / "kick budi" => action propose_kick.
- "setuju 3" / "tolak 3" (ADA nomor proposal) => action vote (proposal_id 3, approve true/false). Beda dari respond_priority/accept_free_swap yang TANPA nomor.
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
