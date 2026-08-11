# AGENTS.md

Briefing untuk agent AI yang mengerjakan repo ini. Baca sebelum menyentuh kode.

`README.md` menjelaskan cara memakai library, dan `CONTRIBUTING.md` menjelaskan alur kontribusi serta code style. Berkas ini mencatat perintah, batasan keras, jebakan domain, dan keputusan yang mahal bila ditemukan ulang.

Instruksi langsung pengguna di percakapan selalu mengalahkan berkas ini.

---

## 1. Orientasi

`MerchantID` adalah toolkit payment-provider **tidak resmi** untuk merchant Indonesia. Implementasi saat ini mendukung:

- **GoPay Merchant / GoBiz**: OTP GoID, refresh token, discovery merchant/outlet/QRIS, dan feed transaksi offset-based.
- **Shopee Merchant / ShopeePay**: OTP fetch-only, cookie/session persistence, discovery merchant/store, dan feed transaksi cursor-based. QRIS statis diberikan manual.

Dua pekerjaan domain bersama:

1. Mengubah QRIS statis merchant menjadi QRIS dinamis per pesanan dengan menyuntikkan nominal ke tag EMV.
2. Mendeteksi settlement dari feed provider dan mencocokkannya ke pesanan berdasarkan nominal unik, waktu, status, dan `PaymentScope`.

API privat provider tidak memberi order reference milik aplikasi. Nominal tetap menjadi pembeda utama. Setiap pembayaran baru juga membawa scope provider/account/merchant-store agar transaksi satu provider atau store tidak pernah melunasi pembayaran lain.

`MerchantID` adalah registry/composition root. Ia tidak memaksakan login universal. Auth, session, merchant/store discovery, pagination, dan normalisasi tetap dimiliki adapter provider.

`GopayProvider` dan `ShopeeProvider` adalah adapter konkret yang diekspor package. API publik hanya mengekspor nama kanonis MerchantID dan adapter provider.

**Library ini memindahkan uang sungguhan di akun merchant orang lain.** Bug rekonsiliasi dapat membuat pembeli sudah membayar tetapi pesanan tidak terkirim, atau pesanan lain terkirim. Ambang ketelitiannya lebih tinggi dari proyek biasa.

Lingkungan pengguna adalah **Windows + PowerShell**. Pisahkan perintah dengan `;`, bukan `&&`.

---

## 2. Perintah

Empat quality gate berikut harus lolos:

```bash
npm run typecheck   # tsc --noEmit untuk src/ DAN test/
npm run lint        # eslint src/**/*.ts
npm test            # vitest run
npm run build       # tsup: index, satu CLI, ESM/CJS/d.ts
```

Development lab multi-provider memakai package root lewat `merchantid: file:../..`, bukan registry npm:

```powershell
npm run build
Set-Location .example/development/web
npm install
npm run dev
```

`.example/development/web` adalah utility TanStack Start + Tailwind live-only dengan satu halaman dan tab GoPay/Shopee, ter-link ke root repo lewat `merchantid: file:../../..`. `.example/production` adalah konsol dua-route (kasir + riwayat) yang mengonsumsi paket `merchantid` terpublikasi dari npm. Pengiriman OTP, discovery, refresh sesi, dan rekonsiliasi dapat mengirim request provider nyata; gunakan hanya akun merchant milik sendiri. Login provider satu-satunya lewat OTP (GoPay: nomor→OTP; Shopee: nomor+password→OTP), tidak ada jalur paste cookie. Session, token, cookie, OTP challenge, provider instance, dan static QRIS harus tetap di modul server; client hanya menerima DTO tersunting serta SVG QR hasil render.

State runtime schema v2 berada di `.example/*/data/` dan diabaikan Git. State atau payment schema lama dihapus saat migrasi agar tidak dianggap sebagai data live. `JsonPaymentStore` hanya untuk satu proses development, bukan store production. Rekonsiliasi sengaja manual agar hot reload tidak menggandakan polling interval.

Quality gate website dijalankan setelah root package dibuild dan dependency lokal terpasang:

```powershell
Set-Location .example/development/web
npm run typecheck
npm test
npm run build
```

