// Uji migrasi 012: karyawan catat belanja & stok bahan, saldo, kasbon
import { setup, reporter } from "./harness.mjs";

export default async function () {
  const t = reporter("012 input karyawan, saldo, kasbon");
  const O = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222";
  const H = "a1111111-1111-1111-1111-111111111111", H2 = "a2222222-2222-2222-2222-222222222222";
  const { q, as, one, err } = await setup(["003_stok_hpp.sql", "007_nama_hp.sql", "011_reset_periode.sql", "012_karyawan_input.sql"], [O, O2, H, H2]);
  const s = await one(O, false, "select * from create_store('Toko A')");
  const s2 = await one(O2, false, "select * from create_store('Toko B')");
  await as(O, false, () => q("select set_kasir_pin($1,'1234')", [s.id]));
  await one(H, true, "select join_store($1,'1234','') r", [s.join_code]);
  const K = (sql, p) => as(H, true, () => q(sql, p));
  const OW = (sql, p) => as(O, false, () => q(sql, p));
  const uid = (n) => `e${n}000000-0000-0000-0000-000000000000`;

  // ---- Belanja dari kasir ----
  await K("select record_expense($1,$2,15000,'Es batu','tunai','2 balok',now())", [uid(1), s.id]);
  await K("select record_expense($1,$2,15000,'Es batu','tunai','2 balok',now())", [uid(1), s.id]);
  await K("select record_expense($1,$2,40000,'Bahan baku','bank','ikan',now())", [uid(2), s.id]);
  const cf = (await q("select * from cashflow where store_id=$1 order by amount", [s.id])).rows;
  t.ok(cf.length === 2 && cf[0].by_name === "Kasir 1" && cf[0].type === "keluar", "kasir catat belanja, kirim ulang tidak dobel, nama HP tercatat");
  t.ok(cf[1].via === "bank", "belanja pakai QRIS kios tercatat sebagai rekening");
  t.ok((await K("select count(*)::int n from cashflow where store_id=$1", [s.id])).rows[0].n === 0, "kasir tidak bisa membaca catatan keuangan");
  t.ok((await err(() => K("update cashflow set amount=1 where store_id=$1", [s.id]))) !== null
    || (await q("select sum(amount)::int n from cashflow where store_id=$1", [s.id])).rows[0].n === 55000, "kasir tidak bisa mengubah catatan");
  await K("delete from cashflow where store_id=$1", [s.id]).catch(() => {});
  t.ok((await q("select count(*)::int n from cashflow where store_id=$1", [s.id])).rows[0].n === 2, "kasir tidak bisa menghapus catatan");
  t.ok((await err(() => as(H2, true, () => q("select record_expense($1,$2,1000,'X','tunai','',now())", [uid(3), s.id])))) !== null, "HP yang tidak tersambung ditolak");
  t.ok((await err(() => K("select record_expense($1,$2,0,'X','tunai','',now())", [uid(4), s.id]))) !== null, "nominal 0 ditolak");

  // ---- Bahan ----
  const m = (await OW("insert into materials (store_id,name,unit,min_stock) values ($1,'Ikan tenggiri','kg',2) returning *", [s.id])).rows[0];
  t.ok((await err(() => K("insert into materials (store_id,name) values ($1,'X')", [s.id]))) !== null, "kasir tidak bisa menambah jenis bahan");
  t.ok((await K("select count(*)::int n from materials where store_id=$1", [s.id])).rows[0].n === 1, "kasir bisa melihat daftar & sisa bahan");
  const mid = (n) => `f${n}000000-0000-0000-0000-000000000000`;
  await K("select material_add($1,$2,1.5,'dari pasar',now())", [mid(1), m.id]);
  await K("select material_add($1,$2,1.5,'dari pasar',now())", [mid(1), m.id]);
  let st = (await q("select stock::float n from materials where id=$1", [m.id])).rows[0].n;
  t.ok(st === 1.5, `kasir tambah stok bahan 1,5 kg, kirim ulang tidak dobel (${st})`);
  t.ok((await err(() => K("select material_change($1,'keluar',1,'')", [m.id]))) !== null, "kasir tidak bisa mengurangi stok bahan");
  t.ok((await err(() => K("select material_change($1,'koreksi',9,'')", [m.id]))) !== null, "kasir tidak bisa mengoreksi stok bahan");
  t.ok((await err(() => K("select material_add($1,$2,-1,'',now())", [mid(2), m.id]))) !== null, "jumlah minus ditolak");
  t.ok((await err(() => K("update materials set stock=99 where id=$1", [m.id]))) !== null
    || (await q("select stock::float n from materials where id=$1", [m.id])).rows[0].n === 1.5, "kasir tidak bisa ubah stok langsung");
  await OW("select material_change($1,'keluar',0.5,'dipakai')", [m.id]);
  await OW("select material_change($1,'koreksi',3,'hitung ulang')", [m.id]);
  const mv = (await q("select kind, qty::float q, by_name from material_moves where material_id=$1 order by created_at, kind", [m.id])).rows;
  st = (await q("select stock::float n from materials where id=$1", [m.id])).rows[0].n;
  t.ok(st === 3 && mv.length === 3 && mv.some((x) => x.by_name === "Kasir 1" && x.kind === "masuk"), "pemilik kurangi & koreksi, riwayat mencatat siapa");
  t.ok((await err(() => as(O2, false, () => q("select material_add($1,$2,1,'',now())", [mid(5), m.id])))) !== null, "pemilik toko lain tidak bisa menambah");

  // ---- Saldo ----
  t.ok((await OW("select store_balance($1) r", [s.id])).rows[0].r.set === false, "saldo belum diatur");
  t.ok((await err(() => K("select store_balance($1)", [s.id]))) !== null, "kasir tidak bisa melihat saldo");
  await OW("update stores set opening_cash=100000, opening_bank=500000, opening_date=(now() at time zone 'Asia/Jakarta')::date where id=$1", [s.id]);
  await as(H, true, () => q(`select record_sale('d1000000-0000-0000-0000-000000000000',$1,'[{"product_id":null,"name":"A","price":20000,"qty":1}]','tunai',20000,now())`, [s.id]));
  await as(H, true, () => q(`select record_sale('d2000000-0000-0000-0000-000000000000',$1,'[{"product_id":null,"name":"A","price":30000,"qty":1}]','qris',30000,now())`, [s.id]));
  let b = (await OW("select store_balance($1) r", [s.id])).rows[0].r;
  t.ok(b.cash === 100000 + 20000 - 15000 && b.bank === 500000 + 30000 - 40000, `saldo tunai ${b.cash} & rekening ${b.bank} benar`);

  // ---- Kasbon ----
  await OW("select add_advance($1,'Budi','kasbon',50000,'tunai',null,'')", [s.id]);
  b = (await OW("select store_balance($1) r", [s.id])).rows[0].r;
  t.ok(b.cash === 55000, "kasbon tunai mengurangi saldo tunai");
  t.ok((await err(() => OW("select add_advance($1,'budi','bayar',60000,'tunai',null,'')", [s.id]))) !== null, "bayar melebihi sisa kasbon ditolak");
  await OW("select add_advance($1,'budi','bayar',20000,'bank',null,'')", [s.id]);
  await OW("select add_advance($1,'Budi','potong',10000,null,null,'gaji minggu ini')", [s.id]);
  const owed = (await q("select sum(case when kind='kasbon' then amount else -amount end)::int n from advances where store_id=$1", [s.id])).rows[0].n;
  b = (await OW("select store_balance($1) r", [s.id])).rows[0].r;
  t.ok(owed === 20000 && b.bank === 490000 + 20000 && b.cash === 55000, `sisa kasbon ${owed}, bayar lewat rekening menambah saldo, potong gaji tidak mengubah saldo`);
  t.ok((await err(() => K("select add_advance($1,'X','kasbon',1000,'tunai',null,'')", [s.id]))) !== null, "kasir tidak bisa memberi kasbon");
  const adv = (await q("select id from advances where kind='kasbon' and store_id=$1", [s.id])).rows[0].id;
  await OW("delete from advances where id=$1", [adv]);
  t.ok((await q("select count(*)::int n from cashflow where advance_id=$1", [adv])).rows[0].n === 0, "hapus kasbon ikut menghapus catatan kasnya");

  // ---- Hapus data hari ini ikut bahan & kasbon ----
  const r = (await OW("select reset_period($1,'today') r", [s.id])).rows[0].r;
  st = (await q("select stock::float n from materials where id=$1", [m.id])).rows[0].n;
  t.ok(st === 0 && r.material_moves === 3 && (await q("select count(*)::int n from advances where store_id=$1", [s.id])).rows[0].n === 0,
    `hapus data hari ini: stok bahan kembali 0, kasbon terhapus`);
  void s2;
  return t.done();
}
