// Kerangka uji database: Postgres (PGlite) dengan tiruan lingkungan Supabase
// (auth.uid, auth.jwt, role anon/authenticated). Tanpa grant otomatis, sama seperti
// proyek Supabase yang opsi "Grant API access to new tables automatically" dimatikan.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase");
export const sqlFile = (name) => (name === "schema" ? join(ROOT, "schema.sql") : join(ROOT, "migrations", name));

export async function setup(migrations = [], users = []) {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on all functions in schema auth to anon, authenticated;`);
  await db.exec(readFileSync(sqlFile("schema"), "utf8"));
  for (const m of migrations) await db.exec(readFileSync(sqlFile(m), "utf8"));
  for (const u of users) await db.query("insert into auth.users values ($1)", [u]);
  const q = (sql, params) => db.query(sql, params);
  async function as(user, anon, fn) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);
      select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, is_anonymous: anon })}', false); set role authenticated;`);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const one = async (u, a, sql, p) => (await as(u, a, () => q(sql, p))).rows[0];
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
  return { db, q, as, one, err };
}

export function reporter(title) {
  let fails = 0;
  console.log(`\n== ${title}`);
  return {
    ok(cond, msg) { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) fails++; },
    done() { console.log(fails ? `  ${fails} GAGAL` : "  SEMUA LULUS"); return fails; },
  };
}