Jangan jalankan `npm run dev` sebagai validasi otomatis karena prosesnya tidak berhenti sendiri.

CLI source:

```bash
npx tsx src/cli.ts login gopay
npx tsx src/cli.ts login shopee
npx tsx src/cli.ts session gopay
npx tsx src/cli.ts session shopee --reveal
npx tsx src/cli.ts merchants gopay
npx tsx src/cli.ts stores shopee
npx tsx src/cli.ts set-provider shopee
npx tsx src/cli.ts set-merchant <merchantId> --provider gopay
npx tsx src/cli.ts set-store <storeId>
npx tsx src/cli.ts set-qris shopee
npx tsx src/cli.ts whoami
```

Build menghasilkan satu binary:

- `merchantid` -> `dist/cli.cjs`, CLI multi-provider.

Config default adalah `~/.merchantid/config.json`, dengan env `MERCHANTID_CONFIG`. Schema aktif:

```jsonc
{
  "version": 1,
  "defaultProvider": "gopay",
  "providers": {
    "gopay": { "session": {}, "merchants": [], "defaultMerchantId": "..." },
    "shopee": { "session": {}, "staticQris": "..." },
  },
}
```

Set `MERCHANTID_DEBUG` untuk diagnostik umum. Debug tidak boleh mencetak token, cookie, OTP, atau QRIS.

**Jangan jalankan proses yang tidak berhenti sendiri** seperti `npm run dev`, `npm run test:watch`, monitor, atau `tsup --watch`. Berikan command agar pengguna menjalankannya sendiri di terminal.

---

## 3. Aturan yang tidak bisa dinegosiasi

1. **Nol dependency runtime.** `dependencies` di root `package.json` harus kosong/tidak ada. Pakai `fetch` global dan primitive Web API.
2. **API library bebas Node builtin.** Modul yang memakai `node:fs`, `node:os`, atau `node:path` hanya boleh menjadi implementasi CLI di `src/cli/`. Entry `src/cli.ts` hanya mendelegasikan.
3. **Dependency mengarah ke dalam.** `src/core/` tidak boleh mengimpor provider, `api/`, `http/`, `payment/`, atau CLI.
4. **Jangan melonggarkan lint.** Perbaiki kode.
5. **Jangan pernah menulis token, cookie, OTP, challenge, QRIS asli, atau credential ke log, error, fixture, contoh, maupun diff.**
6. **Jangan publish npm manual.** Lihat bagian 9.
7. **Jangan mengubah matching nominal, status sukses, expiry, atau scope tanpa test yang membuktikan perilaku diterima dan ditolak.**
8. **Jangan mengarang endpoint atau refresh flow.** Provider privat harus berdasarkan bukti yang diamati.
9. **Jangan bypass CAPTCHA.** Surface `CAPTCHA_REQUIRED` dan berhenti.
10. **Jangan commit HAR.** `.flow/`, `flow.har`, `flow2.har`, dan semua `*.har` diabaikan karena dapat memuat PII dan credential.

---

## 4. Batas arsitektur

```text
src/index.ts                              permukaan API publik, re-export saja
src/merchantid.ts                            provider registry/composition root
src/core/provider.ts                      MerchantProvider, TransactionFeed, scope helpers
src/core/types.ts                         domain types, PaymentScope, ports/store
src/core/errors.ts                        hierarchy MerchantIdError
src/payment/                              PaymentService, allocator, matcher, store
src/qris/                                 parser dan builder EMV/TLV
src/providers/gopay/gopayProvider.ts      facade provider GoPay
src/providers/shopee/shopeeProvider.ts    facade provider Shopee
src/api/ + src/auth/ + src/http/          implementasi wire GoPay berbasis fetch
src/utils/                                crc16, id, logger, time
src/cli/ + src/cli.ts                     CLI multi-provider, satu-satunya area Node builtin
```

### 4.1 Dependency Rule

Bila lapisan dalam membutuhkan sesuatu dari luar, deklarasikan interface di `core/`, lalu biarkan adapter luar memenuhinya. Port yang ada:

