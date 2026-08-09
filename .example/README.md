# Development lab `merchid`

Folder ini berisi aplikasi development lokal yang memakai package root melalui `merchid: file:../..`, bukan package registry npm. Tujuannya menguji source dan artefak build sebelum versi baru dirilis.

| Folder         | Bentuk                    | Cakupan                                                                                               |
| -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`web/`](web/) | TanStack Start + Tailwind | GoPay dan Shopee: OTP, sesi, discovery, merchant/store scope, QRIS, payment, cancel, dan rekonsiliasi |

## Menjalankan web lab

Build package root terlebih dahulu karena dependency lokal membaca artefak `dist/`:

```powershell
npm run build
Set-Location .example/web
npm install
npm run dev
```

Buka `http://localhost:5179`. `npm run dev` adalah proses panjang; jalankan sendiri di terminal development dan hentikan dengan `Ctrl+C`.

Web lab selalu menggunakan API live. Mengirim OTP, memperbarui discovery atau sesi, dan menjalankan rekonsiliasi dapat mengirim request nyata. Gunakan hanya akun merchant milik sendiri pada mesin tepercaya.

## Boundary keamanan

- Sesi, token, cookie, OTP challenge, provider instance, dan payload QRIS statis hanya diproses modul server.
- Browser menerima DTO tersunting, fingerprint pendek, dan SVG QR yang sudah dihasilkan.
- State berada di `.example/web/data/`; direktori ini diabaikan Git dan dapat memuat credential nyata.
- Schema state v2 mereset state dan payment schema lama sebelum membuat state live-only baru.
- Jangan tempel isi `data/`, output provider, QRIS, atau konfigurasi akun ke issue, fixture, maupun commit.
- Activity trail disanitasi dan dibatasi 60 event.
- Rekonsiliasi dipicu manual agar hot reload tidak menggandakan interval polling.

`JsonPaymentStore` hanya aman untuk satu proses development. Ia bukan contoh persistence production dan tidak menyediakan lock atau atomic uniqueness lintas proses.

Dokumentasi alur lengkap dan boundary keamanan tersedia di [`web/README.md`](web/README.md).
