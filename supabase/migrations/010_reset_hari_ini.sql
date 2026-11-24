-- =====================================================================
-- IniKasir migrasi 010: pemilik bisa menghapus data HARI INI (misalnya setelah coba-coba)
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql. Aman dijalankan ulang.
-- Tidak bergantung pada migrasi lain: tabel dari migrasi yang belum dipasang dilewati.
--
-- reset_today(p_store) menghapus, untuk hari ini menurut jam WIB (Asia/Jakarta):
--   - penjualan (transactions) yang terjadi hari ini, termasuk yang dibatalkan
--   - catatan uang masuk/keluar (cashflow) bertanggal hari ini
--   - pergerakan stok hari ini (003), dan stok produk dikembalikan seperti awal hari
--   - buka/tutup kasir yang dibuka hari ini (005) dan shift yang dibuka hari ini (002)
-- Data hari-hari sebelumnya tidak tersentuh. Hanya pemilik toko yang bisa menjalankannya.
-- Catatan: modal rata-rata (harga beli) yang berubah karena stok masuk hari ini tidak dikembalikan.
-- =====================================================================

create or replace function public.reset_today(p_store uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_day  date        := (now() at time zone 'Asia/Jakarta')::date;
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Jakarta';
  v_to   timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Jakarta';
  n_tx int := 0; n_cf int := 0; n_sm int := 0; n_cs int := 0; n_sh int := 0;
begin
  if p_store is null or not public.is_owner(p_store) then
    raise exception 'Hanya pemilik toko yang bisa menghapus data hari ini';
  end if;
  -- kunci yang sama dengan pencatatan penjualan, supaya tidak bentrok dengan penjualan yang sedang masuk
  perform pg_advisory_xact_lock(hashtext(p_store::text || to_char(v_day, 'YYYYMMDD')));

  -- Stok: batalkan pergerakan hari ini (selain milik penjualan hari sebelumnya yang baru terkirim)
  if to_regclass('public.stock_moves') is not null then
    execute $q$
      with m as (
        select id, product_id, qty from stock_moves m
        where m.store_id = $1 and m.created_at >= $2 and m.created_at < $3
          and (m.tx_id is null or exists (
            select 1 from transactions t where t.id = m.tx_id and t.created_at >= $2 and t.created_at < $3))
      ), back as (
        update products p set stock = p.stock - s.q
        from (select product_id, sum(qty) q from m where product_id is not null group by product_id) s
        where p.id = s.product_id and p.store_id = $1
        returning 1
      ), del as (
        delete from stock_moves where id in (select id from m) returning 1
      )
      select (select count(*) from del)::int
    $q$ into n_sm using p_store, v_from, v_to;
  end if;

  with d as (delete from transactions where store_id = p_store and created_at >= v_from and created_at < v_to returning 1)
  select count(*) into n_tx from d;
  with d as (delete from cashflow where store_id = p_store and date = v_day returning 1)
  select count(*) into n_cf from d;

  if to_regclass('public.cash_sessions') is not null then
    execute 'with d as (delete from cash_sessions where store_id = $1 and opened_at >= $2 and opened_at < $3 returning 1) select count(*)::int from d'
      into n_cs using p_store, v_from, v_to;
  end if;
  if to_regclass('public.shifts') is not null then
    execute 'with d as (delete from shifts where store_id = $1 and opened_at >= $2 and opened_at < $3 returning 1) select count(*)::int from d'
      into n_sh using p_store, v_from, v_to;
  end if;

  return jsonb_build_object('day', v_day, 'transactions', n_tx, 'cashflow', n_cf, 'stock_moves', n_sm, 'cash_sessions', n_cs, 'shifts', n_sh);
end $$;

revoke execute on function public.reset_today(uuid) from public, anon;
grant execute on function public.reset_today(uuid) to authenticated;
