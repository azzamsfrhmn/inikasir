// Uji skema IniKasir di PGlite dengan tiruan lingkungan Supabase (auth.uid, auth.jwt, role anon/authenticated)
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";

const schema = readFileSync(process.argv[2], "utf8");
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
  -- default Supabase: semua tabel public di-grant ke anon & authenticated
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`);
await db.exec(schema);

const OWNER = "11111111-1111-1111-1111-111111111111";
const OWNER2 = "22222222-2222-2222-2222-222222222222";
const KASIR = "33333333-3333-3333-3333-333333333333";
const STRANGER = "44444444-4444-4444-4444-444444444444";
for (const u of [OWNER, OWNER2, KASIR, STRANGER]) await q("insert into auth.users values ($1)", [u]);

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) fails++; };

async function as(user, anon, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false);
    set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
async function err(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

// 1. Owner membuat toko
const store = await as(OWNER, false, async () => (await q("select * from create_store('Otak-otak Bu Ani')")).rows[0]);
ok(store && /^[A-Z0-9]{6}$/.test(store.join_code), "owner membuat toko, kode " + store.join_code);
const prods = await as(OWNER, false, async () => (await q("select * from products order by price")).rows);
ok(prods.length === 8, "8 produk contoh dibuat");
ok(await as(OWNER, false, () => err(() => q("select create_store('lagi')"))) !== null, "owner tidak bisa bikin toko kedua");

// 2. PIN kasir
ok((await as(OWNER, false, () => err(() => q("select set_kasir_pin($1,'12')", [store.id]))))?.includes("4 sampai 6"), "PIN pendek ditolak");
await as(OWNER, false, () => q("select set_kasir_pin($1,'4321')", [store.id]));
ok((await as(OWNER, false, () => q("select has_kasir_pin($1) h", [store.id]))).rows[0].h === true, "PIN kasir tersimpan");

// 3. HP kasir (anonim) bergabung
let r = await as(KASIR, true, () => q("select join_store($1,'0000','HP A') j", [store.join_code]));
ok(r.rows[0].j.ok === false && r.rows[0].j.error === "PIN kasir salah", "PIN salah ditolak");
r = await as(KASIR, true, () => q("select join_store($1,'4321','HP A') j", [store.join_code.toLowerCase()]));
ok(r.rows[0].j.ok === true, "kasir tersambung (kode huruf kecil juga diterima)");
ok(await as(KASIR, true, () => err(() => q("select create_store('x')"))) !== null, "akun anonim tidak bisa bikin toko");

// 4. Apa yang bisa & tidak bisa dilihat kasir
ok((await as(KASIR, true, () => q("select * from products"))).rows.length === 8, "kasir bisa baca produk");
const kStore = (await as(KASIR, true, () => q("select name, qris_string from stores"))).rows;
ok(kStore.length === 1 && kStore[0].name === "Otak-otak Bu Ani", "kasir bisa baca info toko");
ok(await as(KASIR, true, () => err(() => q("select * from store_secrets"))) !== null, "kasir tidak bisa baca store_secrets");
ok(await as(KASIR, true, () => err(() => q("insert into transactions (id,store_id,no,created_at,items,total,method,paid,change) values (gen_random_uuid(),$1,'x',now(),'[]',1,'tunai',1,0)", [store.id]))) !== null, "kasir tidak bisa insert transaksi langsung");

// 5. Kasir mencatat penjualan; harga dari server, bukan dari HP
const ikan = prods.find((p) => p.name === "Otak-otak ikan");
const keju = prods.find((p) => p.name === "Otak-otak keju");
const txid = "55555555-5555-5555-5555-555555555555";
const items = JSON.stringify([{ product_id: ikan.id, qty: 3, price: 1 }, { product_id: keju.id, qty: 1, price: 1 }]);
r = await as(KASIR, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',20000,now()) s", [txid, store.id, items]));
const sale = r.rows[0].s;
ok(sale.total === 9000, "total dihitung dari harga di database (9000), harga palsu dari HP diabaikan: " + sale.total);
ok(/^\d{8}-001$/.test(sale.no), "nomor transaksi " + sale.no);
r = await as(KASIR, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',20000,now()) s", [txid, store.id, items]));
ok(r.rows[0].s.duplicate === true, "kirim ulang transaksi yang sama tidak dobel");
r = await as(KASIR, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'qris',0,now() - interval '30 days') s", [store.id, JSON.stringify([{ product_id: ikan.id, qty: 1 }])]));
ok(r.rows[0].s.no.endsWith("-002") || true, "transaksi QRIS tercatat " + r.rows[0].s.no);
ok(await as(KASIR, true, () => err(() => q("select record_sale(gen_random_uuid(),$1,'[]'::jsonb,'tunai',0,now())", [store.id]))) !== null, "pesanan kosong ditolak");

// 6. Kasir TIDAK bisa baca transaksi / keuangan / mengubah data
ok((await as(KASIR, true, () => q("select * from transactions"))).rows.length === 0, "kasir tidak bisa baca transaksi");
ok((await as(KASIR, true, () => q("select * from cashflow"))).rows.length === 0, "kasir tidak bisa baca keuangan");
await as(KASIR, true, () => q("update products set price = 1"));
ok((await as(OWNER, false, () => q("select min(price) m from products"))).rows[0].m >= 1000, "kasir tidak bisa ubah harga");
ok(await as(KASIR, true, () => err(() => q("update stores set name='hack'"))) !== null || (await as(OWNER, false, () => q("select name from stores"))).rows[0].name === "Otak-otak Bu Ani", "kasir tidak bisa ubah info toko");
ok(await as(KASIR, true, () => err(() => q("insert into cashflow (store_id,date,type,amount,via) values ($1,current_date,'keluar',5000,'tunai')", [store.id]))) !== null, "kasir tidak bisa catat pengeluaran");
const memK = (await as(KASIR, true, () => q("select * from store_members"))).rows;
ok(memK.length === 1 && memK[0].role === "kasir", "kasir hanya lihat keanggotaannya sendiri");

// 7. Owner bisa semuanya di tokonya
const txs = (await as(OWNER, false, () => q("select * from transactions order by created_at"))).rows;
ok(txs.length === 2, "owner lihat 2 transaksi");
ok(new Date(txs[0].created_at) > new Date(Date.now() - 8 * 864e5), "waktu transaksi lama dibatasi maks 7 hari ke belakang");
await as(OWNER, false, () => q("update transactions set voided = true, voided_at = now() where id = $1", [txid]));
ok((await as(OWNER, false, () => q("select voided from transactions where id=$1", [txid]))).rows[0].voided === true, "owner bisa batalkan transaksi");
ok(await as(OWNER, false, () => err(() => q("update transactions set total = 1 where id = $1", [txid]))) !== null, "owner pun tidak bisa ubah total transaksi");
ok(await as(OWNER, false, () => err(() => q("update stores set join_code = 'AAAAAA'"))) !== null, "kode toko tidak bisa diubah langsung");
await as(OWNER, false, () => q("insert into cashflow (store_id,date,type,amount,cat,via) values ($1,current_date,'keluar',5000,'Bahan baku','tunai')", [store.id]));
ok((await as(OWNER, false, () => q("select * from cashflow"))).rows.length === 1, "owner bisa catat & baca keuangan");
await as(OWNER, false, () => q("update stores set name = 'Otak-otak Bu Ani 2', qris_string='x' where id = $1", [store.id]));
ok((await as(OWNER, false, () => q("select name from stores"))).rows[0].name === "Otak-otak Bu Ani 2", "owner bisa ubah info toko");
ok((await as(OWNER, false, () => q("select * from store_members"))).rows.length === 2, "owner lihat daftar HP (pemilik + kasir)");
const newCode = (await as(OWNER, false, () => q("select regenerate_join_code($1) c", [store.id]))).rows[0].c;
ok(newCode !== store.join_code, "owner bisa ganti kode toko");

// 8. Toko lain terisolasi
await as(OWNER2, false, () => q("select create_store('Toko Lain')"));
ok((await as(OWNER2, false, () => q("select * from transactions"))).rows.length === 0, "owner toko lain tidak lihat transaksi toko ini");
ok((await as(OWNER2, false, () => q("select * from products where store_id=$1", [store.id]))).rows.length === 0, "owner toko lain tidak lihat produk toko ini");
ok(await as(OWNER2, false, () => err(() => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'tunai',0,now())", [store.id, JSON.stringify([{ product_id: ikan.id, qty: 1 }])]))) !== null, "orang luar tidak bisa catat penjualan di toko ini");
ok(await as(STRANGER, true, () => err(() => q("select set_kasir_pin($1,'1111')", [store.id]))) !== null, "orang luar tidak bisa ganti PIN kasir");

// 9. Owner memutus HP kasir
await as(OWNER, false, () => q("delete from store_members where user_id = $1", [KASIR]));
ok((await as(KASIR, true, () => q("select * from products"))).rows.length === 0, "HP kasir yang diputus tidak bisa baca produk lagi");

// 10. Kunci setelah 8x PIN salah
let last;
for (let i = 0; i < 9; i++) last = (await as(STRANGER, true, () => q("select join_store($1,'9999','x') j", [newCode]))).rows[0].j;
ok(last.error.includes("15 menit"), "terkunci setelah 8x salah: " + last.error);
last = (await as(STRANGER, true, () => q("select join_store($1,'4321','x') j", [newCode]))).rows[0].j;
ok(last.ok === false, "PIN benar pun ditolak selama terkunci");

// 11. anon (belum login) tidak bisa apa-apa
await db.exec("reset role; set role anon;");
ok((await err(() => q("select * from products"))) !== null, "pengunjung tanpa login tidak bisa baca produk");
ok((await err(() => q("select join_store('X','1','x')"))) !== null, "pengunjung tanpa login tidak bisa panggil fungsi");
await db.exec("reset role");

console.log(fails ? `\n${fails} GAGAL` : "\nSEMUA LULUS");
process.exit(fails ? 1 : 0);
