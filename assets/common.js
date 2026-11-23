"use strict";
/* Kode bersama halaman kasir & admin: utilitas, QRIS, struk, koneksi Supabase */

const CFG = window.INIKASIR_CONFIG || {};
// Merek produk. Bisa ditimpa lewat config.js (INIKASIR_CONFIG.brand) tanpa mengubah kode.
const BRAND = Object.assign({ name: "IniKasir", tagline: "Kasir simpel untuk pedagang jajanan & gerobak" }, CFG.brand || {});
// Isi elemen bertanda data-brand dengan nama merek
document.querySelectorAll("[data-brand]").forEach((el) => { el.textContent = el.dataset.brand === "tagline" ? BRAND.tagline : BRAND.name; });
const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

// Kasir & admin memakai sesi login terpisah, supaya pemilik bisa masuk admin
// di HP kasir tanpa memutus sambungan HP kasir.
function makeClient(storageKey) {
  return window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: storageKey === "inikasir-admin" },
  });
}

/* ---------- Ikon ----------
   Satu keluarga ikon garis (24px, garis 2px, ujung bulat), digambar sendiri supaya ringan
   dan konsisten. Ikon di samping teks disembunyikan dari pembaca layar (aria-hidden). */
const ICONS = {
  chart: '<path d="M3 3v18h18"/><path d="M8 16v-4M13 16V8M18 16v-7"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 14h2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5M20.5 14v.01M14 20.5h.01M17.5 18v2.5h3v-3"/>',
};
const ic = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ""}</svg>`;
// Elemen dengan data-ic="nama" otomatis diberi ikon di depan teksnya
function applyIcons(root = document) {
  root.querySelectorAll("[data-ic]:not([data-ic-done])").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", ic(el.dataset.ic));
    el.dataset.icDone = "1";
  });
}

/* ---------- Penanda cara bayar: Tunai (hijau, ikon uang) vs QRIS (biru, ikon QR) ---------- */
const PAY = { tunai: { label: "Tunai", ic: "cash", where: "di laci" }, qris: { label: "QRIS", ic: "qr", where: "ke rekening" } };
const payTag = (m, voided) => voided ? `<span class="tag void">Batal</span>`
  : `<span class="pay pay-${m === "qris" ? "qris" : "tunai"}">${ic(m === "qris" ? "qr" : "cash")}${m === "qris" ? "QRIS" : "Tunai"}</span>`;
// Ringkasan dua kotak + batang perbandingan. c = {tunai, qris, nTunai?, nQris?}
function paySplit(c) {
  const all = c.tunai + c.qris, pt = all ? Math.round((c.tunai / all) * 100) : 0;
  const box = (m, v, n) => `<div class="pbox pbox-${m}"><div class="k">${ic(PAY[m].ic)}${PAY[m].label}<span>${PAY[m].where}</span></div>
    <div class="v num">${rp(v)}</div>${n != null ? `<div class="s">${n} transaksi</div>` : ""}</div>`;
  return `<div class="paysplit">${box("tunai", c.tunai, c.nTunai)}${box("qris", c.qris, c.nQris)}
    ${all ? `<div class="pbar" role="img" aria-label="Tunai ${pt} persen, QRIS ${100 - pt} persen"><i class="${pt > 0 && pt < 100 ? "mid" : ""}" style="width:${pt}%"></i></div>
    <div class="pbar-l"><span>Tunai ${pt}%</span><span>QRIS ${100 - pt}%</span></div>` : ""}</div>`;
}
const payCount = (list) => list.reduce((c, t) => {
  if (!t.voided) { if (t.method === "qris") { c.qris += t.total; c.nQris++; } else { c.tunai += t.total; c.nTunai++; } }
  return c;
}, { tunai: 0, qris: 0, nTunai: 0, nQris: 0 });

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
// Tombol jadi tidak aktif + teks proses selama menunggu server; panggil tanpa teks untuk mengembalikan
function setBusy(el, text) { if (!el) return; if (text && !el.disabled) el.dataset.label = el.textContent; el.disabled = !!text; el.textContent = text || el.dataset.label || el.textContent; }
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
  // Pesan teknis database jangan sampai ke pengguna; catat di konsol untuk pemeriksaan
  if (/violates|constraint|relation|column|syntax|function .* does not exist|PGRST|duplicate key/i.test(m)) {
    console.warn("Detail error:", m);
    return "Ada kendala di server. Coba lagi sebentar; kalau masih gagal, hubungi pemilik aplikasi.";
  }
  return m || "Terjadi kesalahan. Coba lagi.";
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
// Pengaturan struk dari pemilik (kolom stores.receipt, migrasi 004). Kosong = tampilan bawaan.
function receiptOpts(shop) {
  const r = (shop && shop.receipt) || {};
  return {
    header: (r.header_text || "").trim(), footer: (r.footer_text || "").trim() || "Terima kasih",
    address: r.show_address !== false, phone: r.show_phone !== false, no: r.show_no !== false, cashier: r.show_cashier !== false,
    paper: r.paper === "80" ? "80" : "58", logo: typeof r.logo === "string" && r.logo.startsWith("data:image/") ? r.logo : "",
  };
}
const nl2br = (t) => esc(t).replace(/\n/g, "<br>");
// shop: {name, address, phone, receipt}; tx: {no, time, items:[{name,price,qty}], total, method, paid, change, voided, employee_name}
function receiptHTML(shop, tx) {
  const o = receiptOpts(shop);
  return `<div class="receipt p${o.paper}">
    <div class="c">${o.logo ? `<img class="rc-logo" src="${esc(o.logo)}" alt="">` : ""}<b style="font-size:15px">${esc(shop.name)}</b>${o.address && shop.address ? "<br>" + esc(shop.address) : ""}${o.phone && shop.phone ? "<br>WA " + esc(shop.phone) : ""}${o.header ? "<br>" + nl2br(o.header) : ""}</div>
    <hr>
    <div class="l"><span>${o.no ? (tx.no ? esc(tx.no) : "No. menyusul") : ""}</span><span>${new Date(tx.time).toLocaleDateString("id-ID")} ${fmtTime(tx.time)}</span></div>
    ${o.cashier && tx.employee_name ? `<div class="l"><span>Kasir</span><span>${esc(tx.employee_name)}</span></div>` : ""}
    <hr>
    ${tx.items.map((i) => `<div>${esc(i.name)}</div><div class="l"><span>&nbsp;${i.qty} x ${i.price.toLocaleString("id-ID")}</span><span>${(i.qty * i.price).toLocaleString("id-ID")}</span></div>`).join("")}
    <hr>
    <div class="l"><b>TOTAL</b><b>${rp(tx.total)}</b></div>
    <div class="l"><span>${tx.method === "qris" ? "QRIS" : "Tunai"}</span><span>${rp(tx.paid)}</span></div>
    ${tx.method === "tunai" ? `<div class="l"><span>Kembali</span><span>${rp(tx.change)}</span></div>` : ""}
    ${tx.voided ? `<hr><div class="c"><b>DIBATALKAN</b></div>` : ""}
    <hr><div class="c">${nl2br(o.footer)}</div>
  </div>`;
}
function receiptText(shop, tx) {
  const o = receiptOpts(shop), L = [];
  L.push(`*${shop.name}*`);
  if (o.address && shop.address) L.push(shop.address);
  if (o.phone && shop.phone) L.push("WA " + shop.phone);
  if (o.header) L.push(o.header);
  if (o.no && tx.no) L.push(`No: ${tx.no}`);
  L.push(`${new Date(tx.time).toLocaleDateString("id-ID")} ${fmtTime(tx.time)}`);
  if (o.cashier && tx.employee_name) L.push(`Kasir: ${tx.employee_name}`);
  L.push("------------------");
  tx.items.forEach((i) => L.push(i.name, `  ${i.qty} x ${rp(i.price)} = ${rp(i.qty * i.price)}`));
  L.push("------------------", `*TOTAL ${rp(tx.total)}*`, `Bayar (${tx.method === "qris" ? "QRIS" : "Tunai"}): ${rp(tx.paid)}`);
  if (tx.method === "tunai") L.push(`Kembali: ${rp(tx.change)}`);
  if (tx.voided) L.push("DIBATALKAN");
  L.push("", o.footer);
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

/* ---------- Pembaruan aplikasi ----------
   version.json berisi nomor versi + catatan. Halaman mengeceknya saat dibuka, saat kembali ke
   layar, saat internet kembali, dan tiap 5 menit. Kalau ada versi baru, aplikasi memuat ulang
   sendiri begitu aman (keranjang kosong, tidak ada jendela terbuka, tidak sedang mengetik).
   Kalau belum aman, muncul bilah "Versi baru tersedia" dengan tombol Perbarui.
   Setelah diperbarui, muncul catatan "Yang baru". */
const UPD = { key: "inikasir-seen-version", current: null, pending: null, canReload: () => true, timer: null };
async function fetchVersion() {
  try {
    const r = await fetch(new URL("../version.json", location.href).href + "?t=" + Date.now(), { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
function busyTyping() {
  const a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value && a.type !== "date");
}
function updateSafe() { return !document.querySelector(".modal.show") && !busyTyping() && UPD.canReload(); }
function doReload() {
  toast("Memperbarui aplikasi...");
  setTimeout(() => location.reload(), 900);
}
function tryApplyUpdate() {
  if (!UPD.pending) return;
  if (document.hidden || updateSafe()) return doReload();
  if (!$("#updBar")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="updbar" id="updBar" role="status">
      <span><b>Versi baru ${esc(UPD.pending.version)}</b> tersedia</span>
      <button class="btn small" id="updGo">Perbarui</button></div>`);
    $("#updGo").onclick = () => location.reload();
  }
}
async function checkUpdate() {
  const v = await fetchVersion();
  if (!v || !v.version) return;
  if (!UPD.current) {                       // pertama kali halaman ini mendapat nomor versi
    UPD.current = v.version;
    const seen = local.get(UPD.key, null);
    local.set(UPD.key, v.version);
    if (seen && seen !== v.version) showWhatsNew(v);
    return;
  }
  if (v.version !== UPD.current) {
    UPD.pending = v;
    navigator.serviceWorker?.getRegistration?.().then((r) => r && r.update()).catch(() => {});
    tryApplyUpdate();
  }
}
function showWhatsNew(v) {
  const notes = (v.notes || []).map((n) => `<li>${esc(n)}</li>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<div class="modal show" id="mWhatsNew"><div class="box stack" style="max-width:420px">
    <div><span class="wn-badge">${ic("download")}Versi ${esc(v.version)}</span></div>
    <h2 style="margin:0">${esc(BRAND.name)} sudah diperbarui</h2>
    ${notes ? `<div><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:6px">Yang baru</div><ul class="wn">${notes}</ul></div>` : ""}
    <div class="row modal-actions"><div class="grow"></div><button class="btn primary" id="wnOk">Oke</button></div>
  </div></div>`);
  const close = () => $("#mWhatsNew")?.remove();
  $("#wnOk").onclick = close;
  $("#mWhatsNew").addEventListener("click", (e) => { if (e.target.id === "mWhatsNew") close(); });
}
// canReload: fungsi dari halaman, true kalau aman dimuat ulang (mis. keranjang kosong)
function initUpdates(canReload) {
  if (canReload) UPD.canReload = canReload;
  checkUpdate();
  setInterval(checkUpdate, 5 * 60 * 1000);
  setInterval(tryApplyUpdate, 15 * 1000);   // versi baru menunggu: pasang begitu kasir senggang
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); else tryApplyUpdate(); });
  window.addEventListener("online", checkUpdate);
}

// Pasang ikon pada elemen statis (skrip dimuat di akhir <body>, jadi DOM sudah ada)
applyIcons();