- `TokenRefresher`: dipenuhi `AuthClient` GoPay.
- `TransactionLister`: port feed offset GoPay.
- `TransactionFeed`: port normalisasi/pagination provider-neutral.
- `MerchantProvider<TSession>`: permukaan kecil registry.
- `PaymentStore`: persistence dengan filter `PaymentScope`.

`PaymentService` boleh menerima `TransactionLister` untuk feed offset GoPay atau `TransactionFeed` untuk adapter yang memiliki pagination sendiri. Jangan memasukkan cursor Shopee ke interface GoPay atau offset GoPay ke adapter Shopee.

### 4.2 Tanggung jawab provider

Setiap provider memiliki:

- Auth dan session type sendiri.
- Discovery account, merchant, outlet, atau store sendiri.
- Pagination dan query wire sendiri.
- Normalisasi status, waktu, id, dan nominal ke `MerchantTransaction` dalam rupiah utuh.
- `PaymentScope` yang mengidentifikasi pemilik feed dan QRIS.

Core tidak boleh mengetahui `next_position`, cookie Shopee, GoID grant, atau payload GoBiz.

### 4.3 PaymentStore

`InMemoryPaymentStore` hanya untuk satu proses dan test. Deployment multi-process/multi-isolate wajib menyediakan store tahan lama yang:

- Menyimpan `payment.scope` tanpa menghapus field.
- Memfilter `listActive(scope)` secara benar.
- Menegakkan keunikan nominal aktif per scope secara atomik.
- Mencegah transisi terminal ditimpa proses lain.
- Menyimpan klaim transaksi atau jaminan ekuivalen bila proses dapat restart.

`PaymentService` memfilter scope lagi untuk pertahanan terhadap store lama. Itu bukan pengganti constraint database.

---

## 5. Jebakan domain bersama

### 5.1 Keunikan berlaku pada nominal akhir dalam scope

`AmountAllocator` menegakkan keunikan pada `baseAmount + offset`, bukan offset saja. `3500 + 1` dan `3499 + 2` sama-sama `3501`. Karena nominal adalah pembeda utama, keduanya tidak boleh aktif pada scope yang sama.

Scope lengkap adalah:

```text
provider + accountId (bila ada) + merchantId/outlet/store
```

Jangan memakai store global tanpa scope. Itu memungkinkan transaksi GoPay melunasi Shopee atau transaksi satu store Shopee melunasi store lain.

Default jendela offset adalah `DEFAULT_MAX_UNIQUE_OFFSET` (999). Slot terkecil dipilih lebih dulu.

### 5.2 Karantina nominal dan transaksi terkonsumsi

Ketika pembayaran meninggalkan himpunan aktif, nominalnya dikarantina selama `2 x clockSkewMs`. Tanpa karantina, pesanan baru dengan harga sama dapat langsung menerima nominal bekas sementara transaksi lamanya masih berada di jendela matcher, sehingga satu transfer melunasi dua pesanan.

`reconcile` memastikan satu transaksi dipakai paling banyak sekali dalam satu call. `PaymentService` mengingat id transaksi yang sudah dipakai lintas tick sampai rolling lookback 24 jam tidak mungkin mengembalikannya lagi.

Kedua penjagaan hidup di memori proses. Restart dan deployment multi-process memerlukan jaminan persistence pada store.

### 5.3 Matcher sengaja fail-open untuk data tidak dikenal

`matchesPayment` menolak status gagal yang dikenal, tetapi menerima status kosong/tidak dikenal. Timestamp yang tidak dapat diparse juga jatuh ke nominal dan status saja. Ini keputusan sadar untuk feed privat yang dapat berubah.

Fail-closed dapat membuat pembayaran sah tidak pernah terdeteksi. Melonggarkan status gagal dapat mengirim pesanan tanpa pembayaran sukses. Jangan ubah tanpa test dua arah.

### 5.4 Jendela pencarian bergulir

`DEFAULT_TRANSACTION_LOOKBACK_MS` adalah 24 jam bergulir, bukan hari kalender. Awal scan dipersempit ke pembayaran aktif tertua dikurangi `clockSkewMs`, dengan 24 jam sebagai plafon. Ini menghindari lubang timezone dan menjaga transaksi relevan tetap terjangkau pagination.

### 5.5 Reconcile sebelum expire

