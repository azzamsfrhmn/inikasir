// Uji migrasi 002 (karyawan, shift, hak akses) di atas schema.sql, tanpa grant otomatis Supabase.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";

const [schemaPath, migPath] = process.argv.slice(2);
const db = new PGlite();
const q = (sql, params) => db.query(sql, params);
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
`);
await db.exec(readFileSync(schemaPath, "utf8"));
await db.exec(readFileSync(migPath, "utf8"));

const OWNER = "11111111-1111-1111-1111-111111111111", HP1 = "33333333-3333-3333-3333-333333333333", HP2 = "55555555-5555-5555-5555-555555555555", OTHER = "22222222-2222-2222-2222-222222222222";
for (const u of [OWNER, HP1, HP2, OTHER]) await q("insert into auth.users values ($1)", [u]);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
async function as(user, anon, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const one = async (user, anon, sql, p) => (await as(user, anon, () => q(sql, p))).rows[0];

// Toko + 2 HP kasir
const store = await one(OWNER, false, "select * from create_store('Toko A')");
await as(OWNER, false, () => q("select set_kasir_pin($1,'4321')", [store.id]));
for (const hp of [HP1, HP2]) await as(hp, true, () => q("select join_store($1,'4321','HP')", [store.join_code]));
const prod = (await as(OWNER, false, () => q("select id, price from products where name='Cilok'"))).rows[0];

// Pemilik membuat karyawan
const budi = await one(OWNER, false, `insert into employees (store_id, name, perms) values ($1,'Budi','{"view_shift":true,"void_own":true,"cash_out":true}') returning id, name`, [store.id]);
const sari = await one(OWNER, false, `insert into employees (store_id, name, perms) values ($1,'Sari','{}') returning id`, [store.id]);
ok(budi && sari, "pemilik membuat 2 karyawan");
ok((await err(() => as(OWNER, false, () => q(`insert into employees (store_id, name) values ($1,'budi ')`, [store.id])))) !== null, "nama karyawan kembar ditolak");
await as(OWNER, false, () => q("select set_employee_pin($1,'1111')", [budi.id]));
await as(OWNER, false, () => q("select set_employee_pin($1,'2222')", [sari.id]));
ok((await as(OWNER, false, () => q("select * from employee_has_pin($1)", [store.id]))).rows.every((r) => r.has_pin), "status PIN terbaca pemilik");
ok(await err(() => as(OWNER, false, () => q("select * from employees"))) !== null, "select * employees ditolak (pin_hash tidak boleh terbaca)");

// HP kasir lihat daftar nama, bukan PIN
const list = (await as(HP1, true, () => q("select id, name, perms from employees where active order by name"))).rows;
ok(list.length === 2, "HP kasir melihat daftar nama karyawan");
ok(await err(() => as(HP1, true, () => q("select pin_hash from employees"))) !== null, "HP kasir tidak bisa baca pin_hash");
ok(await err(() => as(HP1, true, () => q("update employees set perms='{\"void_own\":true}'"))) !== null || (await as(OWNER, false, () => q("select perms from employees where id=$1", [sari.id]))).rows[0].perms.void_own !== true, "HP kasir tidak bisa ubah hak akses");
ok((await as(HP1, true, () => q("select * from shifts"))).rows.length === 0, "HP kasir tidak bisa baca tabel shift");
ok(await err(() => as(HP1, true, () => q("select set_employee_pin($1,'9999')", [budi.id]))) !== null, "HP kasir tidak bisa ganti PIN karyawan");

// Buka shift
let r = await one(HP1, true, "select start_shift($1,$2,'0000',50000,'') j", [store.id, budi.id]);
ok(r.j.ok === false && r.j.error === "PIN salah", "PIN karyawan salah ditolak");
r = await one(HP1, true, "select start_shift($1,$2,'1111',50000,'') j", [store.id, budi.id]);
ok(r.j.ok && !r.j.resumed && r.j.shift.opening_cash === 50000, "Budi buka shift di HP1, kas awal 50.000");
const shiftB = r.j.shift.id;
ok(r.j.shift.perms.view_shift === true, "hak akses ikut dikirim ke HP");
r = await one(HP1, true, "select start_shift($1,$2,'1111',null,'') j", [store.id, budi.id]);
ok(r.j.ok && r.j.resumed && r.j.shift.id === shiftB, "buka lagi di HP yang sama = lanjutkan shift");
r = await one(HP2, true, "select start_shift($1,$2,'1111',10000,'') j", [store.id, budi.id]);
ok(r.j.ok === false && /masih terbuka/.test(r.j.error), "Budi tidak bisa buka shift kedua di HP lain");
r = await one(HP1, true, "select start_shift($1,$2,'2222',10000,'') j", [store.id, sari.id]);
ok(r.j.ok === false && /masih dipakai shift Budi/.test(r.j.error), "HP1 tidak bisa dipakai Sari selama shift Budi terbuka");
r = await one(HP2, true, "select start_shift($1,$2,'2222',null,'') j", [store.id, sari.id]);
ok(r.j.ok === false && r.j.need_opening_cash, "buka shift baru wajib isi kas awal");
r = await one(HP2, true, "select start_shift($1,$2,'2222',20000,'') j", [store.id, sari.id]);
const shiftS = r.j.shift.id;
ok(r.j.ok, "Sari buka shift di HP2");
ok((await one(HP1, true, "select current_shift($1) c", [store.id])).c.id === shiftB, "current_shift HP1 = shift Budi");

// Penjualan atas shift
const items = JSON.stringify([{ product_id: prod.id, qty: 3 }]);
const t1 = "a1111111-1111-1111-1111-111111111111", t2 = "a2222222-2222-2222-2222-222222222222", t3 = "a3333333-3333-3333-3333-333333333333";
await as(HP1, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',5000,now(),$4)", [t1, store.id, items, shiftB]));
await as(HP1, true, () => q("select record_sale($1,$2,$3::jsonb,'qris',0,now(),$4)", [t2, store.id, items, shiftB]));
ok(await err(() => as(HP2, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',0,now(),$4)", [t3, store.id, items, shiftB]))) !== null, "HP2 tidak bisa menjual atas nama shift Budi");
await as(HP2, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',0,now(),$4)", [t3, store.id, items, shiftS]));
await as(HP1, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'tunai',0,now())", [store.id, items]));
ok(true, "penjualan tanpa shift (versi lama) tetap diterima");
const tx = (await as(OWNER, false, () => q("select id, employee_name, shift_id from transactions order by created_at"))).rows;
ok(tx.find((t) => t.id === t1).employee_name === "Budi" && tx.find((t) => t.id === t3).employee_name === "Sari", "transaksi tercatat atas nama karyawan");

// Hak akses
await as(HP1, true, () => q("select cash_out($1,7000,'Es batu','beli es')", [shiftB]));
ok(await err(() => as(HP2, true, () => q("select cash_out($1,7000,'Es batu','')", [shiftS]))) !== null, "Sari (tanpa hak) tidak bisa catat uang keluar");
ok(await err(() => as(HP2, true, () => q("select shift_summary($1)", [shiftS]))) !== null, "Sari (tanpa hak) tidak bisa lihat ringkasan shift");
ok(await err(() => as(HP2, true, () => q("select void_own_sale($1,$2)", [shiftS, t3]))) !== null, "Sari (tanpa hak) tidak bisa batalkan transaksi");
ok(await err(() => as(HP1, true, () => q("select void_own_sale($1,$2)", [shiftB, t3]))) !== null, "Budi tidak bisa batalkan transaksi shift lain");
await as(HP1, true, () => q("select void_own_sale($1,$2)", [shiftB, t2]));
const sum = (await one(HP1, true, "select shift_summary($1) s", [shiftB])).s;
ok(sum.cash_sales === 3000 && sum.qris_sales === 0 && sum.cash_out === 7000 && sum.expected_cash === 46000 && sum.tx_count === 1,
  `ringkasan Budi: tunai 3000, keluar 7000, seharusnya 46000 (dapat ${sum.expected_cash})`);
ok(await err(() => as(HP2, true, () => q("select shift_summary($1)", [shiftB]))) !== null, "HP lain tidak bisa baca ringkasan shift Budi");

// Tutup shift
r = await one(HP2, true, "select end_shift($1, 22000, 'lengkap') e", [shiftS]);
ok(r.e.ok && r.e.summary === null, "Sari tutup shift tanpa melihat angka seharusnya (tutup buta)");
r = await one(HP1, true, "select end_shift($1, 45000, 'kurang seribu') e", [shiftB]);
ok(r.e.ok && r.e.summary.expected_cash === 46000 && r.e.summary.closing_cash === 45000, "Budi (punya hak) lihat ringkasan saat tutup");
ok(await err(() => as(HP1, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'tunai',0,now(),$3)", [store.id, items, shiftB]))) !== null, "penjualan baru ke shift yang sudah tutup ditolak");
await as(HP1, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'tunai',0,now() - interval '1 minute',$3)", [store.id, items, shiftB]));
ok(true, "penjualan offline yang terjadi sebelum tutup shift tetap diterima");
ok((await one(HP1, true, "select current_shift($1) c", [store.id])).c === null, "setelah tutup, HP1 tidak punya shift aktif");

// Pemilik melihat absensi & kas
const sh = (await as(OWNER, false, () => q("select employee_name, opening_cash, closing_cash, closed_at, closed_by from shifts order by opened_at"))).rows;
ok(sh.length === 2 && sh.every((s) => s.closed_at && s.closed_by === "karyawan"), "pemilik melihat 2 shift dengan jam masuk & pulang");
ok((await as(OWNER, false, () => q("select * from cashflow where shift_id=$1", [shiftB]))).rows.length === 1, "uang keluar shift masuk ke catatan kas pemilik");

// Tutup paksa oleh pemilik
r = await one(HP2, true, "select start_shift($1,$2,'1111',0,'') j", [store.id, budi.id]);
ok(r.j.ok, "Budi buka shift lagi di HP2");
ok(await err(() => as(HP1, true, () => q("select force_close_shift($1)", [r.j.shift.id]))) !== null, "HP kasir tidak bisa tutup paksa");
await as(OWNER, false, () => q("select force_close_shift($1)", [r.j.shift.id]));
ok((await as(OWNER, false, () => q("select closed_by from shifts where id=$1", [r.j.shift.id]))).rows[0].closed_by === "pemilik", "pemilik bisa tutup paksa shift yang lupa ditutup");

// Kunci PIN karyawan
let last; for (let i = 0; i < 6; i++) last = (await one(HP1, true, "select start_shift($1,$2,'0000',0,'') j", [store.id, sari.id])).j;
ok(/15 menit/.test(last.error), "PIN karyawan terkunci setelah 5x salah");
ok((await one(HP1, true, "select start_shift($1,$2,'2222',0,'') j", [store.id, sari.id])).j.ok === false, "PIN benar pun ditolak selama terkunci");

// Toko lain terisolasi
await as(OTHER, false, () => q("select create_store('Toko B')"));
ok((await as(OTHER, false, () => q("select id from employees"))).rows.length === 0, "toko lain tidak melihat karyawan toko ini");
ok((await as(OTHER, false, () => q("select * from shifts"))).rows.length === 0, "toko lain tidak melihat shift toko ini");

await db.exec("reset role; set role anon;");
ok((await err(() => q("select id from employees"))) !== null, "pengunjung tanpa login tidak bisa baca karyawan");
await db.exec("reset role");
console.log(fails ? `\n${fails} GAGAL` : "\nSEMUA LULUS");
process.exit(fails ? 1 : 0);
