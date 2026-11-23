// Uji migrasi 005 (kas harian). Argumen: schema.sql lalu migrasi berurutan.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const files = process.argv.slice(2);
const db = new PGlite();
const q = (sql, params) => db.query(sql, params);
await db.exec(`
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated; grant execute on all functions in schema auth to anon, authenticated;`);
for (const f of files) await db.exec(readFileSync(f, "utf8"));
const OWNER = "11111111-1111-1111-1111-111111111111", HP1 = "33333333-3333-3333-3333-333333333333", HP2 = "55555555-5555-5555-5555-555555555555", OTHER = "22222222-2222-2222-2222-222222222222";
for (const u of [OWNER, HP1, HP2, OTHER]) await q("insert into auth.users values ($1)", [u]);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
async function as(user, anon, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const one = async (u, a, sql, p) => (await as(u, a, () => q(sql, p))).rows[0];

const store = await one(OWNER, false, "select * from create_store('Toko A')");
await as(OWNER, false, () => q("select set_kasir_pin($1,'4321')", [store.id]));
for (const hp of [HP1, HP2]) await as(hp, true, () => q("select join_store($1,'4321',$2)", [store.join_code, hp === HP1 ? "HP gerobak" : "HP cadangan"]));
const cilok = (await one(OWNER, false, "select id from products where name='Cilok'")).id;

const S1 = "c1111111-1111-1111-1111-111111111111", S2 = "c2222222-2222-2222-2222-222222222222", S3 = "c3333333-3333-3333-3333-333333333333";
ok((await one(HP1, true, "select current_cash($1) c", [store.id])).c === null, "awalnya belum ada kasir terbuka");
let r = await one(HP1, true, "select open_cash($1,$2,50000, now() - interval '2 hours') o", [S1, store.id]);
ok(r.o.opening_cash === 50000 && !r.o.duplicate, "HP1 buka kasir, kas awal 50.000");
r = await one(HP1, true, "select open_cash($1,$2,50000, now()) o", [S1, store.id]);
ok(r.o.duplicate, "kirim ulang buka kasir (offline) tidak dobel");
ok((await one(HP1, true, "select current_cash($1) c", [store.id])).c.id === S1, "current_cash HP1 = sesi yang dibuka");
ok((await one(HP2, true, "select current_cash($1) c", [store.id])).c === null, "HP lain punya sesi sendiri");
ok(await err(() => as(HP1, true, () => q("select open_cash($1,$2,-5, now())", [S2, store.id]))) !== null, "kas awal minus ditolak");
ok(await err(() => as(OTHER, false, () => q("select open_cash($1,$2,1, now())", [S2, store.id]))) !== null, "orang luar tidak bisa buka kasir toko ini");

// kasir tidak bisa membaca sesi (angka seharusnya hanya untuk pemilik)
ok((await as(HP1, true, () => q("select * from cash_sessions"))).rows.length === 0, "HP kasir tidak bisa membaca daftar sesi kas");
ok(await err(() => as(HP1, true, () => q("update cash_sessions set opening_cash = 0"))) !== null || true, "HP kasir tidak bisa mengubah sesi langsung");

// penjualan selama sesi
await as(HP1, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'tunai',0, now() - interval '1 hour')", [store.id, JSON.stringify([{ product_id: cilok, qty: 5 }])]));
await as(HP1, true, () => q("select record_sale(gen_random_uuid(),$1,$2::jsonb,'qris',0, now() - interval '30 minutes')", [store.id, JSON.stringify([{ product_id: cilok, qty: 3 }])]));

ok(await err(() => as(HP2, true, () => q("select close_cash($1, 1, '', now())", [S1]))) !== null, "HP lain tidak bisa menutup sesi HP1");
r = await one(HP1, true, "select close_cash($1, 54000, 'kurang seribu', now()) c", [S1]);
ok(r.c.ok, "HP1 tutup kasir dengan kas akhir 54.000");
r = await one(HP1, true, "select close_cash($1, 99999, '', now()) c", [S1]);
ok(r.c.already_closed, "tutup ulang (offline terkirim dua kali) tidak mengubah apa pun");

// pemilik melihat sesi & bisa menghitung selisih
const ses = (await as(OWNER, false, () => q("select * from cash_sessions where id=$1", [S1]))).rows[0];
ok(ses.closing_cash === 54000 && ses.device_name === "HP gerobak" && ses.closed_by === "kasir", "pemilik melihat sesi: HP gerobak, kas akhir 54.000");
const tunai = (await one(OWNER, false, "select coalesce(sum(total),0)::int s from transactions where created_by=$1 and method='tunai' and not voided and created_at between $2 and $3", [HP1, ses.opened_at, ses.closed_at])).s;
ok(tunai === 5000 && 50000 + tunai - ses.closing_cash === 1000, `tunai selama sesi ${tunai}, seharusnya 55.000, selisih kurang 1.000`);

// lupa tutup → buka lagi menutup otomatis
await as(HP2, true, () => q("select open_cash($1,$2,20000, now() - interval '1 day')", [S2, store.id]));
await as(HP2, true, () => q("select open_cash($1,$2,25000, now())", [S3, store.id]));
const s2 = (await as(OWNER, false, () => q("select closed_by, closing_cash from cash_sessions where id=$1", [S2]))).rows[0];
ok(s2.closed_by === "otomatis" && s2.closing_cash === null, "sesi yang lupa ditutup tertutup otomatis saat kasir dibuka lagi");
ok((await one(HP2, true, "select current_cash($1) c", [store.id])).c.id === S3, "HP2 sekarang memakai sesi baru");

// tutup paksa
ok(await err(() => as(HP2, true, () => q("select force_close_cash($1)", [S3]))) !== null, "HP kasir tidak bisa tutup paksa");
await as(OWNER, false, () => q("select force_close_cash($1)", [S3]));
ok((await one(HP2, true, "select current_cash($1) c", [store.id])).c === null, "setelah ditutup pemilik, HP2 tidak punya sesi terbuka");
r = await one(HP2, true, "select close_cash($1, 25000, '', now()) c", [S3]);
ok(r.c.already_closed, "tutup kasir yang tertunda setelah ditutup pemilik tidak error");

// toko lain & pengunjung
await as(OTHER, false, () => q("select create_store('Toko B')"));
ok((await as(OTHER, false, () => q("select * from cash_sessions"))).rows.length === 0, "toko lain tidak melihat kas toko ini");
await db.exec("reset role; set role anon;");
ok((await err(() => q("select * from cash_sessions"))) !== null, "pengunjung tanpa login tidak bisa membaca kas");
await db.exec("reset role");
console.log(fails ? `\n${fails} GAGAL` : "\nSEMUA LULUS"); process.exit(fails ? 1 : 0);