Default expiry adalah 5 menit dan sering terlalu pendek untuk scheduler lambat. Feed dapat terlambat mengindeks.

Dua invariant dikunci test:

- Matching berjalan sebelum expiry pada setiap tick.
- Expiry baru terjadi setelah `expiresAt + clockSkewMs`, persis saat matcher berhenti menerima transaksi.

Jangan membuat expiry menyerah sebelum matcher. Pembeli dapat sudah membayar tetapi pesanannya tidak pernah lunas.

### 5.6 Semua transisi memakai satu antrean tulis

`createPayment`, settle, cancel, dan expire diserialkan dalam satu proses. `cancelPayment` yang balapan dengan settlement tidak boleh menimpa status `paid`. Listener yang melempar tidak boleh membatalkan accounting tick yang sudah tersimpan.

Ini tetap bukan lock lintas proses. Store production harus menyediakan atomicity sendiri.

---

## 6. Jebakan GoPay

### 6.1 Feed memakai satuan minor

`merchant-analytics/v2` melaporkan uang dalam minor unit ISO 4217. Rp 3.001 datang sebagai `gross_amount: 300100`. QRIS, allocator, dan `Payment.uniqueAmount` memakai rupiah utuh.

`TransactionClient` membagi dengan `TRANSACTION_AMOUNT_SCALE` (100) secara eksak. Nilai bukan rupiah utuh tetap pecahan dan gagal cocok dengan aman.

**Jangan menerima kedua skala di matcher.** Transaksi Rp 300.100 dapat melunasi pesanan Rp 3.001.

### 6.2 Feed menolak `size` di atas 100

Endpoint menjawab HTTP 422 untuk `size > 100`. `MAX_TRANSACTION_PAGE_SIZE` menjaga limit. Permintaan di-clamp, bukan menggagalkan polling.

Halaman penuh memicu pagination sampai `MAX_TRANSACTION_PAGES_PER_TICK` (10). Page size juga di-clamp di `PaymentService`, bukan hanya client. Jika hanya client yang mengecilkan halaman, langkah `from` service akan melompati baris.

Mencapai cap dicatat ke log. Untuk outlet lebih sibuk, pendekkan expiry, jangan membesarkan page size.

### 6.3 Refresh token wajib tersarang di `data`

Endpoint `/goid/token` menerima:

```jsonc
{
  "client_id": "...",
  "data": { "refresh_token": "..." },
  "grant_type": "refresh_token",
}
```

Bentuk flat ditolak `401` generik dan terlihat seperti token kedaluwarsa. Bug ini pernah membuat semua refresh gagal.

Konsekuensi yang tidak boleh diubah tanpa bukti baru:

- Bearer request refresh sengaja kosong. Refresh setelah `401` tidak boleh bergantung pada access token yang sudah ditolak.
- Server mengembalikan refresh token baru. Adopsi dan persist nilai baru; jangan pin token lama.
- Respons dapat tidak memiliki `expires_in`/`token_type`. Access token berupa JWE lima segmen, sehingga `exp` tidak dapat dibaca. `TokenManager` memakai fallback 30 menit sebagai perkiraan konservatif.
- Dashboard resmi tidak menukar refresh token; ia bukan referensi untuk flow ini.

### 6.4 Sesi GoPay bisa dicabut

Login dari perangkat lain dapat membatalkan sesi. Polling harus surface `AuthError` `AUTH_FAILED`, bukan menyamarkannya sebagai belum dibayar. Header dan client identity default berada di `core/constants.ts` dan dapat dioverride bila Gojek merotasinya.

### 6.5 Outlet dan QRIS

Akun dapat memiliki beberapa merchant dan outlet. QRIS berasal dari `pops[].gopay.aspi_qr_string`. Jangan menganggap merchant pertama atau outlet pertama selalu benar. Scope GoPay memakai account bila tersedia dan merchant/outlet yang benar-benar dipolling oleh facade.

---

## 7. Jebakan Shopee

### 7.1 Nominal adalah string Indonesia

Feed yang diamati mengirim nominal seperti `"30.000"`. `parseShopeeAmount` hanya menerima:

- Digit polos, misalnya `"30000"`.
- Kelompok ribuan Indonesia yang valid, misalnya `"30.000"` atau `"1.250.000"`.

Parser menolak bentuk ambigu seperti `"30.00"`, desimal, simbol mata uang, whitespace internal, bilangan negatif, dan nilai di luar safe integer. Jangan memakai `parseFloat`; `parseFloat("30.000")` menghasilkan 30 dan dapat melunasi pesanan salah.

### 7.2 Hanya status `3` yang sukses

Bukti yang diamati hanya menetapkan `SHOPEE_COMPLETED_TRANSACTION_STATUS = 3`. Adapter menormalisasi status itu menjadi `completed`. Semua status lain menjadi `shopee:<kode>`, yaitu label non-sukses yang ditolak matcher.

Jangan menebak status sukses lain. Tambahkan hanya setelah ada bukti payload dan test.

### 7.3 Cursor dimiliki adapter

Shopee memakai `next_position`, bukan offset. `ShopeeTransactionFeed`:

- Mengirim cursor halaman berikutnya.
- Mendeduplikasi transaction id.
- Menolak row malformed atau di luar merchant/store scope.
- Mendeteksi cursor yang tidak maju atau berulang.
- Mengembalikan `truncated: true` bila `maxPages` tercapai sebelum cursor habis.

Jangan memindahkan cursor ke `PaymentService`. `TransactionFeed` sengaja membiarkan provider memiliki pagination.

### 7.4 Scope Shopee adalah merchant bisnis + store

`PaymentScope` Shopee:

```ts
{
  provider: "shopee",
  accountId: session.merchant.id,
  merchantId: session.storeId,
}
```

`accountId` adalah business merchant. `merchantId` pada core dipakai untuk store yang memiliki transaksi. Merchant-only scope tidak cukup karena satu merchant dapat memiliki beberapa store.

### 7.5 Auth fetch-only dan sesi cookie

Alur:

1. `requestOtp(phone)` menghasilkan `ShopeeOtpChallenge` dengan cookie dan device fingerprint.
2. `verifyOtp({ challenge, otp })` menghasilkan verification state dan daftar merchant.
3. `completeLogin({ verification, merchantId, storeId? })` menukar redirect/token, membaca merchant credential dari cookie/JWT, lalu mengambil profile dan seluruh store.
4. Bila store belum terpilih, panggil `selectStore` sebelum payment/feed.

Challenge, verification, dan session sensitif. Cookie jar murni harus mempertahankan domain, path, secure, expiry, dan `Set-Cookie` tanpa dependency runtime. Jangan log cookie atau JWT.

### 7.6 Refresh Shopee: hanya lewat sesi akun yang masih hidup

Jangan menambahkan `offlineToken` atau endpoint refresh berdasarkan tebakan. Yang terverifikasi hanya satu jalur: `POST /api/v4/account/business/login_status` menjawab `error:0` selama cookie akun (`SPC_*`) masih diterima, dan `48500102` ("not login") setelah tidak. Selama hidup, token merchant dicetak ulang dengan mengulang pertukaran SSO login (`login_toc` → `/account/login/tob/auth`) untuk merchant aktif — persis mekanisme `selectMerchant`, hanya targetnya diri sendiri. Itulah `ShopeeProvider.refreshSession()`.

Dua jebakan yang harus dipatuhi:

- `exp` pada cookie dashboard berumur ~1000 hari dan **tidak** mencerminkan sesi server. Jangan pernah memakainya untuk menyimpulkan sesi masih valid; `authenticated` hanya pemeriksaan struktural.
- Token **berotasi** setiap pembaruan, jadi hasilnya wajib dipersist lewat `onSessionUpdated`. Tanpa itu pemanggil menyimpan token basi.

Bila sesi akun sudah mati, satu-satunya pemulihan adalah login OTP baru: lempar `AUTH_REQUIRED` dan katakan itu, jangan mencoba retry diam-diam.

`SwitchMerchant` **tidak** dipakai: token yang dikembalikannya ditolak dashboard API (`200020`) di luar browser sungguhan, terbukti lewat pengujian langsung terhadap timing, nonce, cookie, dan reload. Jangan menghidupkannya kembali.

