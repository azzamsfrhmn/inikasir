"use strict";
/* Kode bersama halaman kasir & admin: utilitas, QRIS, struk, koneksi Supabase */

const CFG = window.INIKASIR_CONFIG || {};
const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

// Kasir & admin memakai sesi login terpisah, supaya pemilik bisa masuk admin
// di HP kasir tanpa memutus sambungan HP kasir.
function makeClient(storageKey) {
  return window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: storageKey === "inikasir-admin" },
  });
}

/* ---------- Utilitas ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const rp = (n) => { n = Math.round(n || 0); return (n < 0 ? "−Rp" : "Rp") + Math.abs(n).toLocaleString("id-ID"); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const parseNum = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;
const pad = (n, l = 2) => String(n).padStart(l, "0");
const dayKey = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = (d) => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (d) => new Date(d).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtDateShort = (k) => new Date(k + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
const startOfDay = (k) => new Date(k + "T00:00:00");
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function openModal(id) { $("#" + id).classList.add("show"); }
function closeModal(id) { $("#" + id).classList.remove("show"); }
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function bindMoneyInput(el) {
  el.addEventListener("input", () => { const n = parseNum(el.value); el.value = n ? n.toLocaleString("id-ID") : ""; });
}
const local = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* penyimpanan penuh / diblokir */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } },
};
const isNetworkError = (e) => !navigator.onLine || /fetch|network|Load failed|timeout/i.test(String(e && (e.message || e)));

// Terjemahkan pesan error Supabase ke bahasa yang dimengerti pemilik toko
function errMsg(e) {
  const m = String((e && (e.message || e.error_description || e)) || "");
  if (isNetworkError(e)) return "Tidak ada koneksi internet. Coba lagi setelah sinyal ada.";
  const map = [
    [/Invalid login credentials/i, "Email atau password salah."],
    [/Email not confirmed/i, "Email belum dikonfirmasi. Buka email dari Supabase dan klik link konfirmasinya."],
    [/User already registered/i, "Email ini sudah terdaftar. Silakan masuk."],
    [/Password should be at least/i, "Password minimal 8 karakter."],
    [/rate limit|too many/i, "Terlalu sering mencoba. Tunggu beberapa menit lalu coba lagi."],
    [/Anonymous sign-ins are disabled/i, "Login anonim belum diaktifkan di Supabase (Authentication > Sign In / Providers > Allow anonymous sign-ins)."],
    [/Unable to validate email|invalid format/i, "Format email tidak valid."],
    [/JWT|token/i, "Sesi habis. Muat ulang halaman lalu masuk lagi."],
  ];
  for (const [re, txt] of map) if (re.test(m)) return txt;
  return m || "Terjadi kesalahan.";
}

/* ---------- Pasang aplikasi (PWA) ---------- */
let installEvent = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); installEvent = e; document.body.classList.add("can-install");
});
window.addEventListener("appinstalled", () => {
  installEvent = null; document.body.classList.remove("can-install"); toast("Aplikasi terpasang. Buka dari layar utama.");
});
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-install]") || !installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null; document.body.classList.remove("can-install");
});
function installHintText(appName) {
  if (isStandalone()) return "";
  if (isIOS()) return `Pasang di iPhone: buka di Safari, tekan tombol Bagikan, lalu pilih "Tambahkan ke Layar Utama".`;
  return `Pasang di Android: tekan "Instal aplikasi" kalau tombolnya muncul, atau menu Chrome (titik tiga) lalu "Instal aplikasi" / "Tambahkan ke layar utama". Ikon ${appName} akan muncul di layar utama.`;
}

/* ---------- Struk ---------- */
// shop: {name, address, phone}; tx: {no, time, items:[{name,price,qty}], total, method, paid, change, voided}
function receiptHTML(shop, tx) {
  return `<div class="receipt">
    <div class="c"><b style="font-size:15px">${esc(shop.name)}</b>${shop.address ? "<br>" + esc(shop.address) : ""}${shop.phone ? "<br>WA " + esc(shop.phone) : ""}</div>
    <hr>
    <div class="l"><span>${tx.no ? esc(tx.no) : "No. menyusul"}</span><span>${new Date(tx.time).toLocaleDateString("id-ID")} ${fmtTime(tx.time)}</span></div>
    <hr>
    ${tx.items.map((i) => `<div>${esc(i.name)}</div><div class="l"><span>&nbsp;${i.qty} x ${i.price.toLocaleString("id-ID")}</span><span>${(i.qty * i.price).toLocaleString("id-ID")}</span></div>`).join("")}
    <hr>
    <div class="l"><b>TOTAL</b><b>${rp(tx.total)}</b></div>
    <div class="l"><span>${tx.method === "qris" ? "QRIS" : "Tunai"}</span><span>${rp(tx.paid)}</span></div>
    ${tx.method === "tunai" ? `<div class="l"><span>Kembali</span><span>${rp(tx.change)}</span></div>` : ""}
    ${tx.voided ? `<hr><div class="c"><b>DIBATALKAN</b></div>` : ""}
    <hr><div class="c">Terima kasih</div>
  </div>`;
}
function receiptText(shop, tx) {
  const L = [];
  L.push(`*${shop.name}*`); if (shop.address) L.push(shop.address);
  if (tx.no) L.push(`No: ${tx.no}`);
  L.push(`${new Date(tx.time).toLocaleDateString("id-ID")} ${fmtTime(tx.time)}`, "------------------");
  tx.items.forEach((i) => L.push(i.name, `  ${i.qty} x ${rp(i.price)} = ${rp(i.qty * i.price)}`));
  L.push("------------------", `*TOTAL ${rp(tx.total)}*`, `Bayar (${tx.method === "qris" ? "QRIS" : "Tunai"}): ${rp(tx.paid)}`);
  if (tx.method === "tunai") L.push(`Kembali: ${rp(tx.change)}`);
  if (tx.voided) L.push("DIBATALKAN");
  L.push("", "Terima kasih");
  return L.join("\n");
}
async function shareText(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("Struk disalin, tinggal tempel di WhatsApp"); }
  catch (e) { prompt("Salin struk ini:", text); }
}

/* ---------- Layar "belum disambungkan ke database" ---------- */
function renderNotConfigured(target) {
  target.innerHTML = `<div class="card auth stack">
    <h2>Aplikasi belum tersambung ke database</h2>
    <p class="muted" style="margin:0">Isi alamat proyek Supabase dan anon key di file <b>config.js</b>, lalu muat ulang halaman ini. Langkah lengkapnya ada di README.</p>
  </div>`;
}
