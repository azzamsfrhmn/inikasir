// Uji migrasi 006: template produk sesuai jenis dagangan
import { setup, reporter } from "./harness.mjs";

export default async function () {
  const t = reporter("006 template jenis dagangan");
  const U = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444", "55555555-5555-5555-5555-555555555555", "66666666-6666-6666-6666-666666666666"];
  const { q, as, one, err } = await setup(["006_template_usaha.sql"], U);
  const count = async (u, s) => (await one(u, false, "select count(*)::int n from products where store_id=$1", [s])).n;

  const types = ["otakotak", "gorengan", "minuman", "jajanan", "kosong"];
  for (let i = 0; i < types.length; i++) {
    const s = await one(U[i], false, "select * from create_store($1,$2)", ["Toko " + types[i], types[i]]);
    const n = await count(U[i], s.id);
    t.ok(types[i] === "kosong" ? n === 0 : n >= 6, `template ${types[i]}: ${n} produk contoh`);
  }
  const g = await one(U[1], false, "select string_agg(name, ', ' order by name) n from products");
  t.ok(/Bakwan/.test(g.n) && !/Otak-otak/.test(g.n), "template gorengan berisi gorengan, bukan otak-otak");
  t.ok((await err(() => as(U[5], false, () => q("select create_store('X','sembarang')")))) !== null, "jenis dagangan tak dikenal ditolak");
  t.ok((await err(() => as(U[0], false, () => q("select create_store('Lagi','kosong')")))) !== null, "satu akun tetap hanya boleh satu toko");
  t.ok((await err(() => as(U[5], true, () => q("select create_store('Anon','jajanan')")))) !== null, "akun anonim (HP kasir) tidak bisa membuat toko");
  const old = await one(U[5], false, "select * from create_store('Toko lama')");
  t.ok((await count(U[5], old.id)) === 8, "create_store(nama) versi lama tetap jalan dengan template bawaan");
  return t.done();
}
