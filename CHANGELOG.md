# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x`, the public API is not yet stable: a minor bump may
contain breaking changes, and each one is listed under **Changed** or
**Removed** with the migration to apply.

## [Unreleased]

### Changed

- Shopee `loginWithOtp` no longer throws when the account can reach more than
  one business merchant. It now returns a `ShopeeLoginOutcome`: `complete` with
  the session when the merchant is unambiguous (a `merchantId` was supplied, or
  only one merchant is usable), or `merchant-selection-required` carrying the
  reusable `verification` and the accessible `merchants` so a caller can let a
  human pick and finish with `completeLogin` - no second OTP. Callers that read
  the returned session directly must switch on `outcome.status` first.

### Improved

- Shopee ambiguous-merchant and inaccessible-merchant errors now carry
  `availableMerchants: { id, name }[]` instead of `availableMerchantIds:
string[]`, so a caller can render a picker with merchant names rather than
  bare ids.

## [0.1.1] - 2026-08-11

Renamed the package to `merchantid` and removed the manual cookie login path in
favor of full OTP login. Publishing now runs on a pushed version tag through npm
Trusted Publishing (OIDC), so every release from 0.1.1 on carries build
provenance.

> **Migrating from 0.1.0:** the package was renamed from `merchid` to
> `merchantid`. Reinstall with `npm install merchantid` and change the CLI
> command from `merchid` to `merchantid`.

### Changed

- Renamed the package from `merchid` to `merchantid`, including the CLI binary.
- Publishing moved to npm Trusted Publishing (OIDC), triggered by a pushed
  `v*` tag; the GitHub Release is created in the same job after a successful
  publish, so a Release always means the version is live on npm.

### Removed

- Shopee manual cookie import (`importSession`). Shopee now authenticates only
  through the OTP flow (phone + password, code delivered via WhatsApp, SMS, or
  call). Pasting a browser session is no longer required or supported.

## [0.1.0] - 2026-08-09

First public release, published under the name `merchid`. MerchID turns a
merchant's static QRIS into a unique per-order dynamic QRIS and reconciles
settlement by polling the provider's own transaction feed - for GoPay Merchant
(GoBiz) and ShopeePay Merchant.

### Added

- Provider-neutral `MerchantId` facade with `GopayProvider` and `ShopeeProvider`
  adapters behind a shared `MerchantProvider` port.
- Payment lifecycle: unique-amount allocation, transaction matching, expiry,
  cancellation, and background reconciliation polling.
- QRIS toolkit: EMVCo TLV parse/build, CRC-16/CCITT-FALSE, and static → dynamic
  conversion.
- GoPay: OTP login, automatic token refresh on 401, merchant/outlet discovery,
  and the transaction feed.
- Shopee: OTP login (with password second factor), session import from a
  browser login, merchant and store discovery, merchant switching without a new
  OTP, silent session renewal while the account session is alive, and the
  transaction feed.
- CLI (`merchid`) for login, session inspection, merchant/store selection, and
  binding a static QRIS.
- Zero runtime dependencies; ESM and CommonJS builds with type declarations for
  both.

[unreleased]: https://github.com/alhifnywahid/merchantid/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/alhifnywahid/merchantid/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alhifnywahid/merchantid/releases/tag/v0.1.0
