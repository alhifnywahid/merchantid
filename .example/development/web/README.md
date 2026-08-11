# MerchantId Live Development Lab

Aplikasi TanStack Start + Tailwind CSS untuk menguji package `merchantid` dari build lokal sebelum publish npm. Dependency pada `package.json` sengaja tetap memakai:

```json
"merchantid": "file:../.."
```

Login, lifecycle sesi, discovery, QRIS, payment, dan rekonsiliasi karena itu berjalan terhadap build repository saat ini, bukan versi registry.

> Lab ini selalu memakai API live. Pengiriman OTP, discovery, refresh sesi, dan rekonsiliasi dapat mengirim request nyata ke provider.

## Prasyarat

- Node.js 20.19 atau lebih baru.
- Dependency root sudah terpasang.
- Package root sudah dibuild sehingga `dist/` tersedia.
- Akun merchant milik sendiri pada mesin development tepercaya.

## Menjalankan

Dari root repository:

```powershell
npm run build
Set-Location .example/web
npm install
npm run dev
```

Buka `http://localhost:5179`. Dev server adalah proses panjang; jalankan sendiri di terminal dan hentikan dengan `Ctrl+C`. Jangan menjalankannya sebagai quality gate otomatis.

Jika API package root berubah, hentikan server, build ulang dari root, lalu install ulang dependency lokal bila npm belum menyegarkan package `file:../..`.

## Alur penggunaan

Halaman memiliki dua tab provider: **GoPay** dan **Shopee**. Pilihan tab terakhir disimpan di state lab.

1. Pilih provider.
2. Masukkan nomor akun sendiri dan kirim OTP nyata.
3. Verifikasi OTP, lalu selesaikan pemilihan merchant atau store bila diminta.
4. Perbarui discovery dan pastikan scope provider/account/merchant-store benar.
5. Ikat QRIS statis ke scope aktif. Untuk Shopee, payload diberikan manual karena tidak ada endpoint discovery QRIS yang terverifikasi.
6. Buat pembayaran. Nominal akhir di ledger mencakup offset unik yang harus dibayar penuh.
7. Jalankan rekonsiliasi manual untuk membaca feed provider, atau batalkan payment yang masih pending.
8. Gunakan panel aktivitas tersunting untuk diagnostik tanpa menampilkan material sesi.

Rekonsiliasi sengaja tidak berjalan pada polling background agar hot reload tidak menggandakan interval.

## Batas keamanan

- Gunakan hanya akun merchant milik sendiri.
- OTP, token, cookie, auth challenge, provider instance, dan QRIS statis mentah tetap di modul server.
- Browser hanya menerima DTO tersunting, fingerprint pendek, metadata scope, payment DTO, dan SVG QR hasil render.
- Jangan menyalin isi `data/`, request DevTools, QRIS, credential, atau output akun ke issue, fixture, screenshot publik, maupun commit.
- Hentikan pada `CAPTCHA_REQUIRED`; lab tidak mencoba bypass.
- Shopee tidak memiliki refresh flow terverifikasi. Login ulang bila sesi berakhir.
- Keberhasilan build dan test tidak membuktikan login atau settlement live berhasil tanpa pengujian manual menggunakan akun sah.

## Persistence dan migrasi

Runtime memakai:

```text
data/
  lab-state.json   sesi provider, pilihan scope, dan aktivitas
  payments.json    payment development beserta PaymentScope
```

`data/` diabaikan Git. File ditulis atomik, tetapi `JsonPaymentStore` tetap hanya aman untuk satu proses development dan bukan persistence production.

Schema state saat ini adalah **v2 live-only**. Saat runtime menemukan state schema v1 atau schema lain yang tidak didukung, runtime menghapus state dan payment lama lalu membuat state v2 kosong. Reset ini mencegah credential, scope, atau payment lama dianggap sebagai data live yang valid.

## Struktur

