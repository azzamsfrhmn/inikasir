# IniKasir: dari aplikasi satu warung menjadi produk

**Target pasar:** pedagang jajanan & gerobak (otak-otak, siomay, gorengan, cilok, minuman).
**Pembeda:** paling simpel, tetap jalan tanpa sinyal, QRIS statis tanpa potongan, penjaga tidak bisa melihat keuangan, kas laci ketahuan selisihnya.

## Sudah ada
- Banyak toko dalam satu sistem, data tiap toko terpisah (dijaga aturan database, diuji otomatis).
- Kasir offline + QRIS, stok & HPP, laporan & grafik, kas harian, atur struk, PWA, shift/karyawan (opsional).
- Merek **IniKasir** diatur di satu tempat; pilih jenis dagangan saat buat toko.
- Uji otomatis database (`npm test`) di setiap push lewat GitHub Actions.

## Tahap 1: siap dicoba pedagang lain (belum berbayar)
- [ ] Kesepakatan tertulis dengan client pertama: kepemilikan kode/aplikasi vs data penjualan client.
- [ ] Cek merek "IniKasir" di PDKI (pdki-indonesia.dgip.go.id) dan Play Store; beli domain sendiri. (Nama awal "Laciku" batal: laciku.my.id dan laciku.pages.dev sudah dipakai orang lain.)
- [x] Pindah hosting ke Cloudflare Pages: https://inikasir.pages.dev (paket gratis boleh untuk komersial; GitHub Pages tidak). Sisa: pindahkan HP kasir, lalu matikan GitHub Pages.
- [ ] Email lewat SMTP sendiri (Resend/Brevo) supaya konfirmasi daftar tidak tertahan batas email bawaan Supabase.
- [ ] Halaman depan (landing page) + Syarat & Ketentuan + Kebijakan Privasi (UU PDP).
- [x] Ikon & logo IniKasir (logo "K panah", dibuat oleh `scripts/icons.mjs`).
- [ ] Laporan dihitung di server (fungsi SQL) supaya tetap cepat saat data setahun.
- [ ] Uji coba gratis dengan 5–10 pedagang selama 1–2 bulan; catat pemakaian harian dan kesediaan membayar.

## Tahap 2: siap dijual
- [ ] Supabase Pro (backup harian, tidak dijeda) atau setara.
- [ ] Panel super-admin: daftar toko, status langganan, bantuan.
- [ ] Langganan: masa coba, paket, pembayaran (Midtrans/Xendit; biasanya perlu NIB), pembatasan saat belum bayar.
- [ ] Migrasi database dikelola Supabase CLI (bukan tempel manual di SQL Editor).
- [ ] Pemantauan error dan kanal bantuan (WhatsApp).
