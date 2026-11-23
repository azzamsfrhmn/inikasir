-- =====================================================================
-- IniKasir migrasi 003: stok barang jadi, harga beli (modal), HPP
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
-- Tidak bergantung pada migrasi 002 (karyawan/shift) dan tetap cocok kalau
-- 002 dipasang belakangan.
--
-- - Modal per produk disimpan di tabel product_costs yang HANYA bisa dibaca
--   pemilik (HP kasir tidak bisa melihat modal).
-- - Setiap penjualan: modal per item dikunci di transaksi (kolom costs &
--   cost_total) dan stok produk yang dilacak otomatis berkurang (trigger).
-- - Transaksi dibatalkan: stok dikembalikan.
-- - Stok masuk memakai modal rata-rata tertimbang.
-- =====================================================================

-- ---------- Kolom & tabel ----------
alter table public.products add column track_stock boolean not null default false;
alter table public.products add column stock integer not null default 0;

alter table public.transactions add column costs jsonb not null default '[]'::jsonb;  -- modal per item, urut sama dengan items
alter table public.transactions add column cost_total integer not null default 0;

create table public.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,
  cost       integer not null default 0 check (cost >= 0),
  updated_at timestamptz not null default now()
);

create table public.stock_moves (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  product_id   uuid references public.products(id) on delete cascade,
  product_name text not null,
  qty          integer not null,                 -- + masuk, - keluar
  kind         text not null check (kind in ('masuk', 'koreksi', 'terjual', 'batal', 'awal')),
  unit_cost    integer,                          -- harga beli per unit (untuk stok masuk)
  stock_after  integer not null,
  note         text not null default '',
  tx_id        uuid references public.transactions(id) on delete set null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null
);
create index stock_moves_product_idx on public.stock_moves(product_id, created_at desc);

-- ---------- Izin & RLS ----------
alter table public.product_costs enable row level security;
alter table public.stock_moves  enable row level security;

-- stok hanya boleh berubah lewat fungsi (supaya selalu tercatat di riwayat)
revoke insert, update on public.products from authenticated;
grant insert (store_id, name, price, cat, active, track_stock) on public.products to authenticated;
grant update (name, price, cat, active, track_stock) on public.products to authenticated;
grant select on public.products to authenticated;

-- modal: hanya pemilik
revoke all on public.product_costs from anon, authenticated;
grant select, insert, update, delete on public.product_costs to authenticated;
create policy pc_all on public.product_costs for all to authenticated
  using (public.is_owner(store_id))
  with check (public.is_owner(store_id) and exists (select 1 from products p where p.id = product_id and p.store_id = product_costs.store_id));

-- riwayat stok: hanya pemilik membaca; ditulis lewat fungsi/trigger
revoke all on public.stock_moves from anon, authenticated;
grant select on public.stock_moves to authenticated;
create policy sm_select on public.stock_moves for select to authenticated using (public.is_owner(store_id));

-- ---------- Trigger penjualan ----------
create function public._uuid_or_null(t text) returns uuid
language sql immutable as $$
  select case when t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then t::uuid end;
$$;

-- Sebelum transaksi disimpan: kunci modal per item
create function public._tx_lock_costs() returns trigger
language plpgsql security definer set search_path = public as $$
declare it jsonb; v_cost integer; v_costs jsonb := '[]'::jsonb; v_total integer := 0;
begin
  for it in select * from jsonb_array_elements(new.items) loop
    select cost into v_cost from product_costs where product_id = public._uuid_or_null(it ->> 'product_id');
    v_cost := coalesce(v_cost, 0);
    v_costs := v_costs || to_jsonb(v_cost);
    v_total := v_total + v_cost * coalesce((it ->> 'qty')::integer, 0);
  end loop;
  new.costs := v_costs; new.cost_total := v_total;
  return new;
end $$;
create trigger tx_lock_costs before insert on public.transactions for each row execute function public._tx_lock_costs();

