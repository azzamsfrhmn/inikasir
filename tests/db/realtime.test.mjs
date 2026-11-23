// Uji migrasi 008: tabel masuk publikasi realtime, aman dijalankan ulang & tanpa migrasi lain
import { setup, reporter, sqlFile } from "./harness.mjs";
import { readFileSync } from "fs";

export default async function () {
  const t = reporter("008 realtime");
  const pub = async (q) => (await q("select string_agg(tablename, ',' order by tablename) n from pg_publication_tables where pubname='supabase_realtime'")).rows[0].n;

  const a = await setup(["008_realtime.sql"]);
  t.ok((await pub(a.q)) === "cashflow,products,transactions", "hanya skema dasar: transactions, cashflow, products");
  await a.db.exec(readFileSync(sqlFile("005_kas_harian.sql"), "utf8"));
  await a.db.exec(readFileSync(sqlFile("008_realtime.sql"), "utf8"));
  t.ok((await pub(a.q)) === "cash_sessions,cashflow,products,transactions", "dijalankan ulang setelah 005: cash_sessions ikut, tanpa error");

  const b = await setup(["003_stok_hpp.sql", "005_kas_harian.sql", "007_nama_hp.sql", "008_realtime.sql"]);
  t.ok((await pub(b.q)) === "cash_sessions,cashflow,products,transactions", "bersama migrasi lain");
  return t.done();
}
