// Uji migrasi 004 (pengaturan struk): argumen schema.sql lalu migrasi berurutan
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
const OWNER = "11111111-1111-1111-1111-111111111111", HP = "33333333-3333-3333-3333-333333333333";
for (const u of [OWNER, HP]) await q("insert into auth.users values ($1)", [u]);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
async function as(user, anon, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const store = (await as(OWNER, false, () => q("select * from create_store('Toko A')"))).rows[0];
await as(OWNER, false, () => q("select set_kasir_pin($1,'4321')", [store.id]));
await as(HP, true, () => q("select join_store($1,'4321','HP')", [store.join_code]));
ok(JSON.stringify(store.receipt) === "{}", "toko baru: pengaturan struk kosong (pakai bawaan)");
const r = { header_text: "Halal · Buka 15.00", footer_text: "Ditunggu lagi", show_address: true, show_phone: false, paper: "80" };
await as(OWNER, false, () => q("update stores set receipt = $1 where id = $2", [JSON.stringify(r), store.id]));
ok((await as(HP, true, () => q("select receipt from stores"))).rows[0].receipt.footer_text === "Ditunggu lagi", "HP kasir membaca pengaturan struk");
ok(await err(() => as(HP, true, () => q("update stores set receipt = '{}'"))) !== null || (await as(OWNER, false, () => q("select receipt from stores"))).rows[0].receipt.footer_text === "Ditunggu lagi", "HP kasir tidak bisa mengubah struk");
ok(await err(() => as(OWNER, false, () => q("update stores set receipt = '[]' where id=$1", [store.id]))) !== null, "format struk harus objek");
ok(await err(() => as(OWNER, false, () => q("update stores set receipt = $1 where id=$2", [JSON.stringify({ logo: "x".repeat(130000) }), store.id]))) !== null, "struk terlalu besar (logo raksasa) ditolak");
await as(OWNER, false, () => q("update stores set name = 'Toko B' where id=$1", [store.id]));
ok((await as(OWNER, false, () => q("select name from stores"))).rows[0].name === "Toko B", "ubah info toko lain tetap jalan");
console.log(fails ? `\n${fails} GAGAL` : "\nSEMUA LULUS"); process.exit(fails ? 1 : 0);
