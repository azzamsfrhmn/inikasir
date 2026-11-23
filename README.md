# IniKasir

Kasir simpel untuk pedagang jajanan & gerobak: jualan di HP penjaga (bisa offline), laporan, stok, dan kas laci di halaman pemilik.

Rencana menjadikannya produk untuk banyak pedagang ada di [ROADMAP.md](ROADMAP.md).

- **Halaman depan** (`/`): perkenalan singkat dan pilihan masuk sebagai penjaga kasir atau pemilik. HP yang sudah tersambung sebagai kasir langsung dialihkan ke `/kasir/`.
- **Halaman kasir** (`/kasir/`): untuk penjaga. Hanya bisa mencatat penjualan, tunai atau QRIS (pembeli scan QRIS yang tercetak di toko). Tetap bisa jualan saat sinyal hilang; penjualan dikirim otomatis begitu online.
- **Halaman admin** (`/admin/`): untuk pemilik. Daftar dan masuk pakai email. Berisi laporan, keuangan, riwayat, produk, dan pengaturan kasir. Bisa dibuka dari HP mana saja.

Data disimpan di [Supabase](https://supabase.com) (paket gratis cukup). Aturan akses ada di database, jadi penjaga benar-benar tidak bisa membaca transaksi atau keuangan, bukan sekadar disembunyikan di tampilan.

## Setup (sekali saja, sekitar 15 menit)

### 1. Buat proyek Supabase
1. Daftar di https://supabase.com, lalu **New project**. Region: **Southeast Asia (Singapore)**. Simpan password database-nya.
2. Tunggu proyek selesai dibuat (1–2 menit).

### 2. Pasang database
1. Buka **SQL Editor** > **New query**.
2. Tempel seluruh isi [`supabase/schema.sql`](supabase/schema.sql), lalu **Run**. Harus muncul "Success. No rows returned".
3. Jalankan juga file di [`supabase/migrations/`](supabase/migrations/) **berurutan**, masing-masing sekali, dengan cara yang sama:
   - `002_karyawan_shift.sql`: akun karyawan, hak akses, shift (kas awal/akhir), absensi. (Opsional, saat ini ditunda.)
   - `003_stok_hpp.sql`: stok barang jadi, harga beli (modal), HPP & laba. Tidak butuh 002.
   - `004_struk.sql`: pengaturan struk (teks atas/bawah, info yang tampil, logo, lebar kertas). Tidak butuh 002/003.
   - `005_kas_harian.sql`: buka & tutup kasir (kas awal/akhir) versi sederhana tanpa karyawan/PIN; selisih kas di menu Keuangan. Tidak butuh 002/003/004.
   - `006_template_usaha.sql`: pilih jenis dagangan saat buat toko (otak-otak, gorengan, jajanan, minuman, kosong) untuk produk contoh. Tidak butuh yang lain.

### 3. Atur login
Di **Authentication**:
1. **Sign In / Providers**: nyalakan **Allow anonymous sign-ins** (dipakai HP kasir, yang tidak punya email). Biarkan **Email** tetap menyala.
2. **URL Configuration**:
   - **Site URL**: `https://<alamat-situs>/admin/` (misalnya `https://inikasir.pages.dev/admin/`)
   - **Redirect URLs**: tambahkan `https://<alamat-situs>/admin/`

### Hosting (Cloudflare Pages, gratis)
Di Cloudflare: **Workers & Pages** > **Create** > **Pages** > **Connect to Git**, pilih repo ini, lalu:
- **Build command**: `npm run build`
- **Build output directory**: `dist`

Hanya file aplikasi yang terbit (lihat `scripts/build.mjs`); SQL, uji, dan catatan rencana tidak ikut. Setiap push ke `main` otomatis terbit ulang.

### 4. Sambungkan aplikasi
Buka **Project Settings** > **Data API** (atau **API**). Salin **Project URL** dan **anon public** key ke [`config.js`](config.js):

```js
window.INIKASIR_CONFIG = {
  supabaseUrl: "https://xxxx.supabase.co",
  supabaseAnonKey: "eyJ...",
};
```

Anon key aman ditaruh di sini karena semua akses dijaga aturan di database. **Jangan** pernah menaruh `service_role` key di aplikasi.

### 5. Mulai pakai
1. Pemilik buka `/admin/`, **Daftar**, klik link konfirmasi di email, lalu **Buat toko**.
2. Di **Setelan**: atur **PIN kasir**, lalu cek nama dan harga di **Produk**.
3. Di HP penjaga buka `/kasir/` (atau `/` lalu **Penjaga kasir**), masukkan **kode toko** dan **PIN kasir**. Tambahkan ke layar utama lewat menu Chrome.
4. Opsional, di menu **Karyawan**: buat karyawan (nama + PIN + hak akses). Setelah ada karyawan aktif, penjaga harus pilih nama dan ketik PIN untuk **buka shift** (jam masuk + kas awal) dan **tutup shift** (jam pulang + kas akhir). Rekap absensi dan selisih kas ada di halaman yang sama.

Setiap kali `assets/common.js` atau `assets/app.css` berubah, naikkan angka `?v=` di `index.html`, `kasir/index.html`, dan `admin/index.html` dan `CACHE` di `sw.js` supaya HP tidak memakai file lama.

## Catatan
- Proyek Supabase gratis dijeda otomatis kalau tidak ada aktivitas sekitar seminggu. Kalau toko tutup lama, buka dashboard Supabase dan tekan **Restore**.
- Email konfirmasi bawaan Supabase dibatasi beberapa email per jam. Untuk satu toko ini cukup.
- Pemilik bisa memutus HP kasir yang hilang dari **Setelan > Penjaga kasir**, dan mengganti kode toko kalau kodenya bocor.

## Pengembangan
- **Uji otomatis:** `npm install` lalu `npm test`. Menjalankan semua uji aturan akses & fungsi database (PGlite) untuk setiap urutan migrasi. GitHub Actions menjalankannya otomatis setiap push.
- Nama merek diatur di `assets/common.js` (`BRAND`) dan bisa ditimpa lewat `config.js` (`brand`). Kunci penyimpanan `inikasir-*` di HP sengaja tidak diganti supaya HP yang sudah tersambung tidak keluar.
- `supabase/schema.sql`: tabel, aturan akses (RLS), dan fungsi `create_store`, `join_store`, `record_sale`, dll.
- `index.html`: halaman kasir. `admin/index.html`: halaman admin. `assets/`: CSS dan kode bersama. `sw.js`: cache untuk mode offline.
