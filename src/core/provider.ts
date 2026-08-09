import type {
  MerchantTransaction,
  PaymentScope,
  SessionState,
} from "./types.js";

/**
 * Provider-owned transaction query after the payment domain has narrowed the
 * relevant time window. Amounts returned by a feed must already be normalized
 * to whole rupiah.
 */
export interface TransactionFeedQuery {
  scope: PaymentScope;
  startTime: Date;
  endTime: Date;
  /** Suggested page size. Providers may clamp it to their own API limit. */
  pageSize: number;
  /** Safety ceiling for provider-owned pagination. */
  maxPages: number;
}

/** Result of a provider-normalized transaction scan. */
export interface TransactionFeedResult {
  transactions: MerchantTransaction[];
  /** True when the provider hit its pagination ceiling before exhausting data. */
  truncated?: boolean;
  pagesFetched?: number;
}

/**
 * Provider-neutral transaction capability consumed by {@link PaymentService}.
 * Each adapter owns its cursor/offset semantics, status filtering, timestamps,
 * and conversion from provider-specific money units to whole rupiah.
 */
export interface TransactionFeed {
  listRecent(query: TransactionFeedQuery): Promise<TransactionFeedResult>;
}

/**
 * Small common surface implemented by merchant provider facades.
 * Authentication details intentionally stay provider-specific.
 */
export interface MerchantProvider<TSession = SessionState> {
  readonly providerId: string;
  readonly authenticated: boolean;
  readonly staticQris?: string;
  getPaymentScope(): PaymentScope | undefined;
  exportSession(): TSession;
}

/** Compare two complete payment scopes. */
export function samePaymentScope(
  left: PaymentScope,
  right: PaymentScope,
): boolean {
  return (
    left.provider === right.provider &&
    left.merchantId === right.merchantId &&
    left.accountId === right.accountId
  );
}
