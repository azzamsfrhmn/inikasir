// Uji migrasi 011: hapus data bulan ini / tahun ini (batas periode menurut WIB)
import { setup, reporter } from "./harness.mjs";

export default async function () {
  const t = reporter("011 hapus data per periode");
  const O = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222";
  const { q, as, one, err } = await setup(["003_stok_hpp.sql", "005_kas_harian.sql", "010_reset_hari_ini.sql", "011_reset_periode.sql"], [O, O2]);
  const s = await one(O, false, "select * from create_store('Toko A')");
  const pid = (await one(O, false, "select id from products where store_id=$1 order by name limit 1", [s.id])).id;
  await q("update products set track_stock = true, stock = 100 where id = $1", [pid]);

  // Titik waktu (WIB): tahun lalu, awal tahun ini, awal bulan ini, hari ini
  const B = `((now() at time zone 'Asia/Jakarta')::date)`;
  const at = {
    lalu: `((date_trunc('year', ${B}) - interval '2 days')::timestamp at time zone 'Asia/Jakarta')`,
    tahun: `((date_trunc('year', ${B}) + interval '1 hour')::timestamp at time zone 'Asia/Jakarta')`,
    bulan: `((date_trunc('month', ${B}) + interval '2 hours')::timestamp at time zone 'Asia/Jakarta')`,
    hari: `now()`,
  };
  const deltas = { lalu: -5, tahun: -7, bulan: -11, hari: -13 };
  let i = 0;
  for (const [k, expr] of Object.entries(at)) {
    i++;
    const id = `d${i}000000-1111-1111-1111-111111111111`;
    await q(`insert into transactions (id, store_id, no, created_at, items, total, method, paid, change)
             select $1, $2, 'X${i}', ${expr}, '[]', 1000, 'tunai', 1000, 0`, [id, s.id]);
    await q(`insert into stock_moves (store_id, product_id, product_name, qty, kind, stock_after, tx_id, created_at)
             select $1, $2, 'P', $3, 'terjual', 0, $4, ${expr}`, [s.id, pid, deltas[k], id]);
    await q(`insert into cashflow (store_id, date, type, cat, amount, via, created_at)
             select $1, (${expr} at time zone 'Asia/Jakarta')::date, 'keluar', 'Gas', 1000, 'tunai', ${expr}`, [s.id]);
    await q("update products set stock = stock + $2 where id = $1", [pid, deltas[k]]);
  }
  const s2 = await one(O2, false, "select * from create_store('Toko B')");
  await q(`insert into transactions (id, store_id, no, created_at, items, total, method, paid, change) values ('e1000000-1111-1111-1111-111111111111', $1, 'Y', now(), '[]', 1, 'tunai', 1, 0)`, [s2.id]);

  const inRange = async (from) => (await q(`select count(*)::int n from transactions where store_id=$1 and created_at >= ${from}`, [s.id])).rows[0].n;
  const stock = async () => (await q("select stock from products where id=$1", [pid])).rows[0].stock;
  const cnt = async (tbl, store = s.id) => (await q(`select count(*)::int n from ${tbl} where store_id=$1`, [store])).rows[0].n;
  const awalBulan = `((date_trunc('month', ${B}))::timestamp at time zone 'Asia/Jakarta')`;
  const awalTahun = `((date_trunc('year', ${B}))::timestamp at time zone 'Asia/Jakarta')`;

  t.ok((await err(() => as(O2, false, () => q("select reset_period($1,'year')", [s.id])))) !== null, "pemilik toko lain tidak bisa menghapus");
  t.ok((await err(() => as(O, false, () => q("select reset_period($1,'semua')", [s.id])))) !== null, "periode asal-asalan ditolak");

  // Bulan ini: hari ini + awal bulan (kalau awal bulan = hari yang sama tetap terhitung sekali)
  const expM = await inRange(awalBulan);
  const stokAwalBulan = 100 + (await q(`select coalesce(sum(qty),0)::int n from stock_moves where store_id=$1 and created_at < ${awalBulan}`, [s.id])).rows[0].n;
  const rM = (await one(O, false, "select reset_period($1,'month') r", [s.id])).r;
  t.ok(rM.transactions === expM && expM >= 2, `bulan ini: ${rM.transactions} penjualan dihapus (dari ${rM.from} sampai ${rM.to})`);
  t.ok((await inRange(awalBulan)) === 0, "tidak ada lagi penjualan bulan ini");
  t.ok((await stock()) === stokAwalBulan, `stok kembali seperti awal bulan (${await stock()} = ${stokAwalBulan})`);
  t.ok((await cnt("cashflow")) === 4 - rM.cashflow && rM.cashflow >= 2, "catatan kas bulan ini terhapus, yang lebih lama tetap");

  // Tahun ini
  const rY = (await one(O, false, "select reset_period($1,'year') r", [s.id])).r;
  t.ok((await inRange(awalTahun)) === 0 && (await cnt("transactions")) === 1, `tahun ini: sisa hanya penjualan tahun lalu (${rY.transactions} dihapus)`);
  t.ok((await stock()) === 100 + deltas.lalu, `stok kembali seperti awal tahun (${await stock()})`);
  t.ok((await cnt("cashflow")) === 1 && (await cnt("stock_moves")) === 1, "catatan kas & riwayat stok tahun lalu tetap ada");
  t.ok((await cnt("transactions", s2.id)) === 1, "data toko lain tidak tersentuh");
  const rT = (await one(O, false, "select reset_today($1) r", [s.id])).r;
  t.ok(rT.period === "today" && rT.transactions === 0, "reset_today lama tetap jalan lewat reset_period");
  return t.done();
}
