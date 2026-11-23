-- =====================================================================
-- IniKasir migrasi 002: karyawan, hak akses, shift (kas awal/akhir), absensi
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
--
-- Alur: pemilik (master) membuat karyawan + PIN + hak akses di halaman admin.
-- Di HP kasir, karyawan memilih nama, mengetik PIN, lalu membuka shift
-- (jam masuk + kas awal). Penjualan tercatat atas shift itu. Tutup shift =
-- jam pulang + kas akhir. Semua pemeriksaan dilakukan di server.
-- =====================================================================

-- ---------- Tabel ----------
create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 40),
  pin_hash        text,
  active          boolean not null default true,
  -- hak akses: {"view_shift": bool, "void_own": bool, "cash_out": bool}
  perms           jsonb not null default '{}'::jsonb,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
create unique index employees_store_name_idx on public.employees(store_id, lower(trim(name)));

create table public.shifts (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  employee_id   uuid references public.employees(id) on delete set null,
  employee_name text not null,
  device_user   uuid references auth.users(id) on delete set null,
  device_name   text not null default '',
  opened_at     timestamptz not null default now(),
  opening_cash  integer not null check (opening_cash >= 0),
  closed_at     timestamptz,
  closing_cash  integer check (closing_cash >= 0),
  close_note    text not null default '',
  closed_by     text not null default ''      -- 'karyawan' atau 'pemilik'
);
create index shifts_store_opened_idx on public.shifts(store_id, opened_at);
create unique index shifts_one_open_per_employee on public.shifts(employee_id) where closed_at is null;
create unique index shifts_one_open_per_device on public.shifts(device_user) where closed_at is null;

alter table public.transactions add column shift_id uuid references public.shifts(id) on delete set null;
alter table public.transactions add column employee_name text not null default '';
create index transactions_shift_idx on public.transactions(shift_id);
alter table public.cashflow add column shift_id uuid references public.shifts(id) on delete set null;

-- ---------- Izin & RLS ----------
alter table public.employees enable row level security;
alter table public.shifts    enable row level security;

-- employees: anggota toko boleh lihat nama & hak akses (HP kasir butuh daftar nama);
-- kolom pin_hash / percobaan PIN TIDAK pernah bisa dibaca lewat API.
revoke all on public.employees from anon, authenticated;
grant select (id, store_id, name, active, perms, created_at) on public.employees to authenticated;
grant insert (store_id, name, active, perms) on public.employees to authenticated;
grant update (name, active, perms) on public.employees to authenticated;
grant delete on public.employees to authenticated;
create policy emp_select on public.employees for select to authenticated using (public.is_member(store_id));
create policy emp_insert on public.employees for insert to authenticated with check (public.is_owner(store_id));
create policy emp_update on public.employees for update to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));
create policy emp_delete on public.employees for delete to authenticated using (public.is_owner(store_id));

-- shifts: hanya pemilik yang membaca langsung; HP kasir lewat fungsi di bawah
revoke all on public.shifts from anon, authenticated;
grant select on public.shifts to authenticated;
create policy shifts_select on public.shifts for select to authenticated using (public.is_owner(store_id));

-- ---------- Fungsi bantu ----------
create function public._emp_pin_hash(e uuid, pin text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(e::text || ':karyawan:' || pin, 'UTF8')), 'hex');
$$;
revoke execute on function public._emp_pin_hash(uuid, text) from public, anon, authenticated;

-- shift terbuka milik HP ini (dipakai fungsi lain)
create function public._my_shift(p_shift uuid) returns public.shifts
language sql stable security definer set search_path = public as $$
  select * from shifts where id = p_shift and device_user = auth.uid();
$$;
revoke execute on function public._my_shift(uuid) from public, anon, authenticated;

create function public._shift_json(s public.shifts) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'employee_id', s.employee_id, 'employee_name', s.employee_name,
    'opened_at', s.opened_at, 'opening_cash', s.opening_cash, 'closed_at', s.closed_at,
    'perms', coalesce((select perms from employees where id = s.employee_id), '{}'::jsonb));
$$;
revoke execute on function public._shift_json(public.shifts) from public, anon, authenticated;

