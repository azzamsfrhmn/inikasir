-- =====================================================================
-- IniKasir migrasi 012: karyawan mencatat belanja & stok bahan, saldo, kasbon
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql. Aman dijalankan ulang.
-- Sudah termasuk isi migrasi 011 (hapus data per periode), jadi 011 tidak wajib.
--
-- Karyawan (HP kasir):
--   - mencatat belanja/pengeluaran (tunai atau QRIS kios) lewat record_expense: tidak bisa mengubah/menghapus
--   - menambah stok bahan lewat material_add: tidak bisa mengurangi/mengoreksi
--   - melihat sisa stok bahan & produk (tidak melihat penjualan, keuangan, saldo)
-- Pemilik:
--   - saldo awal tunai & rekening (store_balance menghitung saldo sekarang)
--   - kelola bahan: tambah, kurangi, koreksi, ubah, hapus
--   - kasbon karyawan: beri kasbon, catat bayar (tunai/rekening) atau potong gaji
-- =====================================================================

-- ---------- Siapa yang mencatat ----------
alter table public.cashflow add column if not exists by_name text not null default '';

create or replace function public._member_name(p_store uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select case when role = 'owner' then 'Pemilik' else nullif(device_name, '') end
                   from store_members where store_id = p_store and user_id = auth.uid()), 'Kasir');
$$;
revoke execute on function public._member_name(uuid) from public, anon, authenticated;

