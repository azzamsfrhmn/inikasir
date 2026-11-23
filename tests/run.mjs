// Menjalankan semua uji database (aturan akses RLS, fungsi, hitungan) di Postgres lokal (PGlite).
// Pakai: npm test
// Setiap kombinasi urutan migrasi diuji, karena pemilik bisa memasang migrasi
// dengan urutan berbeda (misalnya 002 dipasang belakangan).
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPA = join(HERE, "..", "supabase");
const f = (m) => (m === "schema" ? join(SUPA, "schema.sql") : join(SUPA, "migrations", m));
const M = { s: "schema", k: "002_karyawan_shift.sql", st: "003_stok_hpp.sql", r: "004_struk.sql", kas: "005_kas_harian.sql", t: "006_template_usaha.sql" };

const runs = [
  ["akses-dasar.test.mjs", [M.s]],
  ["karyawan-shift.test.mjs", [M.s, M.k]],
  ["stok-hpp.test.mjs", [M.s, M.st]],
  ["stok-hpp.test.mjs", [M.s, M.k, M.st]],
  ["stok-hpp.test.mjs", [M.s, M.st, M.k]],
  ["stok-hpp.test.mjs", [M.s, M.st, M.r, M.kas, M.t]],
  ["struk.test.mjs", [M.s, M.r]],
  ["struk.test.mjs", [M.s, M.st, M.r]],
  ["kas-harian.test.mjs", [M.s, M.kas]],
  ["kas-harian.test.mjs", [M.s, M.st, M.r, M.kas, M.t]],
  ["kas-harian.test.mjs", [M.s, M.k, M.st, M.r, M.kas, M.t]],
];

let failed = 0;
for (const [file, migs] of runs) {
  const label = `${file} [${migs.map((m) => m.replace(/_.*$/, "").replace("schema", "skema")).join(" + ")}]`;
  const r = spawnSync(process.execPath, [join(HERE, "db", file), ...migs.map(f)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = (out.match(/^PASS /gm) || []).length, fail = (out.match(/^FAIL /gm) || []).length;
  if (r.status === 0) console.log(`ok    ${label}  (${pass} lulus)`);
  else { failed++; console.log(`GAGAL ${label}\n${out.split("\n").filter((l) => /FAIL|Error|rror:/.test(l)).join("\n")}`); }
  if (r.status !== 0 && fail === 0) console.log(out.slice(-2000));
}
// uji gaya baru (modul)
for (const mod of ["template.test.mjs", "nama-hp.test.mjs", "realtime.test.mjs"]) {
  const run = (await import(new URL(`./db/${mod}`, import.meta.url))).default;
  if (await run()) failed++;
}
console.log(failed ? `\n${failed} kelompok uji GAGAL` : "\nSemua uji lulus");
process.exit(failed ? 1 : 0);
