# Panduan Kontribusi

Terima kasih sudah berkontribusi ke MerchantId.

MerchantId membaca akun merchant dan mencocokkan uang sungguhan ke pesanan. Ambang ketelitiannya lebih tinggi dari proyek biasa: kegagalan bukan hanya tampilan rusak, tetapi pembayaran sah dapat tidak terdeteksi atau dikaitkan ke pesanan yang salah.

## Menyiapkan lingkungan

```bash
git clone https://github.com/alhifnywahid/merchantid.git
cd merchantid
npm install
```

Library membutuhkan Node.js 18 atau lebih baru. Lint memakai ESLint 10 dan membutuhkan Node.js 20.19+ atau versi yang lebih baru sesuai engine ESLint.

Empat quality gate berikut sama dengan CI:

```bash
npm run typecheck   # tsc --noEmit untuk src/ dan test/
npm run lint        # eslint src/**/*.ts
npm test            # vitest run
npm run build       # tsup menghasilkan ESM, CJS, dan declaration
```

Lingkungan maintainer utama adalah Windows dengan PowerShell. Gunakan `;` sebagai pemisah command, bukan `&&`.

## Development lab lokal

`.example/web` adalah utility TanStack Start multi-provider yang mengambil package root melalui `merchantid: file:../..`, bukan registry npm. Gunakan lab untuk menguji login, sesi, discovery, scope, QRIS, payment, cancel, dan rekonsiliasi terhadap build lokal.

```powershell
npm run build
Set-Location .example/web
npm install
npm run dev
```

Lab selalu memakai API live dan dapat mengirim OTP serta request provider nyata. Gunakan hanya akun merchant milik sendiri.

`npm run dev` adalah proses panjang. Jalankan sendiri di terminal terpisah. Jangan memasukkan `.example/web/data/` ke commit karena dapat memuat sesi, cookie, token, QRIS, dan payment record. Browser hanya boleh menerima DTO tersunting; credential, challenge, provider instance, dan QRIS statis tetap di server.

Schema state v2 mereset state dan payment lama yang tidak kompatibel. Store JSON tetap hanya untuk satu proses; jangan menyalinnya sebagai pola persistence production. Rekonsiliasi tetap manual agar hot reload tidak menggandakan interval polling.

Regression test website dijalankan terpisah dengan `Set-Location .example/web; npm test`; test memakai direktori data sementara, tidak membaca state development lokal, dan tidak melakukan request provider live.

## Melaporkan bug

Sertakan:

- Provider, langkah reproduksi, dan hasil yang diharapkan
- Versi `merchantid`, Node.js, dan runtime
- Pesan error lengkap beserta `code`
- Scope provider/account/merchant-store yang sudah disunting
- Bentuk transaksi yang sudah disunting bila masalah terkait normalisasi atau rekonsiliasi

Jangan sertakan access token, refresh token, cookie, OTP, challenge OTP, QRIS asli, atau isi `~/.merchantid/config.json`. Gunakan `merchantid session <provider>` tanpa `--reveal` untuk keluaran yang dimask.

## Mengajukan provider atau fitur

Buat issue yang menjelaskan masalah dan bukti API yang tersedia. Endpoint provider bersifat privat, sehingga desain tidak boleh didasarkan pada tebakan yang tidak dapat diverifikasi.

Untuk provider baru, jelaskan setidaknya:

- Cara autentikasi dan cara memulihkan sesi
- Identitas account, merchant, outlet, atau store yang membentuk scope
- Pagination feed, batas page, cursor, dan kondisi selesai
- Satuan serta format nominal mentah
- Status transaksi yang benar-benar terbukti sukses
- Asal QRIS statis
- Perilaku saat sesi kedaluwarsa, CAPTCHA, atau verifikasi tambahan

Jangan mengusulkan bypass CAPTCHA, fingerprint evasion, atau otomasi yang melanggar kontrol akses provider.

## Menambahkan provider

Adapter baru berada di `src/providers/<provider-id>/`. Gunakan batas berikut:

1. Implementasikan `MerchantProvider<TSession>` untuk identitas, status sesi, scope, dan ekspor sesi.
2. Implementasikan `TransactionFeed` bila provider memiliki feed native. Adapter bertanggung jawab atas pagination, filter, deduplikasi, status, waktu, serta normalisasi nominal ke rupiah utuh.
3. Gunakan `PaymentScope` lengkap. Masukkan account id bila tersedia dan gunakan merchant/outlet/store yang benar-benar memiliki feed serta QRIS.
4. Pakai `PaymentService` dan `PaymentStore` bersama. Jangan menyalin matcher atau alokator ke folder provider.
5. Biarkan alur autentikasi provider-specific. `MerchantId` adalah registry, bukan facade login universal.
6. Ekspor API publik melalui `src/index.ts` dan `src/providers/<provider-id>/index.ts`.
7. Jangan menambahkan dependency runtime. Gunakan `fetch` global dan primitive Web API.

