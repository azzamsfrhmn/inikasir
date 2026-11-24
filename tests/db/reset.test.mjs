// Uji migrasi 010: reset data hari ini
import { setup, reporter } from "./harness.mjs";

export default async function () {
  const t = reporter("010 reset data hari ini");
  const O = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222", H = "a1111111-1111-1111-1111-111111111111";
  const { q, as, one, err } = await setup(["003_stok_hpp.sql", "005_kas_harian.sql", "010_reset_hari_ini.sql"], [O, O2, H]);
  const s = await one(O, false, "select * from create_store('Toko A')");
  const s2 = await one(O2, false, "select * from create_store('Toko B')");
  await as(O, false, () => q("select set_kasir_pin($1,'1234')", [s.id]));
  await as(H, true, () => q("select join_store($1,'1234','')", [s.join_code]));
  const pid = (await one(O, false, "select id from products where store_id=$1 order by name limit 1", [s.id])).id;
  const pid2 = (await one(O2, false, "select id from products where store_id=$1 order by name limit 1", [s2.id])).id;
  const stock = async (id) => (await q("select stock from products where id=$1", [id])).rows[0].stock;
  const count = async (tbl, store) => (await q(`select count(*)::int n from ${tbl} where store_id=$1`, [store])).rows[0].n;
  const items = (id, n) => JSON.stringify([{ product_id: id, qty: n }]);
  const uid = (n) => `b${String(n).padStart(7, "0")}-1111-1111-1111-111111111111`;

  // Kemarin: stok awal 20, terjual 2 (tercatat langsung kemarin, diset lewat SQL)
  await as(O, false, () => q("select set_stock($1, 20, 'awal')", [pid]));
  await as(H, true, () => q("select record_sale($1,$2,$3,'tunai',null, now() - interval '2 days')", [uid(1), s.id, items(pid, 2)]));
  await q("update stock_moves set created_at = now() - interval '2 days' where store_id = $1", [s.id]);
  await q("insert into cashflow (store_id, date, type, cat, amount, via) values ($1, current_date - 3, 'keluar', 'Gas', 20000, 'tunai')", [s.id]);
  const pagi = await stock(pid);   // stok awal hari ini = 18
  // Penjualan kemarin yang baru terkirim hari ini (offline): harus tetap ada
  await as(H, true, () => q("select record_sale($1,$2,$3,'tunai',null, now() - interval '2 days')", [uid(2), s.id, items(pid, 1)]));
  const setelahOffline = await stock(pid);   // 17
  // Hari ini: stok masuk 10, terjual 3 + 4 (satu dibatalkan), catat pengeluaran, buka kasir
  await as(O, false, () => q("select add_stock($1, 10, null, '')", [pid]));
  await as(H, true, () => q("select record_sale($1,$2,$3,'qris',null, now())", [uid(3), s.id, items(pid, 3)]));
  await as(H, true, () => q("select record_sale($1,$2,$3,'tunai',null, now())", [uid(4), s.id, items(pid, 4)]));
  await as(O, false, () => q("update transactions set voided = true, voided_at = now() where id = $1", [uid(4)]));
  await as(O, false, () => q("insert into cashflow (store_id, date, type, cat, amount, via) values ($1, (now() at time zone 'Asia/Jakarta')::date, 'keluar', 'Bahan baku', 50000, 'tunai')", [s.id]));
  await as(H, true, () => q("select open_cash($1,$2,30000, now())", ["c1111111-1111-1111-1111-111111111111", s.id]));
  // Toko lain hari ini
  await as(O2, false, () => q("select set_stock($1, 5, 'awal')", [pid2]));
  await as(O2, false, () => q("select record_sale($1,$2,$3,'tunai',null, now())", [uid(9), s2.id, items(pid2, 1)]));
  const lainSebelum = [await count("transactions", s2.id), await stock(pid2)];

  t.ok((await err(() => as(H, true, () => q("select reset_today($1)", [s.id])))) !== null, "HP kasir tidak bisa mereset");
  t.ok((await err(() => as(O2, false, () => q("select reset_today($1)", [s.id])))) !== null, "pemilik toko lain tidak bisa mereset toko ini");

  const r = (await one(O, false, "select reset_today($1) r", [s.id])).r;
  t.ok(r.transactions === 2 && r.cashflow === 1 && r.cash_sessions === 1, `menghapus penjualan, catatan kas, dan buka kasir hari ini (${JSON.stringify(r)})`);
  const tx = (await q("select id from transactions where store_id=$1 order by id", [s.id])).rows.map((x) => x.id);
  t.ok(tx.length === 2 && tx.includes(uid(1)) && tx.includes(uid(2)), "penjualan hari sebelumnya tetap ada, termasuk yang baru terkirim hari ini");
  t.ok((await stock(pid)) === setelahOffline, `stok kembali seperti sebelum coba-coba hari ini (${await stock(pid)}, pagi ${pagi})`);
  t.ok((await count("cashflow", s.id)) === 1, "catatan kas hari lain tetap ada");
  t.ok((await count("stock_moves", s.id)) === 3, "riwayat stok hari sebelumnya tetap ada");
  t.ok(lainSebelum[0] === (await count("transactions", s2.id)) && lainSebelum[1] === (await stock(pid2)), "data toko lain tidak tersentuh");
  const r2 = (await one(O, false, "select reset_today($1) r", [s.id])).r;
  t.ok(r2.transactions === 0 && (await stock(pid)) === setelahOffline, "dijalankan dua kali aman");
  const no = (await one(H, true, "select record_sale($1,$2,$3,'tunai',null, now()) r", [uid(5), s.id, items(pid, 1)])).r;
  t.ok(/-001$/.test(no.no || ""), `nomor transaksi mulai lagi dari 001 setelah reset (${no.no})`);
  return t.done();
}
