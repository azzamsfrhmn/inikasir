// Uji migrasi 003 (stok & HPP). Argumen: schema.sql lalu file migrasi berurutan (002 opsional).
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";

const files = process.argv.slice(2);
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
// toko lama yang sudah punya transaksi SEBELUM migrasi 003
await db.exec(readFileSync(files[0], "utf8"));
const OWNER = "11111111-1111-1111-1111-111111111111", HP = "33333333-3333-3333-3333-333333333333", OTHER = "22222222-2222-2222-2222-222222222222";
for (const u of [OWNER, HP, OTHER]) await q("insert into auth.users values ($1)", [u]);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
async function as(user, anon, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const one = async (u, a, sql, p) => (await as(u, a, () => q(sql, p))).rows[0];

const store = await one(OWNER, false, "select * from create_store('Toko A')");
await as(OWNER, false, () => q("select set_kasir_pin($1,'4321')", [store.id]));
await as(HP, true, () => q("select join_store($1,'4321','HP')", [store.join_code]));
const P = Object.fromEntries((await as(OWNER, false, () => q("select id, name, price from products"))).rows.map((r) => [r.name, r]));
const sale = (items, id) => as(HP, true, () => q("select record_sale($1,$2,$3::jsonb,'tunai',0,now()) s", [id || crypto.randomUUID(), store.id, JSON.stringify(items)]));
await sale([{ product_id: P["Cilok"].id, qty: 2 }]);   // transaksi lama

for (const f of files.slice(1)) await db.exec(readFileSync(f, "utf8"));
console.log("migrasi:", files.slice(1).map((f) => f.split(/[\\/]/).pop()).join(", "));

const old = await one(OWNER, false, "select cost_total, costs from transactions limit 1");
ok(old.cost_total === 0, "transaksi lama tetap ada, modal 0");

// Kasir tidak boleh lihat modal & tidak bisa ubah stok
ok((await as(HP, true, () => q("select id, stock, track_stock from products"))).rows.length === 8, "HP kasir bisa baca stok produk");
ok((await as(HP, true, () => q("select * from product_costs"))).rows.length === 0, "HP kasir tidak bisa baca modal");
ok(await err(() => as(HP, true, () => q("update products set stock = 999"))) !== null, "HP kasir tidak bisa ubah stok");
ok(await err(() => as(HP, true, () => q("select add_stock($1, 10, 500, '')", [P["Cilok"].id]))) !== null, "HP kasir tidak bisa stok masuk");
ok(await err(() => as(OWNER, false, () => q("update products set stock = 5 where id=$1", [P["Cilok"].id]))) !== null, "pemilik pun tidak bisa ubah stok langsung (harus lewat stok masuk/koreksi)");
ok((await as(HP, true, () => q("select * from stock_moves"))).rows.length === 0, "HP kasir tidak bisa baca riwayat stok");

// Pemilik isi modal & stok
await as(OWNER, false, () => q("insert into product_costs (product_id, store_id, cost) values ($1,$2,600)", [P["Cilok"].id, store.id]));
let r = await one(OWNER, false, "select set_stock($1, 50, 'stok awal') s", [P["Cilok"].id]);
ok(r.s.stock === 50, "stok awal Cilok 50");
r = await one(OWNER, false, "select add_stock($1, 50, 800, 'beli') s", [P["Cilok"].id]);
ok(r.s.stock === 100 && r.s.cost === 700, `stok masuk 50 @800 → stok 100, modal rata-rata 700 (dapat ${r.s.cost})`);
r = await one(OWNER, false, "select add_stock($1, 20, 1500, '') s", [P["Tahu bakso"].id]);
ok(r.s.stock === 20 && r.s.cost === 1500, "produk tanpa modal: stok masuk langsung jadi modal & stok dilacak");
ok(await err(() => as(OTHER, false, () => q("select add_stock($1, 5, 1, '')", [P["Cilok"].id]))) !== null, "toko lain tidak bisa ubah stok toko ini");
ok((await as(OTHER, false, () => q("select * from product_costs"))).rows.length === 0, "toko lain tidak bisa lihat modal toko ini");

// Penjualan mengurangi stok & mengunci modal
const t1 = "a1111111-1111-1111-1111-111111111111";
await sale([{ product_id: P["Cilok"].id, qty: 3 }, { product_id: P["Tahu bakso"].id, qty: 2 }, { product_id: P["Es teh"].id, qty: 1 }], t1);
const tx = await one(OWNER, false, "select cost_total, costs, total from transactions where id=$1", [t1]);
ok(tx.cost_total === 3 * 700 + 2 * 1500 && JSON.stringify(tx.costs) === "[700,1500,0]", `HPP terkunci: ${tx.cost_total}, per item ${JSON.stringify(tx.costs)}`);
const st = Object.fromEntries((await as(OWNER, false, () => q("select name, stock, track_stock from products"))).rows.map((x) => [x.name, x]));
ok(st["Cilok"].stock === 97 && st["Tahu bakso"].stock === 18, "stok berkurang otomatis (Cilok 97, Tahu bakso 18)");
ok(st["Es teh"].stock === 0 && !st["Es teh"].track_stock, "produk tidak dilacak: stok tidak disentuh");
await as(OWNER, false, () => q("update product_costs set cost = 2000 where product_id=$1", [P["Cilok"].id]));
ok((await one(OWNER, false, "select cost_total from transactions where id=$1", [t1])).cost_total === 5100, "ubah modal tidak mengubah HPP transaksi lama");

// Kirim ulang tidak mengurangi stok dua kali
await sale([{ product_id: P["Cilok"].id, qty: 3 }], t1);
ok((await one(OWNER, false, "select stock from products where id=$1", [P["Cilok"].id])).stock === 97, "kirim ulang transaksi yang sama tidak mengurangi stok lagi");

// Batal mengembalikan stok
await as(OWNER, false, () => q("update transactions set voided = true, voided_at = now() where id=$1", [t1]));
ok((await one(OWNER, false, "select stock from products where id=$1", [P["Cilok"].id])).stock === 100, "transaksi dibatalkan → stok kembali 100");
await as(OWNER, false, () => q("update transactions set voided = true where id=$1", [t1]));
ok((await one(OWNER, false, "select stock from products where id=$1", [P["Cilok"].id])).stock === 100, "batal dua kali tidak menambah stok dua kali");

// Stok boleh minus (penjualan offline tidak boleh gagal)
r = await one(OWNER, false, "select set_stock($1, 1, 'opname') s", [P["Tahu bakso"].id]);
ok(r.s.diff === -19, `koreksi stok 20 → 1 tercatat selisih −19 (dapat ${r.s.diff})`);
await sale([{ product_id: P["Tahu bakso"].id, qty: 3 }]);
ok((await one(OWNER, false, "select stock from products where id=$1", [P["Tahu bakso"].id])).stock === -2, "stok bisa minus (penjualan tidak ditolak), jadi tanda perlu koreksi");

// Riwayat
const moves = (await as(OWNER, false, () => q("select kind, qty, stock_after from stock_moves where product_id=$1 order by created_at", [P["Cilok"].id]))).rows;
ok(moves.map((m) => m.kind).join(",") === "awal,masuk,terjual,batal", "riwayat stok Cilok: " + moves.map((m) => `${m.kind}${m.qty > 0 ? "+" : ""}${m.qty}`).join(", "));

// Produk baru dari admin + hapus
const np = await one(OWNER, false, "insert into products (store_id, name, price, cat, active, track_stock) values ($1,'Siomay',4000,'Jajanan',true,true) returning id", [store.id]);
await as(OWNER, false, () => q("insert into product_costs (product_id, store_id, cost) values ($1,$2,2500)", [np.id, store.id]));
ok(await err(() => as(OWNER, false, () => q("insert into product_costs (product_id, store_id, cost) values ($1,$2,1)", [np.id, crypto.randomUUID()]))) !== null, "modal tidak bisa dipasang ke toko lain");
await as(OWNER, false, () => q("delete from products where id=$1", [np.id]));
ok((await one(OWNER, false, "select count(*)::int n from product_costs where product_id=$1", [np.id])).n === 0, "hapus produk ikut menghapus modalnya");

console.log(fails ? `\n${fails} GAGAL` : "\nSEMUA LULUS");
process.exit(fails ? 1 : 0);