Pagination provider tidak boleh dipaksa ke model provider lain. GoPay memakai offset dan Shopee memakai cursor `next_position`; keduanya bertemu di `TransactionFeedResult`, bukan pada wire query yang sama.

## PaymentScope dan store persisten

Pembayaran harus diisolasi dengan kombinasi:

```text
provider + accountId (bila ada) + merchantId/storeId
```

Implementasi `PaymentStore.listActive(scope?)` wajib memfilter scope ketika diberikan. Store multi-process juga wajib menegakkan keunikan `uniqueAmount` untuk pembayaran pending dalam scope yang sama secara atomik. Filter defensif di `PaymentService` bukan pengganti constraint database.

Mode tanpa scope hanya boleh membaca record unscoped. Service scoped fail-fast bila menemukan payment aktif tanpa `PaymentScope`, karena owner feed record itu ambigu. Jangan campurkan record unscoped ke rekonsiliasi provider.

QRIS manual provider multi-store harus menyimpan metadata owner. Shopee memakai `staticQrisScope` berisi business merchant dan store. `selectStore()` wajib menolak perpindahan ketika scope lama masih memiliki payment aktif, tidak boleh meneruskan QRIS store lama, dan harus mempertahankan service per scope agar karantina nominal serta consumed transaction id tidak hilang. Discovery seperti `listStores()` tidak boleh mereset state rekonsiliasi.

Jangan menghapus `payment.scope` ketika melakukan serialisasi. Record tanpa scope hanya boleh dipakai oleh `PaymentService` yang memang dikonfigurasi tanpa scope.

## Pull request

1. Fork dan buat branch, misalnya `git checkout -b feat/provider-baru`.
2. Kerjakan satu concern dengan perubahan sekecil yang tetap lengkap.
3. Tambahkan atau perbarui test yang membuktikan perilaku yang berubah.
4. Perbarui README bila permukaan API, konfigurasi, CLI, provider, atau perilaku pembayaran berubah.
5. Jalankan typecheck, lint, test, dan build.
6. Jelaskan alasan, bukti provider, risiko, serta jalur migrasi di pull request.

Untuk bug, test terbaik gagal saat perbaikannya dibalik. Perubahan pada matching, status sukses, normalisasi nominal, scope, atau expiry wajib mengunci jalur diterima dan ditolak.

## Code style

- TypeScript strict dengan `noUncheckedIndexedAccess`, `noUnusedLocals`, dan `noUnusedParameters`.
- Hindari `any`. Jika benar-benar tidak terhindarkan, sertakan `eslint-disable` lokal beserta alasannya.
- Jangan melonggarkan lint agar kode lolos.
- Komentar dan JSDoc source ditulis dalam bahasa Inggris.
- Komentar menjelaskan alasan, bukan mengulang kode.
- Impor relatif memakai ekstensi `.js`, walaupun sumbernya `.ts`.
- Impor tipe memakai `import type`.
- Gunakan `Logger`, bukan `console`, di luar CLI dan implementasi console logger.
- Error yang disurface-kan harus merupakan turunan `MerchantIdError` dan memakai code bertipe `MerchantIdErrorCode`.

## Batas arsitektur

- `src/core/` tidak boleh mengimpor dari provider, API, HTTP, payment, atau CLI.
- Bila lapisan dalam membutuhkan capability luar, deklarasikan interface sempit di `core/`.
- `src/index.ts` hanya menyusun ekspor dan tidak boleh mengimpor Node builtin.
- Node builtin hanya boleh dipakai pada CLI dan playground lokal, bukan jalur library publik.
- `PaymentService` menerima transaksi provider-neutral dalam rupiah utuh.
- Adapter memiliki aturan wire, autentikasi, pagination, dan normalisasinya sendiri.
- `MerchantId` hanya mengelola registry provider dan tidak boleh menampung cabang auth GoPay/Shopee.

## Testing

Test berada di `test/`, dijalankan dengan Vitest, dan dikelompokkan berdasarkan level serta domain:

