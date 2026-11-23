-- =====================================================================
-- IniKasir migrasi 005: kas harian (buka & tutup kasir) versi sederhana
-- Jalankan SEKALI di Supabase SQL Editor, setelah schema.sql.
-- Tidak bergantung pada 002/003/004. Tanpa akun karyawan atau PIN.
--
-- Alur: HP kasir "buka kasir" (kas awal) -> jualan -> "tutup kasir" (kas akhir).
-- Penjaga tidak melihat angka seharusnya; pemilik melihat selisih di admin.
-- Id sesi dibuat di HP supaya buka/tutup bisa dilakukan offline dan dikirim
-- belakangan tanpa dobel. Satu sesi terbuka per HP.
-- =====================================================================

create table public.cash_sessions (
  id           uuid primary key,
  store_id     uuid not null references public.stores(id) on delete cascade,
  device_user  uuid references auth.users(id) on delete set null,
  device_name  text not null default '',
  opened_at    timestamptz not null,
  opening_cash integer not null check (opening_cash between 0 and 1000000000),
  closed_at    timestamptz,
  closing_cash integer check (closing_cash between 0 and 1000000000),
  close_note   text not null default '',
  closed_by    text not null default ''        -- 'kasir', 'pemilik', atau 'otomatis'
);
create index cash_sessions_store_idx on public.cash_sessions(store_id, opened_at);
create unique index cash_sessions_one_open_per_device on public.cash_sessions(device_user) where closed_at is null;

alter table public.cash_sessions enable row level security;
revoke all on public.cash_sessions from anon, authenticated;
grant select on public.cash_sessions to authenticated;
create policy cs_select on public.cash_sessions for select to authenticated using (public.is_owner(store_id));

-- waktu dari HP dibatasi: tidak di masa depan, maksimal 7 hari ke belakang
create function public._clamp_time(t timestamptz) returns timestamptz
language sql stable as $$ select least(greatest(coalesce(t, now()), now() - interval '7 days'), now()) $$;

-- Buka kasir. Kalau HP ini masih punya sesi terbuka (lupa ditutup), sesi lama
-- ditutup otomatis tanpa kas akhir supaya kasir tetap bisa dipakai.
create function public.open_cash(p_id uuid, p_store uuid, p_opening integer, p_time timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s cash_sessions; v_time timestamptz := public._clamp_time(p_time);
begin
  if not public.is_member(p_store) then raise exception 'HP ini tidak terdaftar di toko'; end if;
  select * into s from cash_sessions where id = p_id;
  if found then return jsonb_build_object('id', s.id, 'opened_at', s.opened_at, 'opening_cash', s.opening_cash, 'duplicate', true); end if;
  if p_opening is null or p_opening < 0 or p_opening > 1000000000 then raise exception 'Kas awal tidak valid'; end if;
  update cash_sessions set closed_at = greatest(v_time, opened_at), closed_by = 'otomatis', close_note = 'Tidak ditutup, tertutup otomatis saat kasir dibuka lagi'
    where device_user = auth.uid() and closed_at is null;
  insert into cash_sessions (id, store_id, device_user, device_name, opened_at, opening_cash)
    values (p_id, p_store, auth.uid(),
      coalesce((select device_name from store_members where store_id = p_store and user_id = auth.uid()), ''), v_time, p_opening)
    returning * into s;
  return jsonb_build_object('id', s.id, 'opened_at', s.opened_at, 'opening_cash', s.opening_cash, 'duplicate', false);
end $$;

-- Tutup kasir (aman dipanggil ulang)
create function public.close_cash(p_id uuid, p_closing integer, p_note text, p_time timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s cash_sessions;
begin
  select * into s from cash_sessions where id = p_id and device_user = auth.uid();
  if not found then raise exception 'Sesi kasir tidak ditemukan di HP ini'; end if;
  if s.closed_at is not null then return jsonb_build_object('ok', true, 'already_closed', true); end if;
  if p_closing is null or p_closing < 0 or p_closing > 1000000000 then raise exception 'Kas akhir tidak valid'; end if;
  update cash_sessions set closed_at = greatest(public._clamp_time(p_time), opened_at), closing_cash = p_closing,
    close_note = left(coalesce(p_note, ''), 200), closed_by = 'kasir' where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- Sesi yang sedang terbuka di HP ini (misal setelah aplikasi dipasang ulang)
create function public.current_cash(p_store uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'opened_at', opened_at, 'opening_cash', opening_cash)
  from cash_sessions where store_id = p_store and device_user = auth.uid() and closed_at is null limit 1;
$$;

-- Pemilik menutup sesi yang lupa ditutup
create function public.force_close_cash(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  select store_id into v_store from cash_sessions where id = p_id and closed_at is null;
  if v_store is null then raise exception 'Sesi tidak ditemukan atau sudah ditutup'; end if;
  if not public.is_owner(v_store) then raise exception 'Hanya pemilik toko'; end if;
  update cash_sessions set closed_at = now(), closed_by = 'pemilik', close_note = 'Ditutup oleh pemilik (kas akhir tidak dihitung)' where id = p_id;
end $$;

revoke execute on function public.open_cash(uuid, uuid, integer, timestamptz), public.close_cash(uuid, integer, text, timestamptz),
  public.current_cash(uuid), public.force_close_cash(uuid) from public, anon;
grant execute on function public.open_cash(uuid, uuid, integer, timestamptz), public.close_cash(uuid, integer, text, timestamptz),
  public.current_cash(uuid), public.force_close_cash(uuid) to authenticated;
