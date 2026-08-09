/**
 * Static endpoint and header configuration derived from the GoBiz merchant
 * dashboard network flow. These are the hosts and default headers the official
 * web dashboard uses; they are required for the private API to accept requests.
 */

export const GOBIZ_API_BASE_URL = "https://api.gobiz.co.id";
export const GOJEK_API_BASE_URL = "https://api.gojekapi.com";

export const ENDPOINTS = {
  loginRequest: "/goid/login/request",
  token: "/goid/token",
  usersMe: "/v1/users/me",
  merchantsSearch: "/v1/merchants/search",
  merchantDetail: (merchantId: string) => `/v1/merchants/${merchantId}`,
  transactions: "/merchant-analytics/v2/merchants/transactions",
} as const;

/**
 * Default GoID client identifiers used by the web dashboard. They can be
 * overridden through the client configuration when Gojek rotates them.
 */
export const DEFAULT_GOID_CLIENT_ID = "go-biz-web-new";
const DEFAULT_APP_ID = "go-biz-web-dashboard";
export const DEFAULT_APP_VERSION = "platform-v3.109.0-d4b20f12";

/**
 * Baseline headers required by the GoID/GoBiz gateway. The dashboard identifies
 * itself as a web merchant client through this set.
 */
export const DEFAULT_STATIC_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json, text/plain, */*",
  "Authentication-Type": "go-id",
  "X-PhoneMake": "Web",
  "X-PhoneModel": "Node.js Client",
  "x-DeviceOS": "Web",
  "X-User-Locale": "id",
  "Gojek-Country-Code": "ID",
  "Gojek-Timezone": "Asia/Jakarta",
  "X-Platform": "Web",
  "X-User-Type": "merchant",
  "x-appId": DEFAULT_APP_ID,
};

/**
 * Transaction statuses that represent money actually received by the merchant.
 * Lowercase to match the merchant-analytics feed (Midtrans-style values). The
 * matcher compares case-insensitively, and polling fetches unfiltered, so these
 * are only used by direct `TransactionClient.list` callers.
 */
export const PAID_TRANSACTION_STATUSES = ["settlement", "capture"] as const;

/** Payment types the gateway polls for. GoPay QRIS is the primary channel. */
export const DEFAULT_PAYMENT_TYPES = ["qris", "gopay"] as const;

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_PAYMENT_EXPIRY_MS = 5 * 60 * 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/**
 * How far back the poller scans the transaction feed. A rolling window (rather
 * than a calendar day) avoids timezone/day-boundary gaps between the runtime
 * (often UTC) and the merchant's local day.
 */
export const DEFAULT_TRANSACTION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

/**
 * Largest `size` the merchant-analytics feed accepts. Anything above it is
 * rejected with HTTP 422 and `validation_errors: { Size: { message: "max=100" } }`,
 * so requests are clamped to this ceiling rather than failing the whole poll.
 */
export const MAX_TRANSACTION_PAGE_SIZE = 100;

/**
 * How many transactions each feed page holds. The feed returns newest first
 * and refuses anything above {@link MAX_TRANSACTION_PAGE_SIZE}; when a page
 * comes back full, the poller walks further pages (bounded by
 * {@link MAX_TRANSACTION_PAGES_PER_TICK}) instead of asking for a bigger one.
 */
export const DEFAULT_TRANSACTION_PAGE_SIZE = MAX_TRANSACTION_PAGE_SIZE;

/**
 * How many feed pages one reconciliation pass will fetch at most. Pagination
 * exists so a busy outlet cannot push a matching transaction off the first
 * page (the feed hard-caps each page at {@link MAX_TRANSACTION_PAGE_SIZE});
 * the cap exists so a pathological window can never turn one poll into an
 * unbounded crawl. Hitting the cap is logged - it means the oldest slice of
 * the window was not scanned this tick.
 */
export const MAX_TRANSACTION_PAGES_PER_TICK = 10;

/**
 * Amount uniqueness window. GoPay QRIS amounts are whole rupiah, so unique
 * "cents" are encoded as an integer offset added to the base amount.
 */
export const DEFAULT_MAX_UNIQUE_OFFSET = 999;

/**
 * Divisor converting merchant-analytics amounts into whole rupiah.
 *
 * The `merchant-analytics/v2` feed reports money in ISO 4217 minor units, so a
 * Rp 3.001 payment arrives as `gross_amount: 300100`. Everything else in this
 * library - QRIS tag 54, the amount allocator, `Payment.uniqueAmount` - works
 * in whole rupiah, so the transaction adapter divides by this factor to bring
 * the feed onto the same scale.
 *
 * Do not compensate for this in the matcher by accepting both scales: that
 * would let a genuine Rp 300.100 transaction settle a Rp 3.001 order.
 */
export const TRANSACTION_AMOUNT_SCALE = 100;
