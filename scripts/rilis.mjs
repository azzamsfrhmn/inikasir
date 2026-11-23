// Menyiapkan rilis baru dalam satu langkah, supaya HP kasir & admin tahu ada pembaruan.
// Pakai: npm run rilis -- "Catatan perubahan 1" "Catatan perubahan 2"
// Yang diubah: version.json (nomor versi + catatan), ?v=N di file html, dan nama cache di sw.js.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const notes = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!notes.length) { console.error('Tulis catatan perubahan: npm run rilis -- "Apa yang baru"'); process.exit(1); }

const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const wr = (p, s) => writeFileSync(join(ROOT, p), s);

// 1. version.json: 1.4 -> 1.5
const ver = JSON.parse(rd("version.json"));
const [maj, min] = String(ver.version).split(".").map(Number);
const next = `${maj}.${(min || 0) + 1}`;
const d = new Date(), pad = (n) => String(n).padStart(2, "0");
wr("version.json", JSON.stringify({ version: next, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, notes }, null, 2) + "\n");

// 2. ?v=N di semua halaman (nomor sama di ketiganya)
const HTML = ["index.html", "kasir/index.html", "admin/index.html"];
const cur = Math.max(...HTML.map((p) => Math.max(0, ...[...rd(p).matchAll(/\?v=(\d+)/g)].map((m) => +m[1]))));
for (const p of HTML) wr(p, rd(p).replace(/\?v=\d+/g, `?v=${cur + 1}`));

// 3. nama cache service worker
const sw = rd("sw.js"), m = sw.match(/const CACHE = "inikasir-v(\d+)"/);
if (!m) { console.error("Nama cache di sw.js tidak ditemukan"); process.exit(1); }
wr("sw.js", sw.replace(m[0], `const CACHE = "inikasir-v${+m[1] + 1}"`));

console.log(`Versi ${next} siap (aset ?v=${cur + 1}, cache inikasir-v${+m[1] + 1}). Commit & push untuk menerbitkan.`);