-- ---------- Fungsi untuk pemilik ----------
create function public.set_employee_pin(p_employee uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  select store_id into v_store from employees where id = p_employee;
  if v_store is null or not public.is_owner(v_store) then raise exception 'Hanya pemilik toko'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN harus 4 sampai 6 angka'; end if;
  update employees set pin_hash = public._emp_pin_hash(p_employee, p_pin), failed_attempts = 0, locked_until = null
    where id = p_employee;
end $$;

create function public.employee_has_pin(p_store uuid) returns table (employee_id uuid, has_pin boolean)
language sql stable security definer set search_path = public as $$
  select id, pin_hash is not null from employees where store_id = p_store and public.is_owner(p_store);
$$;

create function public.force_close_shift(p_shift uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  select store_id into v_store from shifts where id = p_shift and closed_at is null;
  if v_store is null then raise exception 'Shift tidak ditemukan atau sudah ditutup'; end if;
  if not public.is_owner(v_store) then raise exception 'Hanya pemilik toko'; end if;
  update shifts set closed_at = now(), closed_by = 'pemilik', close_note = 'Ditutup oleh pemilik (kas akhir tidak dihitung)'
    where id = p_shift;
end $$;

-- ---------- Fungsi untuk HP kasir ----------

-- Buka shift (atau lanjutkan shift yang masih terbuka di HP ini).
-- Mengembalikan {ok, shift, resumed} atau {ok:false, error}. Tanpa exception
-- supaya hitungan PIN salah tetap tersimpan. Terkunci 15 menit setelah 5x salah.
create function public.start_shift(p_store uuid, p_employee uuid, p_pin text, p_opening_cash integer, p_device_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e   employees;
  s   shifts;
begin
  if not public.is_member(p_store) then return jsonb_build_object('ok', false, 'error', 'HP ini tidak tersambung ke toko'); end if;
  select * into e from employees where id = p_employee and store_id = p_store for update;
  if not found or not e.active then return jsonb_build_object('ok', false, 'error', 'Karyawan tidak ditemukan atau sudah nonaktif'); end if;
  if e.locked_until is not null and e.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Terlalu banyak PIN salah. Coba lagi 15 menit lagi');
  end if;
  if e.pin_hash is null then return jsonb_build_object('ok', false, 'error', 'PIN karyawan ini belum diatur pemilik'); end if;
  if e.pin_hash <> public._emp_pin_hash(e.id, coalesce(p_pin, '')) then
    update employees set
      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
      locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
      where id = e.id;
    return jsonb_build_object('ok', false, 'error', 'PIN salah');
  end if;
  update employees set failed_attempts = 0, locked_until = null where id = e.id;

  -- shift karyawan ini masih terbuka?
  select * into s from shifts where employee_id = e.id and closed_at is null;
  if found then
    if s.device_user = auth.uid() then
      return jsonb_build_object('ok', true, 'resumed', true, 'shift', public._shift_json(s));
    end if;
    return jsonb_build_object('ok', false, 'error',
      'Shift ' || e.name || ' masih terbuka di ' || coalesce(nullif(s.device_name, ''), 'HP lain') ||
      '. Tutup dulu di HP itu, atau minta pemilik menutupnya dari halaman admin.');
  end if;
  -- HP ini masih dipakai karyawan lain?
  select * into s from shifts where device_user = auth.uid() and closed_at is null;
  if found then
    return jsonb_build_object('ok', false, 'error', 'HP ini masih dipakai shift ' || s.employee_name || '. Tutup shift itu dulu.');
  end if;
  if p_opening_cash is null or p_opening_cash < 0 then
    return jsonb_build_object('ok', false, 'error', 'Isi kas awal (boleh 0)', 'need_opening_cash', true);
  end if;
  insert into shifts (store_id, employee_id, employee_name, device_user, device_name, opening_cash)
    values (p_store, e.id, e.name, auth.uid(),
      coalesce((select device_name from store_members where store_id = p_store and user_id = auth.uid()), left(coalesce(p_device_name, ''), 40)),
      p_opening_cash)
    returning * into s;
  return jsonb_build_object('ok', true, 'resumed', false, 'shift', public._shift_json(s));
end $$;

-- Shift yang sedang terbuka di HP ini (setelah aplikasi dibuka ulang)
create function public.current_shift(p_store uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public._shift_json(s) from shifts s
  where s.store_id = p_store and s.device_user = auth.uid() and s.closed_at is null limit 1;
$$;

-- Ringkasan shift (untuk karyawan dengan hak 'view_shift', atau saat tutup shift)
create function public._shift_summary(s public.shifts) returns jsonb
language sql stable security definer set search_path = public as $$
  with t as (
    select * from transactions where shift_id = s.id
  ), c as (
    select coalesce(sum(amount), 0) as out from cashflow where shift_id = s.id and type = 'keluar' and via = 'tunai'
  )
  select jsonb_build_object(
    'opening_cash', s.opening_cash,
    'tx_count', (select count(*) from t where not voided),
    'cash_sales', (select coalesce(sum(total), 0) from t where not voided and method = 'tunai'),
    'qris_sales', (select coalesce(sum(total), 0) from t where not voided and method = 'qris'),
    'cash_out', (select out from c),
    'expected_cash', s.opening_cash + (select coalesce(sum(total), 0) from t where not voided and method = 'tunai') - (select out from c),
    'closing_cash', s.closing_cash,
    'transactions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'no', no, 'created_at', created_at, 'total', total,
        'method', method, 'paid', paid, 'change', change, 'voided', voided, 'items', items) order by created_at desc) from t), '[]'::jsonb));
