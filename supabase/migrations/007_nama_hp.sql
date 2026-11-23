-- =====================================================================
-- IniKasir migrasi 007: nama HP kasir otomatis + pemilik bisa ganti nama
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
-- Tidak bergantung pada migrasi lain. Aman dijalankan ulang.
--
-- - HP yang baru tersambung diberi nama "Kasir 1", "Kasir 2", ... (nomor kosong terkecil).
-- - HP yang sambung ulang tetap memakai namanya yang lama.
-- - Pemilik mengganti nama HP dari halaman admin (rename_device).
-- =====================================================================

create or replace function public.join_store(p_code text, p_pin text, p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store stores;
  v_sec   store_secrets;
  v_name  text;
  v_n     int;
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

  -- sambung ulang: nama lama dipertahankan
  select device_name into v_name from store_members where store_id = v_store.id and user_id = auth.uid();
  if found then
    update store_members set last_seen = now() where store_id = v_store.id and user_id = auth.uid();
  else
    v_name := left(nullif(trim(coalesce(p_device, '')), ''), 40);   -- aplikasi versi lama masih mengirim nama
    if v_name is null then
      select min(n) into v_n from generate_series(1, 1000) n
        where not exists (select 1 from store_members m where m.store_id = v_store.id and m.device_name = 'Kasir ' || n);
      v_name := 'Kasir ' || coalesce(v_n, 1);
    end if;
    insert into store_members (store_id, user_id, role, device_name, last_seen)
      values (v_store.id, auth.uid(), 'kasir', v_name, now());
  end if;
  return jsonb_build_object('ok', true, 'store_id', v_store.id, 'device_name', v_name);
end $$;

create or replace function public.rename_device(p_store uuid, p_user uuid, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_name text := left(trim(coalesce(p_name, '')), 40);
begin
  if not public.is_owner(p_store) then raise exception 'Hanya pemilik toko yang bisa mengganti nama HP'; end if;
  if v_name = '' then raise exception 'Nama HP tidak boleh kosong'; end if;
  update store_members set device_name = v_name where store_id = p_store and user_id = p_user and role = 'kasir';
  if not found then raise exception 'HP tidak ditemukan'; end if;
  return v_name;
end $$;

revoke execute on function public.rename_device(uuid, uuid, text) from public, anon;
grant execute on function public.rename_device(uuid, uuid, text) to authenticated;
