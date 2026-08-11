# MerchantId Console

Contoh **produksi** yang memakai package `merchantid` asli (`file:../..`) untuk
menjalankan kasir QRIS GoPay dan ShopeePay. Dibangun dengan **TanStack Start**
(full-stack, SSR) + **shadcn/ui** yang di-token ulang ke design system
**Tokokino** (lihat `../development/web/design.md`).

Berbeda dari `../development/web` yang berupa lab satu halaman, konsol ini
adalah dua permukaan kerja:

- **Kasir** (`/`) - login provider → pilih outlet/store → input nominal →
  tampilan QRIS besar dengan hitung mundur → cek status.
- **Riwayat** (`/riwayat`) - ledger pembayaran per-scope + rekonsiliasi +
  catatan aktivitas server.

## Menjalankan

```bash
# dari root repo, pastikan package sudah dibuild lebih dulu:
npm run build          # menghasilkan ../../dist

cd .example/production
npm install
npm run dev            # http://127.0.0.1:5180
```

## Keamanan (penting)

Server function menggerakkan API provider **nyata tanpa autentikasi sendiri**,
jadi dev server dikunci ke **loopback (`127.0.0.1`)**. Di LAN, `requestOtp`
akan menjadi relay OTP terbuka dari akun merchant operator ke nomor mana pun.

- `data/`, `*session*.json`, `console-state.json`, `payments.json`, dan
  `.flow/` di-gitignore - kredensial provider tidak pernah masuk git.
- Semua pesan error digosok lewat `redactSensitiveText` sebelum sampai ke DOM.
- Menghapus file kredensial **tidak** mencabut sesi di sisi server - putar
  ulang (rotate) kredensial bila perlu.

## Struktur

```
src/
  routes/            # __root, index (kasir), riwayat
  components/        # app-shell + panel (login, session, qris, amount, ledger, activity)
  components/ui/     # shadcn di-token Tokokino
  server/            # console.server (runtime), functions (createServerFn), storage.server
  lib/               # types, console-store (client state), format, utils
```