$$;
revoke execute on function public._shift_summary(public.shifts) from public, anon, authenticated;

create function public.shift_summary(p_shift uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s shifts;
begin
  s := public._my_shift(p_shift);
  if s.id is null then raise exception 'Shift tidak ditemukan di HP ini'; end if;
  if not coalesce((select (perms ->> 'view_shift')::boolean from employees where id = s.employee_id), false) then
    raise exception 'Tidak punya hak melihat ringkasan shift';
  end if;
  return public._shift_summary(s);
end $$;

-- Tutup shift: kas akhir dihitung karyawan. Ringkasan hanya dikembalikan
-- kalau karyawan punya hak 'view_shift' (kalau tidak, penutupan "buta").
create function public.end_shift(p_shift uuid, p_closing_cash integer, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; v_view boolean;
begin
  s := public._my_shift(p_shift);
  if s.id is null then raise exception 'Shift tidak ditemukan di HP ini'; end if;
  if s.closed_at is not null then return jsonb_build_object('ok', true, 'already_closed', true); end if;
  if p_closing_cash is null or p_closing_cash < 0 then raise exception 'Isi kas akhir (jumlah uang di laci)'; end if;
  update shifts set closed_at = now(), closing_cash = p_closing_cash, close_note = left(coalesce(p_note, ''), 200), closed_by = 'karyawan'
    where id = s.id returning * into s;
  v_view := coalesce((select (perms ->> 'view_shift')::boolean from employees where id = s.employee_id), false);
  return jsonb_build_object('ok', true, 'summary', case when v_view then public._shift_summary(s) else null end);
end $$;

-- Batalkan transaksi di shift sendiri (hak 'void_own')
create function public.void_own_sale(p_shift uuid, p_tx uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  s := public._my_shift(p_shift);
  if s.id is null or s.closed_at is not null then raise exception 'Shift tidak aktif di HP ini'; end if;
  if not coalesce((select (perms ->> 'void_own')::boolean from employees where id = s.employee_id), false) then
    raise exception 'Tidak punya hak membatalkan transaksi';
  end if;
  update transactions set voided = true, voided_at = now() where id = p_tx and shift_id = s.id and not voided;
  if not found then raise exception 'Transaksi tidak ditemukan di shift ini'; end if;
end $$;

-- Catat uang keluar dari laci selama shift (hak 'cash_out')
create function public.cash_out(p_shift uuid, p_amount integer, p_cat text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  s := public._my_shift(p_shift);
  if s.id is null or s.closed_at is not null then raise exception 'Shift tidak aktif di HP ini'; end if;
  if not coalesce((select (perms ->> 'cash_out')::boolean from employees where id = s.employee_id), false) then
    raise exception 'Tidak punya hak mencatat uang keluar';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'Nominal tidak valid'; end if;
  insert into cashflow (store_id, date, type, amount, cat, via, note, shift_id, created_by)
    values (s.store_id, (now() at time zone 'Asia/Jakarta')::date, 'keluar', p_amount,
      left(coalesce(nullif(trim(p_cat), ''), 'Lainnya'), 40), 'tunai',
      left(trim(coalesce(p_note, '') || ' (oleh ' || s.employee_name || ')'), 120), s.id, auth.uid());
end $$;

-- ---------- record_sale versi baru: menerima shift ----------
drop function public.record_sale(uuid, uuid, jsonb, text, integer, timestamptz);
create function public.record_sale(p_id uuid, p_store uuid, p_items jsonb, p_method text, p_paid integer, p_time timestamptz, p_shift uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tx     transactions;
  v_items  jsonb := '[]'::jsonb;
  v_total  integer := 0;
  v_time   timestamptz;
  v_day    text;
  v_seq    integer;
  v_paid   integer;
  it       jsonb;
  p        products;
  v_qty    integer;
  v_price  integer;
  v_name   text;
  s        shifts;
begin
  if not public.is_member(p_store) then raise exception 'HP ini tidak terdaftar di toko'; end if;
  select * into v_tx from transactions where id = p_id;
  if found then
    return jsonb_build_object('id', v_tx.id, 'no', v_tx.no, 'total', v_tx.total, 'created_at', v_tx.created_at, 'duplicate', true);
  end if;
  if p_method not in ('tunai', 'qris') then raise exception 'Metode bayar tidak dikenal'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Pesanan kosong'; end if;

  v_time := least(greatest(coalesce(p_time, now()), now() - interval '7 days'), now());
  if p_shift is not null then
    select * into s from shifts where id = p_shift and store_id = p_store and device_user = auth.uid();
    if not found then raise exception 'Shift tidak valid untuk HP ini'; end if;
    -- penjualan offline boleh masuk setelah shift ditutup, asal terjadi sebelum ditutup
    if s.closed_at is not null and v_time > s.closed_at then raise exception 'Shift sudah ditutup'; end if;
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 9999 then raise exception 'Jumlah barang tidak valid'; end if;
    select * into p from products where id = (it ->> 'product_id')::uuid and store_id = p_store;
    if found then
      v_price := p.price; v_name := p.name;
    else
      v_price := greatest(coalesce((it ->> 'price')::integer, 0), 0);
      v_name  := left(coalesce(it ->> 'name', 'Produk terhapus'), 80);
    end if;
    v_total := v_total + v_price * v_qty;
    v_items := v_items || jsonb_build_object('product_id', it ->> 'product_id', 'name', v_name, 'price', v_price, 'qty', v_qty);
  end loop;

  v_day := to_char(v_time at time zone 'Asia/Jakarta', 'YYYYMMDD');
  perform pg_advisory_xact_lock(hashtext(p_store::text || v_day));
  select count(*) + 1 into v_seq from transactions
    where store_id = p_store and to_char(created_at at time zone 'Asia/Jakarta', 'YYYYMMDD') = v_day;
  v_paid := case when p_method = 'qris' then v_total else greatest(coalesce(p_paid, v_total), v_total) end;

  insert into transactions (id, store_id, no, created_at, items, total, method, paid, change, created_by, shift_id, employee_name)
    values (p_id, p_store, v_day || '-' || lpad(v_seq::text, 3, '0'), v_time, v_items, v_total, p_method, v_paid, v_paid - v_total,
      auth.uid(), s.id, coalesce(s.employee_name, ''))
    returning * into v_tx;
  update store_members set last_seen = now() where store_id = p_store and user_id = auth.uid();
  return jsonb_build_object('id', v_tx.id, 'no', v_tx.no, 'total', v_tx.total, 'created_at', v_tx.created_at, 'items', v_tx.items, 'duplicate', false);
end $$;

-- ---------- Hak eksekusi ----------
revoke execute on function
  public.set_employee_pin(uuid, text), public.employee_has_pin(uuid), public.force_close_shift(uuid),
  public.start_shift(uuid, uuid, text, integer, text), public.current_shift(uuid), public.shift_summary(uuid),
  public.end_shift(uuid, integer, text), public.void_own_sale(uuid, uuid), public.cash_out(uuid, integer, text, text),
  public.record_sale(uuid, uuid, jsonb, text, integer, timestamptz, uuid)
  from public, anon;
grant execute on function
  public.set_employee_pin(uuid, text), public.employee_has_pin(uuid), public.force_close_shift(uuid),
  public.start_shift(uuid, uuid, text, integer, text), public.current_shift(uuid), public.shift_summary(uuid),
  public.end_shift(uuid, integer, text), public.void_own_sale(uuid, uuid), public.cash_out(uuid, integer, text, text),
  public.record_sale(uuid, uuid, jsonb, text, integer, timestamptz, uuid)
  to authenticated;
