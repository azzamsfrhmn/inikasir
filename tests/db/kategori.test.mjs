// Uji migrasi 009: daftar kategori per toko
import { setup, reporter, sqlFile } from "./harness.mjs";
import { readFileSync } from "fs";

export default async function () {
  const t = reporter("009 kategori");
  const O = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222", H = "a1111111-1111-1111-1111-111111111111";
  const { db, q, as, one, err } = await setup([], [O, O2, H]);
  const s = await one(O, false, "select * from create_store('Toko A')");
  const s2 = await one(O2, false, "select * from create_store('Toko B')");
  await db.exec(readFileSync(sqlFile("009_kategori.sql"), "utf8"));
  const cats = async (id) => (await q("select categories c from stores where id=$1", [id])).rows[0].c;
  const c1 = await cats(s.id);
  t.ok(Array.isArray(c1) && c1.length > 0 && [...c1].sort().join() === c1.join(), `toko lama terisi dari kategori produk: ${c1.join(", ")}`);

  await as(O, false, () => q("update stores set categories = $2 where id = $1", [s.id, JSON.stringify(["Minuman", "Otak-otak"])]));
  t.ok((await cats(s.id)).join() === "Minuman,Otak-otak", "pemilik bisa mengubah dan mengurutkan kategori");
  await db.exec(readFileSync(sqlFile("009_kategori.sql"), "utf8"));
  t.ok((await cats(s.id)).join() === "Minuman,Otak-otak", "dijalankan ulang tidak menimpa kategori yang sudah diatur");

  await as(O2, false, () => q("update stores set categories = '[\"X\"]' where id = $1", [s.id]));
  t.ok((await cats(s.id)).join() === "Minuman,Otak-otak", "pemilik toko lain tidak bisa mengubah");
  await as(O, false, () => q("select set_kasir_pin($1,'1234')", [s.id]));
  await as(H, true, () => q("select join_store($1,'1234','HP')", [s.join_code]));
  await as(H, true, () => q("update stores set categories = '[\"X\"]' where id = $1", [s.id])).catch(() => {});
  t.ok((await cats(s.id)).join() === "Minuman,Otak-otak", "HP kasir tidak bisa mengubah");
  const seen = (await one(H, true, "select categories c from stores where id=$1", [s.id])).c;
  t.ok(seen.join() === "Minuman,Otak-otak", "HP kasir bisa membaca urutan kategori");
  t.ok((await err(() => as(O, false, () => q("update stores set categories = '{\"a\":1}' where id = $1", [s.id])))) !== null, "bukan daftar ditolak");
  void s2;
  return t.done();
}
