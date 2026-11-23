-- =====================================================================
-- IniKasir migrasi 006: template produk sesuai jenis dagangan saat buat toko
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
-- Tidak bergantung pada migrasi lain. create_store(p_name) lama tetap ada
-- (memakai template otak-otak) supaya aplikasi versi lama tidak rusak.
--
-- Jenis: 'otakotak', 'gorengan', 'minuman', 'jajanan', 'kosong'.
-- Harga hanya contoh; pemilik mengubahnya di menu Produk.
-- =====================================================================

create function public.create_store(p_name text, p_type text) returns public.stores
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
  if coalesce(p_type, '') not in ('otakotak', 'gorengan', 'minuman', 'jajanan', 'kosong') then
    raise exception 'Jenis dagangan tidak dikenal';
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

  insert into products (store_id, name, price, cat)
  select v_store.id, t.name, t.price, t.cat from (values
    ('otakotak', 'Otak-otak ikan', 2000, 'Otak-otak'), ('otakotak', 'Otak-otak isi telur', 3000, 'Otak-otak'),
    ('otakotak', 'Otak-otak keju', 3000, 'Otak-otak'), ('otakotak', 'Paket 10 otak-otak', 18000, 'Paket'),
    ('otakotak', 'Siomay', 5000, 'Jajanan'), ('otakotak', 'Es teh', 3000, 'Minuman'),
    ('gorengan', 'Bakwan', 1000, 'Gorengan'), ('gorengan', 'Tahu isi', 1000, 'Gorengan'), ('gorengan', 'Tempe mendoan', 1000, 'Gorengan'),
    ('gorengan', 'Pisang goreng', 1500, 'Gorengan'), ('gorengan', 'Cireng', 1000, 'Gorengan'), ('gorengan', 'Risol', 2000, 'Gorengan'),
    ('gorengan', 'Es teh', 3000, 'Minuman'),
    ('minuman', 'Es teh manis', 3000, 'Teh'), ('minuman', 'Teh tarik', 6000, 'Teh'), ('minuman', 'Es jeruk', 4000, 'Segar'),
    ('minuman', 'Es kopi susu', 8000, 'Kopi'), ('minuman', 'Es cokelat', 6000, 'Susu & cokelat'), ('minuman', 'Air mineral', 4000, 'Lainnya'),
    ('jajanan', 'Cilok', 1000, 'Jajanan'), ('jajanan', 'Batagor', 5000, 'Jajanan'), ('jajanan', 'Siomay', 5000, 'Jajanan'),
    ('jajanan', 'Sosis bakar', 5000, 'Bakar'), ('jajanan', 'Telur gulung', 1000, 'Jajanan'), ('jajanan', 'Seblak', 10000, 'Pedas'),
    ('jajanan', 'Es teh', 3000, 'Minuman')
  ) as t(kind, name, price, cat)
  where t.kind = p_type;
  return v_store;
end $$;

revoke execute on function public.create_store(text, text) from public, anon;
grant execute on function public.create_store(text, text) to authenticated;
