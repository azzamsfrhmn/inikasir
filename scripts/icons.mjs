// Membuat ikon aplikasi IniKasir (logo "K panah") dalam SVG dan PNG.
// Pakai: node scripts/icons.mjs   (butuh Google Chrome atau Microsoft Edge terpasang)
// Hasil: assets/icons/{kasir,admin}.svg, -180 (iOS), -192, -512, -maskable-512 .png
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "icons");
const INK = "#fffdf7";
const BG = { kasir: "#2c5a39", admin: "#22261f" };

// Tanda: batang K + panah "<" (viewBox 100x100). scale < 1 untuk zona aman ikon maskable.
const mark = (bg, scale = 1) =>
  `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">` +
  `<rect x="24" y="20" width="16" height="60" rx="8" fill="${INK}"/>` +
  `<path d="M74 24L50 50L74 76" fill="none" stroke="${INK}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/></g>`;
const svg = (bg, { rounded = true, scale = 1 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect width="100" height="100" ${rounded ? 'rx="24"' : ""} fill="${bg}"/>${mark(bg, scale)}</svg>`;

const browser = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!browser) { console.error("Chrome/Edge tidak ditemukan"); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "inikasir-icons-"));
function png(svgText, size, file) {
  const html = join(tmp, "i.html");
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style>` +
    `<img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}">`);
  const shot = join(tmp, "s.png");
  const r = spawnSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${shot}`, pathToFileURL(html).href]);
  if (!existsSync(shot)) { console.error(r.stderr?.toString()); process.exit(1); }
  writeFileSync(join(OUT, file), readFileSync(shot));
  rmSync(shot);
}

for (const [name, bg] of Object.entries(BG)) {
  writeFileSync(join(OUT, `${name}.svg`), svg(bg));
  png(svg(bg, { rounded: false }), 180, `${name}-180.png`); // iOS membulatkan sudut sendiri
  png(svg(bg), 192, `${name}-192.png`);
  png(svg(bg), 512, `${name}-512.png`);
  png(svg(bg, { rounded: false, scale: 0.78 }), 512, `${name}-maskable-512.png`);
}
rmSync(tmp, { recursive: true, force: true });
console.log("Ikon selesai dibuat di assets/icons/");