### 7.7 CAPTCHA tidak dibypass

Bila provider meminta CAPTCHA, lempar `CaptchaRequiredError` dengan code `CAPTCHA_REQUIRED`. Jangan retry agresif, mengubah fingerprint untuk menghindari challenge, atau mengimplementasikan solver. Pengguna harus menyelesaikan verifikasi lewat flow resmi.

### 7.8 QRIS Shopee diberikan manual

Dashboard API yang diamati tidak menyediakan QRIS statis. `ShopeeProviderConfig.staticQris` harus diisi pengguna atau disimpan lewat `merchantid set-qris shopee`. Jangan membuat endpoint discovery yang tidak terbukti.

QRIS wajib mempunyai `staticQrisScope` berisi business merchant dan store pemilik. Constructor boleh menginfer owner hanya dari restored session/store yang sudah dipilih; flow login baru sebaiknya memanggil `setStaticQris()` setelah store dipilih. CLI menyimpan owner bersama payload. QRIS tidak boleh dipakai bila owner berbeda dari scope aktif.

Validasi checksum dan jalankan `staticToDynamicQris` sebelum menyimpan. Jangan mencetak payload QRIS mentah di output diagnostik.

### 7.9 Pergantian scope dan record tanpa scope

`selectStore()` menolak perpindahan selama scope lama masih mempunyai payment pending. `ShopeeProvider` mempertahankan satu `PaymentService` per scope agar karantina nominal dan consumed transaction id tidak hilang. Semua auth, discovery store, dan pergantian store diserialkan: composition dinonaktifkan dan antrean write/polling dikuras sebelum cookie/session di-snapshot; target baru diaktifkan hanya setelah `onSessionUpdated` berhasil. Kegagalan HTTP, validasi, atau persistence wajib memulihkan cookie, session, status aktif, dan polling sebelumnya.

Reference `PaymentService` dari scope yang sudah ditinggalkan tetap ada tetapi inactive; `createPayment`, `cancelPayment`, `start`, dan `tick` harus ditolak sampai facade kembali ke scope itu. Jangan membuka lifecycle token provider ke caller. Saat kembali, gunakan service yang sama dan pulihkan polling hanya bila sebelumnya aktif. `listStores()` hanya discovery dan tidak boleh membuang composition. `loginWithOtp()` harus menjadi satu transaksi rollback, sedangkan callback `onSessionUpdated` tidak boleh memulai auth/store transition reentrant karena harus gagal cepat, bukan deadlock.

Mode `PaymentService` tanpa explicit scope hanya memproses payment tanpa `scope`. Mode scoped hanya memproses scope yang sama dan wajib fail-fast bila store memiliki payment aktif tanpa scope. Record tersebut ambigu dan tidak boleh diklaim oleh feed provider.

CLI hanya menerima schema config version 1. Kegagalan persistence pada command update harus selalu disurface-kan.

---

## 8. Konvensi kode

Aturan lengkap ada di [CONTRIBUTING.md](CONTRIBUTING.md). Ringkasan yang sering menjegal agent:

- Komentar dan JSDoc source dalam bahasa Inggris. README, CONTRIBUTING, dan AGENTS dalam bahasa Indonesia.
- Komentar menjelaskan **mengapa**, bukan mengulang kode.
- Impor relatif memakai ekstensi `.js` walaupun sumber `.ts`.
- Impor tipe wajib `import type`.
- `any` dilarang kecuali ada disable lokal dan alasan, seperti bivariance emitter yang sudah terdokumentasi.
- `console` dilarang di library. Gunakan `Logger`. Pengecualian hanya logger console dan CLI dengan disable yang ada.
- `eqeqeq`, `prefer-const`, dan `no-var` wajib.
- TypeScript strict dengan `noUncheckedIndexedAccess`, `noUnusedLocals`, dan `noUnusedParameters`.
- Semua error publik harus turunan `MerchantIdError` dengan code `MerchantIdErrorCode`.
- Ekspor publik hanya melalui `src/index.ts`. Sesuatu yang tidak diekspor di sana bukan API publik.
- Prefix log adalah `[merchantid]`.

---

## 9. Rilis npm