```text
test/
  unit/
    core/
    payment/
    qris/
    providers/{gopay,shopee}/
  integration/
    merchantid/
    cli/
  contract/              public API dan package metadata
  fixtures/              data sintetis buatan tangan
  helpers/               stub transport dan helper deterministik
```

Gunakan unit test untuk invariant kecil, integration test untuk lifecycle lintas komponen, dan contract test untuk permukaan package. Fixture tidak boleh berasal dari HAR atau payload akun nyata. Nilai test ditentukan oleh risiko yang dikunci, bukan persentase coverage.

Area penting:

- Alokasi nominal akhir unik, termasuk konkurensi dan karantina
- Satu transaksi paling banyak melunasi satu pembayaran, termasuk lintas tick
- Scope mencegah rekonsiliasi silang provider, account, merchant, dan store
- Expiry tidak mendahului jendela matcher
- GoPay membagi minor unit tepat 100 dan meng-clamp page size ke 100
- GoPay refresh mengirim `refresh_token` di dalam `data`, tanpa bearer aktif
- Shopee hanya menerima status `3` sebagai selesai
- Shopee parsing nominal menerima `30.000` sebagai `30000` dan menolak bentuk ambigu
- Cursor Shopee berhenti, maju, mendeteksi loop, dan melaporkan truncation
- CAPTCHA menghasilkan `CAPTCHA_REQUIRED` tanpa percobaan bypass
- Session export tidak mencetak token atau cookie

Utamakan implementasi asli dan stub interface kecil. `TokenRefresher`, `TransactionLister`, `TransactionFeed`, `PaymentStore`, dan injectable `fetch` tersedia agar test tidak membutuhkan framework mocking berat.

## Format commit message

Gunakan awalan singkat:

```text
fix: normalisasi nominal feed Shopee
feat: tambahkan provider merchant baru
docs: jelaskan scope store pada PaymentStore
test: kunci status sukses provider
refactor: pindahkan pagination ke adapter provider
ci: gunakan trusted publishing tanpa token
```

Badan commit menjelaskan alasan dan risiko. Jangan commit, tag, publish, atau membuat release kecuali memang bagian dari alur yang diminta maintainer.

## Keamanan dan rilis

Laporkan celah keamanan secara privat, bukan melalui issue publik.

Publish npm berjalan otomatis lewat npm Trusted Publishing (OIDC), dipicu oleh **tag versi** yang di-push. Jangan menjalankan `npm publish` lokal dan jangan menambahkan `NODE_AUTH_TOKEN` atau secret npm ke workflow.

Alur rilis (dari branch default yang bersih dan hijau):

```bash
npm version patch   # atau minor / major - bump package.json, commit, buat tag vX.Y.Z
git push --follow-tags
```

Push tag `v*` menjalankan `.github/workflows/publish.yml`: ia memverifikasi tag cocok dengan `package.json`, menjalankan typecheck/lint/format/test/build, `npm publish --provenance`, lalu membuat GitHub Release berisi catatan otomatis. Release baru muncul **setelah** publish sukses, jadi keberadaan Release menandakan versi benar-benar live di npm. Pilih bump sesuai [SemVer](https://semver.org): `patch` untuk perbaikan, `minor` untuk fitur kompatibel, `major` untuk perubahan yang memutus kompatibilitas. Selama versi masih `0.x`, API publik belum stabil: breaking change memakai `minor` (bukan `major`) dan wajib dicatat di `CHANGELOG.md` di bawah **Changed** atau **Removed** beserta migrasinya.

### Menulis catatan rilis

`CHANGELOG.md` adalah sumber kebenaran; catatan pada halaman GitHub Release adalah cerminannya. Untuk rilis yang berarti, tulis catatan tangan (bukan hanya catatan otomatis CI):

- **Judul Release berupa kalimat**, bukan sekadar nomor - mis. `refactor: rename to merchantid, drop manual cookie login`. Nomor versi sudah tampil dari tag.
- **Kelompokkan dengan heading tetap**, urutan: Breaking → Features → Fixes → Improvements → Docs. Lewati yang kosong.
- **Tiap butir satu kalimat**: `area: aksi + alasan`, sertakan `#nnn` bila ada issue/PR.
- **Catatan rilis menggambarkan kondisi versi itu, bukan kondisi terkini.** Jangan menulis ulang Release lama seakan memakai nama atau fitur sekarang; untuk mengarahkan pembaca, tambahkan satu baris pengantar yang menunjuk versi baru tanpa mengubah isi historisnya.

## Lisensi

Dengan berkontribusi, Anda setuju kontribusi dilisensikan di bawah [MIT License](LICENSE).
