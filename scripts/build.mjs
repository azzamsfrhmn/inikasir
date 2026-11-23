// Menyiapkan folder dist/ berisi file aplikasi saja untuk diunggah ke Cloudflare Pages.
// File lain di repo (SQL, uji, ROADMAP, README) tidak ikut terbit di situs.
// Pakai: npm run build
import { cpSync, rmSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");
const PUBLIC = [
  "index.html", "config.js", "sw.js", "_headers",
  "kasir/index.html", "kasir/manifest.webmanifest",
  "admin/index.html", "admin/manifest.webmanifest",
  "assets",
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const p of PUBLIC) {
  const src = join(ROOT, p);
  if (!existsSync(src)) { console.error(`Hilang: ${p}`); process.exit(1); }
  cpSync(src, join(OUT, p), { recursive: true });
}
console.log(`dist/ siap (${PUBLIC.length} entri)`);