Publish otomatis lewat GitHub Actions dan npm Trusted Publishing (OIDC). Tidak ada token npm di repo atau secret. Trusted Publisher sudah terdaftar di npmjs.com untuk repo ini dan workflow `publish.yml`.

Pemicu rilis adalah **tag versi `v*` yang di-push**, bukan event GitHub Release. Alur dua perintah dari branch default yang bersih dan hijau:

```bash
npm version patch   # atau minor / major — bump package.json, commit, buat tag vX.Y.Z
git push --follow-tags
```

`.github/workflows/publish.yml` lalu: memverifikasi tag == `package.json`, typecheck → lint → format:check → test → build, `npm publish --provenance --access public`, dan **membuat GitHub Release dari dalam job itu** setelah publish sukses (dengan catatan otomatis).

Aturan:

- Jangan menjalankan `npm publish` lokal.
- **Jangan membuat GitHub Release secara manual atau memicu publish dari event `release`.** Release yang dibuat `GITHUB_TOKEN` tidak memicu workflow lain (recursion guard), jadi jalur itu akan menghasilkan Release yang tak pernah publish. Publish dan Release sengaja disatukan dalam satu job yang dipicu tag.
- Keberadaan GitHub Release = bukti versi sudah live di npm (Release dibuat hanya setelah publish sukses).
- Versi yang terbit lewat CI punya provenance (`slsa.dev/provenance/v1`); publish manual tidak. `0.1.0` publish manual (tanpa provenance); sejak `0.1.1` lewat CI (ada provenance).
- Workflow memakai Node 24 dan npm terbaru karena Trusted Publishing membutuhkan npm >= 11.5.1.
- `permissions.id-token: write` (OIDC) dan `contents: write` (buat Release) wajib.
- Jangan menambahkan `NODE_AUTH_TOKEN` atau `NPM_TOKEN`.
- Pilih bump sesuai SemVer: `patch` untuk perbaikan, `minor` untuk fitur kompatibel, `major` untuk breaking. Perubahan breaking harus disebutkan beserta migrasinya.
- Jangan membuat commit, tag, menaikkan version, push, atau publish tanpa permintaan eksplisit.

---

## 10. Git

