# Laciku: dari aplikasi satu warung menjadi produk

**Target pasar:** pedagang jajanan & gerobak (otak-otak, siomay, gorengan, cilok, minuman).
**Pembeda:** paling simpel, tetap jalan tanpa sinyal, QRIS statis tanpa potongan, penjaga tidak bisa melihat keuangan, kas laci ketahuan selisihnya.

## Sudah ada
- Banyak toko dalam satu sistem, data tiap toko terpisah (dijaga aturan database, diuji otomatis).
- Kasir offline + QRIS, stok & HPP, laporan & grafik, kas harian, atur struk, PWA, shift/karyawan (opsional).
- Merek **Laciku** diatur di satu tempat; pilih jenis dagangan saat buat toko.
- Uji otomatis database (`npm test`) di setiap push lewat GitHub Actions.

## Tahap 1: siap dicoba pedagang lain (belum berbayar)
- [ ] Kesepakatan tertulis dengan client pertama: kepemilikan kode/aplikasi vs data penjualan client.
- [ ] Cek merek "Laciku" di PDKI (pdki-indonesia.dgip.go.id) dan Play Store; beli domain (`laciku.id` masih kosong per 24 Nov 2026).
- [ ] Pindah hosting ke Cloudflare Pages (paket gratis boleh untuk komersial; GitHub Pages tidak).
- [ ] Email lewat SMTP sendiri (Resend/Brevo) supaya konfirmasi daftar tidak tertahan batas email bawaan Supabase.
- [ ] Halaman depan (landing page) + Syarat & Ketentuan + Kebijakan Privasi (UU PDP).
- [ ] Ikon & logo Laciku (sekarang masih huruf K/A).
- [ ] Laporan dihitung di server (fungsi SQL) supaya tetap cepat saat data setahun.
- [ ] Uji coba gratis dengan 5–10 pedagang selama 1–2 bulan; catat pemakaian harian dan kesediaan membayar.

## Tahap 2: siap dijual
- [ ] Supabase Pro (backup harian, tidak dijeda) atau setara.
- [ ] Panel super-admin: daftar toko, status langganan, bantuan.
- [ ] Langganan: masa coba, paket, pembayaran (Midtrans/Xendit; biasanya perlu NIB), pembatasan saat belum bayar.
- [ ] Migrasi database dikelola Supabase CLI (bukan tempel manual di SQL Editor).
- [ ] Pemantauan error dan kanal bantuan (WhatsApp).
