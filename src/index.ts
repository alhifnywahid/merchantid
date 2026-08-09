/**
 * MerchID public API.
 *
 * Provider-neutral orchestration lives in `MerchID`; concrete GoPay and Shopee
 * adapters remain directly available for focused integrations.
 */

export { MerchID, createMerchID } from "./merchid.js";
export type {
  MerchIDConfig,
  MerchIDProviderSummary,
  RegisteredMerchantProvider,
} from "./merchid.js";
export * from "./providers/gopay/index.js";
export * from "./providers/shopee/index.js";
export { samePaymentScope } from "./core/provider.js";
export type {
  MerchantProvider,
  TransactionFeed,
  TransactionFeedQuery,
  TransactionFeedResult,
} from "./core/provider.js";

export { TokenManager as GopayTokenManager } from "./core/tokenManager.js";
export type { TokenManagerConfig as GopayTokenManagerConfig } from "./core/tokenManager.js";

export { PaymentService } from "./payment/paymentService.js";
export type {
  CreatePaymentInput,
  PaymentServiceOptions,
  PaymentServiceEvents,
} from "./payment/paymentService.js";
export { InMemoryPaymentStore } from "./payment/paymentStore.js";
export { AmountAllocator } from "./payment/amountAllocator.js";
export { matchesPayment, reconcile } from "./payment/paymentMatcher.js";

export {
  parseEmv,
  buildEmv,
  encodeTlv,
  staticToDynamicQris,
  isValidQrisChecksum,
  QRIS_TAGS,
} from "./qris/qris.js";
export type { EmvTlvMap } from "./qris/qris.js";

export { crc16ccitt } from "./utils/crc16.js";
export { createConsoleLogger, noopLogger } from "./utils/logger.js";
export type { Logger, LogLevel } from "./utils/logger.js";
export { HttpClient as GopayHttpClient } from "./http/httpClient.js";
export type {
  FetchLike,
  HttpClientOptions as GopayHttpClientOptions,
  HttpRequestOptions as GopayHttpRequestOptions,
  QueryValue as GopayQueryValue,
} from "./http/httpClient.js";

export {
  MerchIDError,
  ConfigError,
  AuthError,
  CaptchaRequiredError,
  HttpError,
  ApiError,
} from "./core/errors.js";
export type { MerchIDErrorCode } from "./core/errors.js";

export * from "./core/types.js";
export {
  GOBIZ_API_BASE_URL,
  GOJEK_API_BASE_URL,
  PAID_TRANSACTION_STATUSES,
  DEFAULT_PAYMENT_TYPES,
  DEFAULT_TRANSACTION_PAGE_SIZE,
  MAX_TRANSACTION_PAGE_SIZE,
  MAX_TRANSACTION_PAGES_PER_TICK,
} from "./core/constants.js";
