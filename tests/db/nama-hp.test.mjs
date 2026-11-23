// Uji migrasi 007: nama HP kasir otomatis "Kasir N" + pemilik ganti nama
import { setup, reporter } from "./harness.mjs";

export default async function () {
  const t = reporter("007 nama HP kasir");
  const O = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222";
  const H = ["a1111111-1111-1111-1111-111111111111", "a2222222-2222-2222-2222-222222222222", "a3333333-3333-3333-3333-333333333333", "a4444444-4444-4444-4444-444444444444"];
  const { q, as, one, err } = await setup(["007_nama_hp.sql"], [O, O2, ...H]);
  const s = await one(O, false, "select * from create_store('Toko A')");
  const s2 = await one(O2, false, "select * from create_store('Toko B')");
  await as(O, false, () => q("select set_kasir_pin($1,'1234')", [s.id]));
  const join = async (u, dev = "") => (await one(u, true, "select join_store($1,'1234',$2) r", [s.join_code, dev])).r;
  const names = async () => (await one(O, false, "select string_agg(device_name, ',' order by created_at) n from store_members where store_id=$1 and role='kasir'", [s.id])).n;

  t.ok((await join(H[0])).device_name === "Kasir 1", "HP pertama jadi Kasir 1");
  t.ok((await join(H[1])).device_name === "Kasir 2", "HP kedua jadi Kasir 2");
  t.ok((await join(H[0])).device_name === "Kasir 1" && (await names()) === "Kasir 1,Kasir 2", "sambung ulang tidak membuat nama baru");
  t.ok((await join(H[2], "HP lama")).device_name === "HP lama", "aplikasi lama yang mengirim nama tetap dihormati");

  const r = await one(O, false, "select rename_device($1,$2,'  Gerobak depan ') n", [s.id, H[0]]);
  t.ok(r.n === "Gerobak depan", "pemilik ganti nama HP");
  t.ok((await join(H[0])).device_name === "Gerobak depan", "nama hasil ganti bertahan saat sambung ulang");
  t.ok((await join(H[3])).device_name === "Kasir 1", "nomor kosong terkecil dipakai lagi");

  t.ok((await err(() => as(H[1], true, () => q("select rename_device($1,$2,'X')", [s.id, H[1]])))) !== null, "HP kasir tidak bisa ganti nama sendiri");
  t.ok((await err(() => as(O2, false, () => q("select rename_device($1,$2,'X')", [s.id, H[1]])))) !== null, "pemilik toko lain tidak bisa ganti nama");
  t.ok((await err(() => as(O, false, () => q("select rename_device($1,$2,'   ')", [s.id, H[1]])))) !== null, "nama kosong ditolak");
  t.ok((await err(() => as(O, false, () => q("select rename_device($1,$2,'X')", [s.id, O])))) !== null, "akun pemilik tidak bisa diganti lewat fungsi ini");
  void s2;
  return t.done();
}
