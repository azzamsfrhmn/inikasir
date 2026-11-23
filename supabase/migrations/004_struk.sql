-- =====================================================================
-- IniKasir migrasi 004: pengaturan struk
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
-- Tidak bergantung pada migrasi 002/003.
--
-- receipt (jsonb):
--   header_text, footer_text : teks tambahan di atas / bawah struk
--   show_address, show_phone, show_no, show_cashier : true/false
--   paper : '58' atau '80' (mm, untuk cetak)
--   logo  : gambar kecil hitam-putih (data URL PNG), opsional
-- Dibaca HP kasir (lewat tabel stores yang sudah bisa dibaca anggota toko),
-- hanya pemilik yang bisa mengubah.
-- =====================================================================

alter table public.stores add column receipt jsonb not null default '{}'::jsonb
  check (jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 120000);

grant update (receipt) on public.stores to authenticated;