-- ---------- Belanja dari HP kasir ----------
-- p_id dibuat di HP supaya kirim ulang (offline) tidak dobel
create or replace function public.record_expense(p_id uuid, p_store uuid, p_amount integer, p_cat text, p_via text, p_note text, p_time timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_time timestamptz; v_row cashflow;
begin
  if p_store is null or not public.is_member(p_store) then raise exception 'HP ini tidak terdaftar di toko'; end if;
  select * into v_row from cashflow where id = p_id;
  if found then
    if v_row.store_id <> p_store then raise exception 'Catatan tidak valid'; end if;
    return jsonb_build_object('id', v_row.id, 'duplicate', true);
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'Nominal tidak valid'; end if;
  if p_via not in ('tunai', 'bank') then raise exception 'Cara bayar tidak dikenal'; end if;
  v_time := least(greatest(coalesce(p_time, now()), now() - interval '7 days'), now());
  insert into cashflow (id, store_id, date, type, amount, cat, via, note, created_at, by_name)
  values (p_id, p_store, (v_time at time zone 'Asia/Jakarta')::date, 'keluar', p_amount,
          coalesce(nullif(left(trim(coalesce(p_cat, '')), 40), ''), 'Lainnya'), p_via,
          left(trim(coalesce(p_note, '')), 120), v_time, public._member_name(p_store));
  return jsonb_build_object('id', p_id, 'duplicate', false);
end $$;
revoke execute on function public.record_expense(uuid, uuid, integer, text, text, text, timestamptz) from public, anon;
grant execute on function public.record_expense(uuid, uuid, integer, text, text, text, timestamptz) to authenticated;

-- ---------- Bahan ----------
create table if not exists public.materials (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null check (length(name) between 1 and 60),
  unit       text not null default 'pcs' check (length(unit) between 1 and 15),
  stock      numeric(12,2) not null default 0,
  min_stock  numeric(12,2) not null default 0 check (min_stock >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists materials_store_idx on public.materials(store_id);

create table if not exists public.material_moves (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  material_id uuid references public.materials(id) on delete cascade,
  name        text not null,
  unit        text not null default '',
  qty         numeric(12,2) not null,               -- + masuk, - keluar
  kind        text not null check (kind in ('masuk', 'keluar', 'koreksi')),
  stock_after numeric(12,2) not null,
  note        text not null default '',
  by_name     text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users(id) on delete set null
);
create index if not exists material_moves_store_idx on public.material_moves(store_id, created_at desc);

alter table public.materials enable row level security;
alter table public.material_moves enable row level security;
revoke all on public.materials, public.material_moves from anon, authenticated;
grant select on public.materials, public.material_moves to authenticated;
grant insert (store_id, name, unit, min_stock, active) on public.materials to authenticated;
grant update (name, unit, min_stock, active) on public.materials to authenticated;
grant delete on public.materials to authenticated;

drop policy if exists materials_select on public.materials;
drop policy if exists materials_insert on public.materials;
drop policy if exists materials_update on public.materials;
drop policy if exists materials_delete on public.materials;
drop policy if exists mmoves_select on public.material_moves;
create policy materials_select on public.materials for select to authenticated using (public.is_member(store_id));
create policy materials_insert on public.materials for insert to authenticated with check (public.is_owner(store_id));
create policy materials_update on public.materials for update to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));
create policy materials_delete on public.materials for delete to authenticated using (public.is_owner(store_id));
create policy mmoves_select on public.material_moves for select to authenticated using (public.is_member(store_id));

-- Stok bahan masuk: karyawan & pemilik. p_id dari HP supaya kirim ulang tidak dobel.
create or replace function public.material_add(p_id uuid, p_material uuid, p_qty numeric, p_note text, p_time timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m materials; v_time timestamptz;
begin
  if exists (select 1 from material_moves where id = p_id) then
    select * into m from materials where id = p_material;
    return jsonb_build_object('stock', m.stock, 'duplicate', true);
  end if;
  select * into m from materials where id = p_material for update;
  if not found or not public.is_member(m.store_id) then raise exception 'Bahan tidak ditemukan'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then raise exception 'Jumlah tidak valid'; end if;
  v_time := least(greatest(coalesce(p_time, now()), now() - interval '7 days'), now());
  update materials set stock = stock + round(p_qty, 2) where id = m.id returning * into m;
  insert into material_moves (id, store_id, material_id, name, unit, qty, kind, stock_after, note, by_name, created_at)
    values (p_id, m.store_id, m.id, m.name, m.unit, round(p_qty, 2), 'masuk', m.stock, left(trim(coalesce(p_note, '')), 120),
            public._member_name(m.store_id), v_time);
  return jsonb_build_object('stock', m.stock, 'duplicate', false);
end $$;

-- Pemilik: kurangi (dipakai/rusak) atau koreksi ke jumlah hasil hitung
create or replace function public.material_change(p_material uuid, p_kind text, p_qty numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m materials; v_diff numeric;
begin
  select * into m from materials where id = p_material for update;
  if not found or not public.is_owner(m.store_id) then raise exception 'Hanya pemilik toko'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 1000000 then raise exception 'Jumlah tidak valid'; end if;
  if p_kind = 'keluar' then
    if p_qty = 0 then raise exception 'Jumlah tidak valid'; end if;
    v_diff := -round(p_qty, 2);
  elsif p_kind = 'koreksi' then v_diff := round(p_qty, 2) - m.stock;
  elsif p_kind = 'masuk' then
    if p_qty = 0 then raise exception 'Jumlah tidak valid'; end if;
    v_diff := round(p_qty, 2);
  else raise exception 'Jenis perubahan tidak dikenal';
  end if;
  update materials set stock = stock + v_diff where id = m.id returning * into m;
  if v_diff <> 0 or p_kind = 'koreksi' then
    insert into material_moves (store_id, material_id, name, unit, qty, kind, stock_after, note, by_name)
      values (m.store_id, m.id, m.name, m.unit, v_diff, p_kind, m.stock, left(trim(coalesce(p_note, '')), 120), 'Pemilik');
  end if;
  return jsonb_build_object('stock', m.stock, 'diff', v_diff);
end $$;

revoke execute on function public.material_add(uuid, uuid, numeric, text, timestamptz), public.material_change(uuid, text, numeric, text) from public, anon;
grant execute on function public.material_add(uuid, uuid, numeric, text, timestamptz), public.material_change(uuid, text, numeric, text) to authenticated;

-- ---------- Saldo awal & saldo sekarang ----------
alter table public.stores add column if not exists opening_cash integer;
alter table public.stores add column if not exists opening_bank integer;
alter table public.stores add column if not exists opening_date date;
grant update (opening_cash, opening_bank, opening_date) on public.stores to authenticated;

-- Saldo = saldo awal + penjualan + pemasukan − pengeluaran (termasuk kasbon) sejak tanggal saldo awal
create or replace function public.store_balance(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s stores; v_from timestamptz; c_sale int; b_sale int; c_cf int; b_cf int;
begin
  if p_store is null or not public.is_owner(p_store) then raise exception 'Hanya pemilik toko'; end if;
  select * into s from stores where id = p_store;
  if s.opening_date is null then return jsonb_build_object('set', false); end if;
  v_from := s.opening_date::timestamp at time zone 'Asia/Jakarta';
  select coalesce(sum(total) filter (where method = 'tunai'), 0), coalesce(sum(total) filter (where method = 'qris'), 0)
    into c_sale, b_sale from transactions where store_id = p_store and not voided and created_at >= v_from;
  select coalesce(sum(case when type = 'masuk' then amount else -amount end) filter (where via = 'tunai'), 0),
         coalesce(sum(case when type = 'masuk' then amount else -amount end) filter (where via = 'bank'), 0)
    into c_cf, b_cf from cashflow where store_id = p_store and date >= s.opening_date;
  return jsonb_build_object('set', true, 'since', s.opening_date,
    'opening_cash', coalesce(s.opening_cash, 0), 'opening_bank', coalesce(s.opening_bank, 0),
    'cash', coalesce(s.opening_cash, 0) + c_sale + c_cf, 'bank', coalesce(s.opening_bank, 0) + b_sale + b_cf);
end $$;
revoke execute on function public.store_balance(uuid) from public, anon;
grant execute on function public.store_balance(uuid) to authenticated;

-- ---------- Kasbon ----------
create table if not exists public.advances (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  employee   text not null check (length(employee) between 1 and 40),
  kind       text not null check (kind in ('kasbon', 'bayar', 'potong')),   -- potong = dipotong dari gaji
  amount     integer not null check (amount > 0),
  via        text check (via in ('tunai', 'bank')),
  date       date not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists advances_store_idx on public.advances(store_id, date);
alter table public.advances enable row level security;
revoke all on public.advances from anon, authenticated;
grant select, delete on public.advances to authenticated;
drop policy if exists adv_select on public.advances;
drop policy if exists adv_delete on public.advances;
create policy adv_select on public.advances for select to authenticated using (public.is_owner(store_id));
create policy adv_delete on public.advances for delete to authenticated using (public.is_owner(store_id));

-- Uang kasbon ikut tercatat di catatan kas (keluar saat diberi, masuk saat dibayar tunai/rekening)
alter table public.cashflow add column if not exists advance_id uuid references public.advances(id) on delete cascade;

create or replace function public.add_advance(p_store uuid, p_employee text, p_kind text, p_amount integer, p_via text, p_date date, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a advances; v_name text := left(trim(coalesce(p_employee, '')), 40); v_owed int;
begin
  if p_store is null or not public.is_owner(p_store) then raise exception 'Hanya pemilik toko'; end if;
  if v_name = '' then raise exception 'Nama karyawan wajib diisi'; end if;
  if p_kind not in ('kasbon', 'bayar', 'potong') then raise exception 'Jenis kasbon tidak dikenal'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'Nominal tidak valid'; end if;
  if p_kind <> 'potong' and coalesce(p_via, '') not in ('tunai', 'bank') then raise exception 'Pilih tunai atau rekening'; end if;
  if p_kind <> 'kasbon' then
    select coalesce(sum(case when kind = 'kasbon' then amount else -amount end), 0) into v_owed
      from advances where store_id = p_store and lower(employee) = lower(v_name);
    if p_amount > v_owed then raise exception 'Melebihi sisa kasbon (%)', v_owed; end if;
  end if;
  insert into advances (store_id, employee, kind, amount, via, date, note)
    values (p_store, v_name, p_kind, p_amount, case when p_kind = 'potong' then null else p_via end,
            coalesce(p_date, (now() at time zone 'Asia/Jakarta')::date), left(trim(coalesce(p_note, '')), 120))
    returning * into a;
  if p_kind <> 'potong' then
    insert into cashflow (store_id, date, type, amount, cat, via, note, by_name, advance_id)
      values (p_store, a.date, case when p_kind = 'kasbon' then 'keluar' else 'masuk' end, a.amount,
              case when p_kind = 'kasbon' then 'Kasbon karyawan' else 'Bayar kasbon' end, a.via,
              a.employee || case when a.note <> '' then ' · ' || a.note else '' end, 'Pemilik', a.id);
  end if;
  return to_jsonb(a);
end $$;
revoke execute on function public.add_advance(uuid, text, text, integer, text, date, text) from public, anon;
grant execute on function public.add_advance(uuid, text, text, integer, text, date, text) to authenticated;

-- ---------- Realtime ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['transactions', 'cashflow', 'products', 'cash_sessions', 'materials', 'material_moves', 'advances'] loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- Hapus data per periode (isi 011, ditambah bahan & kasbon) ----------
create or replace function public.reset_period(p_store uuid, p_period text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_start date; v_end date; v_from timestamptz; v_to timestamptz;
  n_tx int := 0; n_cf int := 0; n_sm int := 0; n_cs int := 0; n_sh int := 0; n_mm int := 0; n_adv int := 0;
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
  perform pg_advisory_xact_lock(hashtext(p_store::text || to_char(v_today, 'YYYYMMDD')));

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

  -- stok bahan kembali seperti awal periode
  with m as (
    select id, material_id, qty from material_moves where store_id = p_store and created_at >= v_from and created_at < v_to
  ), back as (
    update materials x set stock = x.stock - s.q
    from (select material_id, sum(qty) q from m where material_id is not null group by material_id) s
    where x.id = s.material_id and x.store_id = p_store
    returning 1
  ), del as (delete from material_moves where id in (select id from m) returning 1)
  select count(*) into n_mm from del;

  with d as (delete from advances where store_id = p_store and date >= v_start and date < v_end returning 1)
  select count(*) into n_adv from d;
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
    'stock_moves', n_sm, 'cash_sessions', n_cs, 'shifts', n_sh, 'material_moves', n_mm, 'advances', n_adv);
end $$;

create or replace function public.reset_today(p_store uuid) returns jsonb
language sql security definer set search_path = public as $$ select public.reset_period(p_store, 'today') $$;

revoke execute on function public.reset_period(uuid, text) from public, anon;
grant execute on function public.reset_period(uuid, text) to authenticated;
revoke execute on function public.reset_today(uuid) from public, anon;
grant execute on function public.reset_today(uuid) to authenticated;

notify pgrst, 'reload schema';
