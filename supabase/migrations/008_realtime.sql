-- =====================================================================
-- IniKasir migrasi 008: kirim perubahan data secara langsung (realtime) ke halaman admin
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql. Aman dijalankan ulang.
-- Tidak bergantung pada migrasi lain: tabel dari migrasi yang belum dipasang dilewati,
-- jadi jalankan ulang file ini setelah memasang migrasi baru (003/005).
--
-- Supabase Realtime tetap mengikuti aturan RLS: pemilik hanya menerima data tokonya sendiri;
-- HP kasir hanya bisa mendengar perubahan produk (yang memang sudah boleh ia baca), bukan penjualan.
-- =====================================================================

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['transactions', 'cashflow', 'products', 'cash_sessions'] loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