- Branch utama `master`.
- Commit prefix: `fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `ci:`, `release:`.
- Badan commit menjelaskan alasan.
- Buat commit hanya bila diminta.
- Jalankan `git status --short` sebelum staging. Stage file spesifik, bukan `git add -A`.
- Jangan `push --force`, `reset --hard`, `clean -fd`, `branch -D`, mengubah git config, atau memakai flag interaktif tanpa izin.
- Jangan commit `~/.merchantid/config.json`, `.dev.vars`, `.example/*/data/`, `.flow/`, HAR, token, cookie, atau QRIS asli.

---

## 11. Checklist sebelum menyatakan selesai

Keluar tanpa error bukan bukti cukup.

- [ ] `npm run typecheck` lolos untuk src dan test.
- [ ] `npm run lint` bersih.
- [ ] `npm test` lolos.
- [ ] `npm run build` lolos.
- [ ] `node dist/cli.cjs help` bekerja bila CLI berubah.
- [ ] Root package tidak memiliki runtime dependency.
- [ ] Tidak ada Node builtin di luar CLI.
- [ ] Provider feed menormalisasi nominal ke rupiah utuh sebelum core.
- [ ] Scope lengkap disimpan dan dipakai saat rekonsiliasi.
- [ ] Perubahan bug/perilaku memiliki test yang gagal bila perbaikan dibalik.
- [ ] README diperbarui bila API, provider, CLI, config, atau behavior berubah.
- [ ] Package metadata, lockfile, dan example local dependency sinkron.
- [ ] `npm pack --dry-run` hanya memuat artefak yang diharapkan bila metadata berubah.
- [ ] `git status --short` hanya menampilkan file yang relevan.
- [ ] Diff tidak memuat token, cookie, OTP, nomor telepon, merchant id nyata, QRIS asli, atau PII.
- [ ] `.flow/shopee.har` dan semua HAR tetap ignored.

Laporkan apa yang benar-benar diverifikasi. Login live GoPay/Shopee, pengiriman OTP, dan settlement nyata tidak boleh diklaim berhasil bila tidak diuji dengan akun merchant.

---

## 12. Keputusan yang sudah diambil

Jangan buka ulang tanpa bukti baru.

| Keputusan                                                      | Alasan                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Package bernama `merchantid`                                   | Identitas singkat untuk toolkit merchant Indonesia                         |
| `GopayProvider` dan `ShopeeProvider` adalah nama kanonis       | Nama adapter konkret yang konsisten dengan arsitektur provider             |
| `MerchantIdError` adalah base error publik                     | Satu hierarchy error provider-neutral untuk seluruh adapter                |
| `MerchantId` hanya registry/composition root                   | Auth tiap provider berbeda dan tidak boleh menjadi monolith bercabang      |
| `TransactionFeed` provider-owned                               | Cursor Shopee dan offset GoPay tidak bocor ke payment core                 |
| `PaymentScope` provider/account/merchant-store                 | Mencegah settlement silang provider, account, dan store                    |
| `fetch` global dan nol dependency runtime                      | Node, Workers, Edge, Deno, dan Bun memakai package yang sama               |
| Nominal unik sebagai penanda pembayaran                        | Feed privat tidak membawa reference pesanan aplikasi                       |
| Keunikan pada nominal akhir                                    | Offset berbeda dapat menghasilkan nominal final sama                       |
| Karantina `2 x clockSkewMs` + consumed transaction lintas tick | Satu transfer lama tidak boleh melunasi pesanan baru                       |
| Reconcile sebelum expire, grace `clockSkewMs`                  | Jeda indexing feed tidak boleh membuat uang kehilangan pesanan             |
| Rolling lookback 24 jam dari payment aktif tertua              | Menghindari batas hari dan menjaga pagination terjangkau                   |
| GoPay membagi minor unit tepat 100                             | Nilai pecahan gagal cocok dengan aman                                      |
| GoPay page size di-clamp 100                                   | Limit API 422; halaman kecil masih berguna                                 |
| Matcher GoPay fail-open pada data tak dikenal                  | Feed privat bervariasi; melewatkan pembayaran sah lebih berbahaya          |
| GoPay refresh nested di `data`, bearer kosong                  | Bentuk endpoint yang terbukti dan recovery setelah `401`                   |
| Shopee status sukses hanya `3`                                 | Satu-satunya status selesai yang terbukti                                  |
| Shopee amount parser ketat                                     | `parseFloat("30.000")` menghasilkan nominal salah                          |
| Shopee scope merchant bisnis + store                           | Satu merchant dapat memiliki beberapa feed store                           |
| Shopee QRIS manual                                             | Tidak ada discovery endpoint pada flow yang diamati                        |
| Refresh Shopee hanya lewat `login_status` + ulang SSO          | Satu-satunya jalur terverifikasi; `SwitchMerchant` ditolak headless        |
| CAPTCHA menghasilkan `CAPTCHA_REQUIRED`                        | Kontrol provider harus dihormati, bukan dibypass                           |
| Semua status transition lewat antrean tulis                    | Cancel dan settlement tidak boleh saling menimpa                           |
| Interface di core, implementasi di luar                        | Dependency Rule dan test injection                                         |
| CLI config versioned dan provider-keyed                        | Credential provider tidak bercampur; hanya schema MerchantId yang diterima |
| Satu binary `merchantid`                                       | Satu entry CLI untuk seluruh provider                                      |
| Web dev lab (`.example/development/web`) memakai `merchantid: file:../../..` | Menguji build lokal (link ke root repo) sebelum publish tanpa registry npm  |
| Web produksi (`.example/production`) memakai `merchantid: 0.1.x` dari npm    | Menguji paket terpublikasi apa adanya, seperti konsumen sungguhan          |
| Web dev lab selalu live dan state schema v2                    | Menguji request provider nyata; state/payment lama direset dengan aman     |
| Credential web lab hanya di server dan `data/` gitignored      | Browser dan diff tidak boleh menerima material session atau QRIS mentah    |
| Trusted Publishing OIDC tanpa token                            | Tidak ada npm token yang dapat bocor atau perlu dirotasi                   |