-- Setelah transaksi disimpan / dibatalkan: kurangi / kembalikan stok
create function public._tx_apply_stock(t public.transactions, sign integer, kind text) returns void
language plpgsql security definer set search_path = public as $$
declare it jsonb; p products; v_qty integer;
begin
  for it in select * from jsonb_array_elements(t.items) loop
    v_qty := coalesce((it ->> 'qty')::integer, 0);
    update products set stock = stock + sign * v_qty
      where id = public._uuid_or_null(it ->> 'product_id') and store_id = t.store_id and track_stock
      returning * into p;
    if found then
      insert into stock_moves (store_id, product_id, product_name, qty, kind, stock_after, tx_id, created_by, note)
        values (t.store_id, p.id, p.name, sign * v_qty, kind, p.stock, t.id, t.created_by, coalesce(t.no, ''));
    end if;
  end loop;
end $$;

create function public._tx_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.voided then perform public._tx_apply_stock(new, -1, 'terjual'); end if;
  return null;
end $$;
create trigger tx_after_insert after insert on public.transactions for each row execute function public._tx_after_insert();

create function public._tx_after_void() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.voided and not old.voided then perform public._tx_apply_stock(new, 1, 'batal'); end if;
  return null;
end $$;
create trigger tx_after_void after update of voided on public.transactions for each row execute function public._tx_after_void();

revoke execute on function public._tx_apply_stock(public.transactions, integer, text), public._tx_lock_costs(),
  public._tx_after_insert(), public._tx_after_void() from public, anon, authenticated;

-- ---------- Fungsi pemilik ----------
-- Stok masuk (beli/produksi). Modal baru = rata-rata tertimbang stok lama & stok masuk.
create function public.add_stock(p_product uuid, p_qty integer, p_unit_cost integer, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p products; v_old integer; v_new integer;
begin
  select * into p from products where id = p_product for update;
  if not found or not public.is_owner(p.store_id) then raise exception 'Hanya pemilik toko'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then raise exception 'Jumlah stok masuk tidak valid'; end if;
  if p_unit_cost is not null and (p_unit_cost < 0 or p_unit_cost > 100000000) then raise exception 'Harga beli tidak valid'; end if;
  select cost into v_old from product_costs where product_id = p.id;
  v_new := coalesce(v_old, 0);
  if p_unit_cost is not null then
    v_new := case when greatest(p.stock, 0) = 0 or v_old is null then p_unit_cost
      else round((greatest(p.stock, 0)::numeric * v_old + p_qty::numeric * p_unit_cost) / (greatest(p.stock, 0) + p_qty)) end;
    insert into product_costs (product_id, store_id, cost, updated_at) values (p.id, p.store_id, v_new, now())
      on conflict (product_id) do update set cost = excluded.cost, updated_at = now();
  end if;
  update products set stock = stock + p_qty, track_stock = true where id = p.id returning * into p;
  insert into stock_moves (store_id, product_id, product_name, qty, kind, unit_cost, stock_after, note)
    values (p.store_id, p.id, p.name, p_qty, 'masuk', p_unit_cost, p.stock, left(coalesce(p_note, ''), 120));
  return jsonb_build_object('stock', p.stock, 'cost', v_new);
end $$;

-- Koreksi stok (hitung fisik) atau stok awal
create function public.set_stock(p_product uuid, p_qty integer, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p products; v_diff integer;
begin
  select * into p from products where id = p_product for update;
  if not found or not public.is_owner(p.store_id) then raise exception 'Hanya pemilik toko'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 1000000 then raise exception 'Jumlah stok tidak valid'; end if;
  v_diff := p_qty - p.stock;
  update products set stock = p_qty, track_stock = true where id = p.id returning * into p;
  if v_diff <> 0 or not exists (select 1 from stock_moves where product_id = p.id) then
    insert into stock_moves (store_id, product_id, product_name, qty, kind, stock_after, note)
      values (p.store_id, p.id, p.name, v_diff,
        case when exists (select 1 from stock_moves where product_id = p.id) then 'koreksi' else 'awal' end,
        p.stock, left(coalesce(p_note, ''), 120));
  end if;
  return jsonb_build_object('stock', p.stock, 'diff', v_diff);
end $$;

revoke execute on function public.add_stock(uuid, integer, integer, text), public.set_stock(uuid, integer, text) from public, anon;
grant execute on function public.add_stock(uuid, integer, integer, text), public.set_stock(uuid, integer, text) to authenticated;
