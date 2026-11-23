-- =====================================================================
-- IniKasir migrasi 009: daftar kategori produk yang diatur pemilik
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql. Aman dijalankan ulang.
-- Tidak bergantung pada migrasi lain.
--
-- stores.categories: daftar nama kategori berurutan, mis. ["Otak-otak", "Gorengan", "Minuman"].
-- Urutan ini dipakai untuk tab kategori di HP kasir. Produk tetap menyimpan nama
-- kategorinya di products.cat. Hanya pemilik yang bisa mengubah.
-- =====================================================================

alter table public.stores add column if not exists categories jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_categories_check') then
    alter table public.stores add constraint stores_categories_check
      check (jsonb_typeof(categories) = 'array' and jsonb_array_length(categories) <= 100 and octet_length(categories::text) <= 8000);
  end if;
end $$;

grant update (categories) on public.stores to authenticated;

-- Toko lama: isi dari kategori produk yang sudah ada (urut abjad)
update public.stores s set categories = coalesce((
  select jsonb_agg(c order by c) from (select distinct p.cat c from public.products p where p.store_id = s.id and p.cat <> '') x
), '[]'::jsonb)
where s.categories = '[]'::jsonb;
