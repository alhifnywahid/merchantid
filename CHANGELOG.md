# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x`, the public API is not yet stable: a minor bump may
contain breaking changes, and each one is listed under **Changed** or
**Removed** with the migration to apply.

## [Unreleased]

## [0.1.0] - 2026-08-09

First public release. MerchantId turns a merchant's static QRIS into a unique
per-order dynamic QRIS and reconciles settlement by polling the provider's own
transaction feed — for GoPay Merchant (GoBiz) and ShopeePay Merchant.

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
- `merchantid` CLI for login, session inspection, merchant/store selection, and
  binding a static QRIS.
- Zero runtime dependencies; ESM and CommonJS builds with type declarations for
  both.

[unreleased]: https://github.com/alhifnywahid/merchantid/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alhifnywahid/merchantid/releases/tag/v0.1.0
