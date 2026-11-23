-- =====================================================================
-- IniKasir: skema database Supabase
-- Cara pakai: Supabase Dashboard > SQL Editor > New query > tempel semua
-- isi file ini > Run. Aman dijalankan sekali di proyek baru.
--
-- Peran:
--   owner : pemilik toko (daftar pakai email). Bisa lihat & atur semuanya.
--   kasir : HP penjaga yang disambungkan pakai kode toko + PIN kasir.
--           Hanya bisa membaca produk & info toko, dan mencatat penjualan.
--           TIDAK bisa membaca transaksi, laporan, atau keuangan.
-- =====================================================================

-- ---------- Tabel ----------
create table public.stores (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null default 'Toko Saya',
  address      text not null default '',
  phone        text not null default '',
  qris_string  text not null default '',
  qris_image   text not null default '',
  dynamic_qris boolean not null default true,
  join_code    text not null unique,
  created_at   timestamptz not null default now()
);

-- Rahasia toko: tidak bisa dibaca siapa pun lewat API, hanya lewat fungsi di bawah.
create table public.store_secrets (
  store_id        uuid primary key references public.stores(id) on delete cascade,
  kasir_pin_hash  text,
  failed_attempts int not null default 0,
  locked_until    timestamptz
);

create table public.store_members (
  store_id    uuid not null references public.stores(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'kasir')),
  device_name text not null default '',
  created_at  timestamptz not null default now(),
  last_seen   timestamptz,
  primary key (store_id, user_id)
);

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null check (length(name) between 1 and 80),
  price      integer not null check (price >= 0),
  cat        text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index products_store_idx on public.products(store_id);

create table public.transactions (
  id         uuid primary key,              -- dibuat di HP kasir, supaya kirim ulang (offline) tidak dobel
  store_id   uuid not null references public.stores(id) on delete cascade,
  no         text not null,
  created_at timestamptz not null,
  synced_at  timestamptz not null default now(),
  items      jsonb not null,                -- [{product_id, name, price, qty}]
  total      integer not null,
  method     text not null check (method in ('tunai', 'qris')),
  paid       integer not null,
  change     integer not null,
  voided     boolean not null default false,
  voided_at  timestamptz,
  created_by uuid references auth.users(id) on delete set null
);
create index transactions_store_time_idx on public.transactions(store_id, created_at);

create table public.cashflow (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  date       date not null,
  type       text not null check (type in ('masuk', 'keluar')),
  amount     integer not null check (amount > 0),
  cat        text not null default 'Lainnya',
  via        text not null check (via in ('tunai', 'bank')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);
create index cashflow_store_date_idx on public.cashflow(store_id, date);

-- ---------- Fungsi bantu peran ----------
create function public.is_owner(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from store_members where store_id = s and user_id = auth.uid() and role = 'owner');
$$;

create function public.is_member(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from store_members where store_id = s and user_id = auth.uid());
$$;

create function public._is_anonymous() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

create function public._pin_hash(s uuid, pin text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(s::text || ':inikasir:' || pin, 'UTF8')), 'hex');
$$;

-- ---------- Row Level Security ----------
alter table public.stores        enable row level security;
alter table public.store_secrets enable row level security;
alter table public.store_members enable row level security;
alter table public.products      enable row level security;
alter table public.transactions  enable row level security;
alter table public.cashflow      enable row level security;

-- stores: anggota boleh baca (kasir butuh nama toko & QRIS); hanya owner boleh ubah
create policy stores_select on public.stores for select to authenticated using (public.is_member(id));
create policy stores_update on public.stores for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
revoke insert, update, delete on public.stores from anon, authenticated;
grant update (name, address, phone, qris_string, qris_image, dynamic_qris) on public.stores to authenticated;

-- store_secrets: tidak ada policy = tidak bisa diakses lewat API
revoke all on public.store_secrets from anon, authenticated;

-- store_members: owner lihat semua HP di tokonya; tiap user lihat keanggotaannya sendiri
create policy members_select on public.store_members for select to authenticated
  using (user_id = auth.uid() or public.is_owner(store_id));
create policy members_delete on public.store_members for delete to authenticated
  using (public.is_owner(store_id) and role = 'kasir');
revoke insert, update on public.store_members from anon, authenticated;

