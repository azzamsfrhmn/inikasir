-- =====================================================================
-- IniKasir migrasi 011: hapus data hari ini, bulan ini, atau tahun ini
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql. Aman dijalankan ulang.
-- Tidak bergantung pada migrasi lain (010 tidak wajib; reset_today ikut diperbarui di sini).
--
-- reset_period(p_store, p_period) dengan p_period 'today' | 'month' | 'year', menurut jam WIB:
--   - penjualan (transactions) yang terjadi di periode itu, termasuk yang dibatalkan
--   - catatan uang masuk/keluar (cashflow) bertanggal di periode itu
--   - pergerakan stok di periode itu (003), stok produk dikembalikan seperti awal periode
--   - buka/tutup kasir (005) dan shift (002) yang dibuka di periode itu
-- Data sebelum periode tidak tersentuh. Hanya pemilik toko yang bisa menjalankannya.
-- Catatan: modal rata-rata (harga beli) yang berubah karena stok masuk tidak dikembalikan.
-- =====================================================================

create or replace function public.reset_period(p_store uuid, p_period text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_start date;
  v_end   date;
  v_from  timestamptz;
  v_to    timestamptz;
  n_tx int := 0; n_cf int := 0; n_sm int := 0; n_cs int := 0; n_sh int := 0;
begin
  if p_store is null or not public.is_owner(p_store) then
    raise exception 'Hanya pemilik toko yang bisa menghapus data';
  end if;
  if p_period = 'today' then v_start := v_today; v_end := v_today + 1;
  elsif p_period = 'month' then v_start := date_trunc('month', v_today)::date; v_end := (v_start + interval '1 month')::date;
  elsif p_period = 'year' then v_start := date_trunc('year', v_today)::date; v_end := (v_start + interval '1 year')::date;
  else raise exception 'Periode tidak dikenal (pilih today, month, atau year)';
  end if;
  v_from := v_start::timestamp at time zone 'Asia/Jakarta';
  v_to   := v_end::timestamp at time zone 'Asia/Jakarta';
  -- kunci yang sama dengan pencatatan penjualan hari ini, supaya tidak bentrok dengan penjualan yang sedang masuk
  perform pg_advisory_xact_lock(hashtext(p_store::text || to_char(v_today, 'YYYYMMDD')));

  -- Stok: batalkan pergerakan di periode ini (selain milik penjualan sebelum periode yang baru terkirim)
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
  with d as (delete from cashflow where store_id = p_store and date >= v_start and date < v_end returning 1)
  select count(*) into n_cf from d;

  if to_regclass('public.cash_sessions') is not null then
    execute 'with d as (delete from cash_sessions where store_id = $1 and opened_at >= $2 and opened_at < $3 returning 1) select count(*)::int from d'
      into n_cs using p_store, v_from, v_to;
  end if;
  if to_regclass('public.shifts') is not null then
    execute 'with d as (delete from shifts where store_id = $1 and opened_at >= $2 and opened_at < $3 returning 1) select count(*)::int from d'
      into n_sh using p_store, v_from, v_to;
  end if;

  return jsonb_build_object('period', p_period, 'from', v_start, 'to', v_end - 1, 'transactions', n_tx, 'cashflow', n_cf,
    'stock_moves', n_sm, 'cash_sessions', n_cs, 'shifts', n_sh);
end $$;

-- reset_today (dipakai aplikasi versi lama) sekarang memanggil reset_period
create or replace function public.reset_today(p_store uuid) returns jsonb
language sql security definer set search_path = public as $$ select public.reset_period(p_store, 'today') $$;

revoke execute on function public.reset_period(uuid, text) from public, anon;
grant execute on function public.reset_period(uuid, text) to authenticated;
revoke execute on function public.reset_today(uuid) from public, anon;
grant execute on function public.reset_today(uuid) to authenticated;
