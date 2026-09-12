-- ═══════════════════════════════════════════════════════════════
-- Teko — Row Level Security
-- ───────────────────────────────────────────────────────────────
-- Teko itu backend-only: semua akses DB lewat SERVICE_ROLE key (di server),
-- dan service_role SELALU bypass RLS. Jadi strategi paling aman = kunci rapat
-- semua akses publik (anon / authenticated), backend tetap jalan normal.
--
-- Jalankan di Supabase SQL Editor SETELAH schema.sql.
-- ═══════════════════════════════════════════════════════════════

-- 1) Aktifkan RLS di semua tabel
alter table groups              enable row level security;
alter table members             enable row level security;
alter table payments            enable row level security;
alter table wallets             enable row level security;
alter table payout_destinations enable row level security;
alter table chain_cursor        enable row level security;
alter table processed_events    enable row level security;
alter table pending_payouts     enable row level security;
alter table payouts             enable row level security;
alter table pending_dms         enable row level security;

-- 2) Paksa RLS berlaku bahkan untuk table owner (pertahanan ekstra)
alter table groups              force row level security;
alter table members             force row level security;
alter table payments            force row level security;
alter table wallets             force row level security;
alter table payout_destinations force row level security;
alter table chain_cursor        force row level security;
alter table processed_events    force row level security;
alter table pending_payouts     force row level security;
alter table payouts             force row level security;
alter table pending_dms         force row level security;

-- 3) Cabut hak akses langsung anon & authenticated (belt-and-suspenders).
--    Dengan RLS aktif + tanpa policy permissive, dua role ini otomatis DITOLAK.
--    `wallets` PALING kritis di sini — isinya private key terenkripsi tiap
--    user, jangan pernah ada policy SELECT permisif untuk anon/authenticated.
--    `payouts` + `payout_destinations` isinya nomor rekening asli member --
--    sama sensitifnya, perlakukan sama.
revoke all on groups              from anon, authenticated;
revoke all on members             from anon, authenticated;
revoke all on payments            from anon, authenticated;
revoke all on wallets             from anon, authenticated;
revoke all on payout_destinations from anon, authenticated;
revoke all on chain_cursor        from anon, authenticated;
revoke all on processed_events    from anon, authenticated;
revoke all on pending_payouts     from anon, authenticated;
revoke all on payouts             from anon, authenticated;
revoke all on pending_dms         from anon, authenticated;

-- CATATAN:
-- - Backend Teko pakai SUPABASE_SERVICE_KEY (service_role) → bypass RLS → tetap full akses.
-- - JANGAN pernah taruh service_role key di client/frontend. Server-only.
-- - Kalau nanti butuh dashboard read-only via anon key, baru tambah policy SELECT
--   terbatas, misalnya:
--     -- create policy "public_read_groups" on groups
--     --   for select to anon using (status = 'finished');
-- - Default sekarang: TUTUP RAPAT. Ini yang benar untuk arsitektur bot server-only.