-- products: anggota baca, owner kelola
create policy products_select on public.products for select to authenticated using (public.is_member(store_id));
create policy products_insert on public.products for insert to authenticated with check (public.is_owner(store_id));
create policy products_update on public.products for update to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));
create policy products_delete on public.products for delete to authenticated using (public.is_owner(store_id));

-- transactions: HANYA owner yang bisa baca. Kasir mencatat lewat fungsi record_sale.
create policy tx_select on public.transactions for select to authenticated using (public.is_owner(store_id));
create policy tx_update on public.transactions for update to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));
revoke insert, update, delete on public.transactions from anon, authenticated;
grant update (voided, voided_at) on public.transactions to authenticated;

-- cashflow: hanya owner
create policy cf_all on public.cashflow for all to authenticated using (public.is_owner(store_id)) with check (public.is_owner(store_id));

revoke all on all tables in schema public from anon;

-- ---------- Fungsi yang dipanggil aplikasi ----------

-- Owner membuat toko (sekali, setelah daftar & login)
create function public.create_store(p_name text) returns public.stores
language plpgsql security definer set search_path = public as $$
declare
  v_store stores;
  v_code  text;
begin
  if auth.uid() is null or public._is_anonymous() then
    raise exception 'Harus login dengan akun pemilik';
  end if;
  if exists (select 1 from store_members where user_id = auth.uid() and role = 'owner') then
    raise exception 'Akun ini sudah punya toko';
  end if;
  loop
    v_code := upper(substr(translate(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when length(v_code) = 6 and not exists (select 1 from stores where join_code = v_code);
  end loop;
  insert into stores (owner_id, name, join_code)
    values (auth.uid(), coalesce(nullif(trim(p_name), ''), 'Toko Saya'), v_code)
    returning * into v_store;
  insert into store_members (store_id, user_id, role, device_name) values (v_store.id, auth.uid(), 'owner', 'Pemilik');
  insert into store_secrets (store_id) values (v_store.id);
  insert into products (store_id, name, price, cat) values
    (v_store.id, 'Otak-otak ikan', 2000, 'Otak-otak'),
    (v_store.id, 'Otak-otak isi telur', 3000, 'Otak-otak'),
    (v_store.id, 'Otak-otak keju', 3000, 'Otak-otak'),
    (v_store.id, 'Paket 10 otak-otak', 18000, 'Paket'),
    (v_store.id, 'Cilok', 1000, 'Jajanan'),
    (v_store.id, 'Tahu bakso', 3000, 'Jajanan'),
    (v_store.id, 'Sosis bakar', 5000, 'Jajanan'),
    (v_store.id, 'Es teh', 3000, 'Minuman');
  return v_store;
end $$;

-- Owner mengatur PIN kasir (dipakai saat menyambungkan HP penjaga)
create function public.set_kasir_pin(p_store uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_store) then raise exception 'Hanya pemilik toko'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN harus 4 sampai 6 angka'; end if;
  update store_secrets set kasir_pin_hash = public._pin_hash(p_store, p_pin), failed_attempts = 0, locked_until = null
    where store_id = p_store;
end $$;

create function public.has_kasir_pin(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner(p_store) and exists (select 1 from store_secrets where store_id = p_store and kasir_pin_hash is not null);
$$;

-- Owner mengganti kode toko (misal kalau kode bocor). HP yang sudah tersambung tetap tersambung.
create function public.regenerate_join_code(p_store uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.is_owner(p_store) then raise exception 'Hanya pemilik toko'; end if;
  loop
    v_code := upper(substr(translate(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when length(v_code) = 6 and not exists (select 1 from stores where join_code = v_code);
  end loop;
  update stores set join_code = v_code where id = p_store;
  return v_code;
end $$;

-- HP kasir (login anonim) bergabung ke toko pakai kode toko + PIN kasir.
-- Mengembalikan {ok, store_id} atau {ok:false, error}. Tidak memakai exception,
-- supaya hitungan salah PIN tetap tersimpan. Terkunci 15 menit setelah 8x salah.
create function public.join_store(p_code text, p_pin text, p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store stores;
  v_sec   store_secrets;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'Sesi tidak valid, muat ulang halaman'); end if;
  select * into v_store from stores where join_code = upper(trim(p_code));
  if not found then return jsonb_build_object('ok', false, 'error', 'Kode toko tidak ditemukan'); end if;
  select * into v_sec from store_secrets where store_id = v_store.id for update;
  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Terlalu banyak PIN salah. Coba lagi 15 menit lagi');
  end if;
  if v_sec.kasir_pin_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Pemilik belum membuat PIN kasir di halaman admin');
  end if;
  if v_sec.kasir_pin_hash <> public._pin_hash(v_store.id, coalesce(p_pin, '')) then
    update store_secrets set
      failed_attempts = case when failed_attempts + 1 >= 8 then 0 else failed_attempts + 1 end,
      locked_until    = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else null end
      where store_id = v_store.id;
    return jsonb_build_object('ok', false, 'error', 'PIN kasir salah');
  end if;
  update store_secrets set failed_attempts = 0, locked_until = null where store_id = v_store.id;
  insert into store_members (store_id, user_id, role, device_name, last_seen)
    values (v_store.id, auth.uid(), 'kasir', left(coalesce(nullif(trim(p_device), ''), 'HP kasir'), 40), now())
    on conflict (store_id, user_id) do update set device_name = excluded.device_name, last_seen = now();
  return jsonb_build_object('ok', true, 'store_id', v_store.id);
end $$;

-- Kasir/owner mencatat penjualan. Harga diambil dari tabel produk (bukan dari HP),
-- kecuali produknya sudah dihapus. Aman dipanggil ulang dengan id yang sama.
create function public.record_sale(p_id uuid, p_store uuid, p_items jsonb, p_method text, p_paid integer, p_time timestamptz)
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
begin
  if not public.is_member(p_store) then raise exception 'HP ini tidak terdaftar di toko'; end if;
  select * into v_tx from transactions where id = p_id;
  if found then
    return jsonb_build_object('id', v_tx.id, 'no', v_tx.no, 'total', v_tx.total, 'created_at', v_tx.created_at, 'duplicate', true);
  end if;
  if p_method not in ('tunai', 'qris') then raise exception 'Metode bayar tidak dikenal'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Pesanan kosong'; end if;

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

  -- waktu dari HP (penting untuk transaksi offline), dibatasi maksimal 7 hari ke belakang
  v_time := least(greatest(coalesce(p_time, now()), now() - interval '7 days'), now());
  v_day  := to_char(v_time at time zone 'Asia/Jakarta', 'YYYYMMDD');
  perform pg_advisory_xact_lock(hashtext(p_store::text || v_day));
  select count(*) + 1 into v_seq from transactions
    where store_id = p_store and to_char(created_at at time zone 'Asia/Jakarta', 'YYYYMMDD') = v_day;
  v_paid := case when p_method = 'qris' then v_total else greatest(coalesce(p_paid, v_total), v_total) end;

  insert into transactions (id, store_id, no, created_at, items, total, method, paid, change, created_by)
    values (p_id, p_store, v_day || '-' || lpad(v_seq::text, 3, '0'), v_time, v_items, v_total, p_method, v_paid, v_paid - v_total, auth.uid())
    returning * into v_tx;
  update store_members set last_seen = now() where store_id = p_store and user_id = auth.uid();
  return jsonb_build_object('id', v_tx.id, 'no', v_tx.no, 'total', v_tx.total, 'created_at', v_tx.created_at, 'items', v_tx.items, 'duplicate', false);
end $$;

-- Hak eksekusi: hanya user yang login (termasuk HP kasir anonim)
revoke execute on function public.create_store(text), public.set_kasir_pin(uuid, text), public.has_kasir_pin(uuid),
  public.regenerate_join_code(uuid), public.join_store(text, text, text),
  public.record_sale(uuid, uuid, jsonb, text, integer, timestamptz),
  public.is_owner(uuid), public.is_member(uuid)
  from public, anon;
grant execute on function public.create_store(text), public.set_kasir_pin(uuid, text), public.has_kasir_pin(uuid),
  public.regenerate_join_code(uuid), public.join_store(text, text, text),
  public.record_sale(uuid, uuid, jsonb, text, integer, timestamptz),
  public.is_owner(uuid), public.is_member(uuid)
  to authenticated;
revoke execute on function public._pin_hash(uuid, text) from public, anon, authenticated;