```text
src/
  components/
    provider-access.tsx     OTP, sesi, discovery, dan scope
    payment-workbench.tsx   binding QRIS dan pembuatan payment
    payment-ledger.tsx      QR, cancel, dan rekonsiliasi manual
    activity-timeline.tsx   aktivitas runtime tersunting
    lab-ui.tsx              primitive UI, kontrol tema, dan formatter
  lib/lab-types.ts          DTO serializable untuk browser
  routes/
    __root.tsx              document shell, metadata, dan theme boot script
    index.tsx               dua tab provider dan state orchestration
  server/
    functions.ts            server functions dengan validator Zod
    lab.server.ts           runtime provider live dan action queue
    storage.server.ts       state JSON dan PaymentStore single-process
  styles.css                token, primitive, dan layout sistem visual
```

Semua input mutasi melewati validator server function. Operasi runtime diserialkan melalui satu queue agar create, cancel, rekonsiliasi, dan transisi sesi tidak saling menimpa dalam proses yang sama.

## Sistem visual

UI mengikuti bahasa desain pada [`design.md`](design.md) - greys netral dengan satu warna aksi coral, garis rambut dan rel putus-putus sebagai pengganti bayangan, serta tracking negatif yang mengetat seiring ukuran heading. Kepadatannya memakai tier *editor* dari sistem itu: baris kontrol 28px, teks UI 12px, dan eyebrow mono.

- **Progressive disclosure.** Sebuah surface hanya dirender kalau sudah bisa dipakai, jadi tidak ada placeholder disabled dan tidak ada kalimat yang menjelaskan apa yang belum tersedia. Kolom kiri menampilkan kartu login **atau** kartu sesi, tidak pernah keduanya; workbench muncul setelah scope siap dan menampilkan langkah QRIS **atau** form pembayaran; ledger dan catatan aktivitas hilang saat kosong. Layout otomatis jadi satu kolom saat workbench belum ada.
- **Copy.** Satu kalimat prosa di seluruh halaman - peringatan akun live. Sisanya label, nilai, atau kontrol. Penjelasan panjang tinggal di README ini, bukan di UI.
- **Token.** Semua warna hidup di `:root` sebagai `oklch()` di dalam `light-dark()`, jadi mode terang dan gelap berbagi satu definisi dan `color-scheme` yang menentukan hasilnya. Komponen memakai token atau turunan `color-mix()`, bukan literal.
- **Tema.** Kontrol segmented `sys / trg / glp` menyimpan pilihan di `localStorage`, dan snippet blocking di `<head>` memasangnya sebelum paint pertama sehingga tidak ada kedipan.
- **Tanpa elevasi.** Tidak ada satu pun `box-shadow` atau gradient fill pada chrome. Pemisahan datang dari garis rambut, permukaan beralpha, `backdrop-filter`, dan radius bertingkat.
- **Motion.** Hanya dua durasi, 150ms dan 500ms, dengan `cubic-bezier(0.4, 0, 0.2, 1)`. `prefers-reduced-motion` mematikan seluruh animasi.
- **Font.** Geist dan Geist Mono di-*self-host* lewat `@fontsource-variable/*`, jadi tidak ada request ke CDN font pihak ketiga.
- **Kontras.** Setiap teks lolos WCAG 2.1 AA pada kedua tema. Dua nilai sengaja menyimpang dari `design.md` demi itu: `--primary` terang turun ke oklch L 58%, dan `--destructive` terang ke L 51% karena selalu dibaca di atas wash-nya sendiri. Alasannya dicatat di komentar `styles.css`.
- **Target sentuh.** Kepadatan 28px adalah afordansi pointer halus; `@media (pointer: coarse)` menaikkan tinggi kontrol ke 40px.

## Validasi

Setelah root package dibuild dan dependency lokal terpasang:

```powershell
npm run typecheck
npm test
npm run build
```

Quality gate repository tetap dijalankan dari root:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Website ini adalah utility development, bukan dashboard production atau secret store production.
