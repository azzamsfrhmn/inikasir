// Service worker: menyimpan file aplikasi di HP supaya halaman kasir tetap bisa dibuka
// saat tidak ada sinyal. Data (Supabase) tidak pernah di-cache di sini; penjualan offline
// disimpan oleh halaman kasir sendiri lalu dikirim saat online.
// Letaknya di akar situs supaya HP yang dulu memasang kasir di "/" tetap mendapat pembaruan.
const CACHE = "inikasir-v21";
const SHELL = [
  "./", "kasir/", "kasir/index.html", "kasir/manifest.webmanifest", "config.js", "assets/app.css", "assets/common.js",
  "assets/icons/kasir.svg", "assets/icons/kasir-192.png", "assets/icons/kasir-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".supabase.co") || url.pathname.includes("/rest/v1/") || url.pathname.includes("/auth/v1/")) return;
  if (url.origin === location.origin) {
    // file aplikasi: selalu cek versi terbaru ke server (lewati cache HTTP), kalau offline pakai simpanan
    e.respondWith(fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => {
      if (r) return r;
      if (url.pathname.includes("/admin/")) return Response.error();
      // halaman yang belum tersimpan: HP kasir tetap bisa jualan
      return caches.match(new URL("kasir/index.html", self.registration.scope).href);
    })));
  } else {
    // pustaka & font dari CDN (versinya dikunci): pakai simpanan dulu
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
