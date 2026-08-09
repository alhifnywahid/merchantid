/**
 * Public and internal domain types for the gateway.
 */

/** OAuth-style token pair returned by the GoID token endpoint. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry as epoch milliseconds, when derivable from the response. */
  expiresAt?: number;
  tokenType: string;
}

/** Persisted authentication session. Contains auth tokens and device identity. */
export interface SessionState {
  tokens: TokenSet;
  /** Stable device identifier for consistent x-uniqueid header across sessions. */
  deviceId?: string;
  /** When the session was last refreshed (epoch milliseconds), for debugging. */
  lastRefreshedAt?: number;
}

/**
 * The single capability {@link TokenManager} needs from the auth layer.
 *
 * Declaring it here keeps `core` free of any dependency on the `api` adapters:
 * `AuthClient` satisfies this structurally, and tests (or alternative auth
 * backends) can supply their own implementation.
 */
export interface TokenRefresher {
  refresh(refreshToken: string): Promise<TokenSet>;
}

/** Result of requesting an OTP for a phone number. */
export interface LoginRequestResult {
  /**
   * Opaque token some GoID flows return alongside the OTP challenge. Pass it
   * back when verifying if present.
   */
  otpToken?: string;
  raw: unknown;
}

/** Normalized merchant profile. */
export interface MerchantProfile {
  id: string;
  merchantName: string;
  outletName?: string;
  phone?: string;
  email?: string;
  serverKey?: string;
  clientKey?: string;
  timezone?: string;
  /** Payment outlets, each with its own GoPay static QRIS. */
  outlets: MerchantOutlet[];
  raw: unknown;
}

/**
 * A point-of-payment (outlet/terminal) with its GoPay static QRIS. A merchant
 * may have several; each has its own `qrString`.
 */
export interface MerchantOutlet {
  popId: string;
  name?: string;
  status?: string;
  /** GoPay receiver id backing this outlet's QRIS. */
  receiverId?: string;
  /** The static EMVCo QRIS payload for this outlet (from `aspi_qr_string`). */
  qrString?: string;
  raw: unknown;
}

/**
 * Full merchant record persisted in config. One entry per merchant the account
 * has access to. Includes the resolved outlets and their static QRIS strings.
 */
export interface StoredMerchant {
  id: string;
  merchantName: string;
  outletName?: string;
  phone?: string;
  email?: string;
  businessType?: string;
  merchantType?: string;
  serviceArea?: string;
  outlets: MerchantOutlet[];
  /** Convenience: the primary outlet's static QRIS, when available. */
  qrString?: string;
  /** Full raw merchant payload from the API for advanced use. */
  raw: unknown;
}

/** A single transaction as returned by the merchant analytics API. */
export interface MerchantTransaction {
  id: string;
  orderId: string;
  merchantId: string;
  status: string;
  paymentType: string;
  grossAmount: number;
  realGrossAmount?: number;
  currency: string;
  transactionTime: string;
  settlementTime?: string;
  transactionSource?: string;
  raw: unknown;
}

/**
 * The single capability {@link PaymentService} needs from the transaction feed.
 *
 * Mirrors {@link TokenRefresher}: keeping it in `core` lets the payment domain
 * stay independent of the `api` adapters. `TransactionClient` satisfies it.
 */
export interface TransactionLister {
  list(
    merchantId: string,
    query: TransactionQuery,
  ): Promise<MerchantTransaction[]>;
}

/** Filter for listing transactions. */
export interface TransactionQuery {
  from?: number;
  size?: number;
  statuses?: readonly string[];
  paymentTypes?: readonly string[];
  startTime: Date;
  endTime: Date;
}

/** Identifies the provider account and merchant that own a payment. */
export interface PaymentScope {
  /** Stable provider id such as `gopay` or `shopee`. */
  provider: string;
  /** Optional provider account id when it is available. */
  accountId?: string;
  /** Provider-native merchant/store id used to poll transactions. */
  merchantId: string;
}

/** Lifecycle status of a payment tracked by the gateway. */
export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled";

/** A payment intent created by the gateway. */
export interface Payment {
  /** Caller-facing identifier. */
  id: string;
  /** Provider ownership. Omitted only on explicitly unscoped records. */
  scope?: PaymentScope;
  /** The base amount requested by the merchant, in whole rupiah. */
  baseAmount: number;
  /** The unique offset added for disambiguation. */
  uniqueOffset: number;
  /** The exact amount the buyer must transfer (baseAmount + uniqueOffset). */
  uniqueAmount: number;
  status: PaymentStatus;
  createdAt: number;
  expiresAt: number;
  /** Optional caller-supplied reference (e.g. internal order id). */
  reference?: string;
  /** Dynamic QRIS payload string when a static QRIS was configured. */
  qrString?: string;
  /** Matched transaction once paid. */
  transaction?: MerchantTransaction;
  metadata?: Record<string, unknown>;
}

/** Contract for persisting active payments. */
export interface PaymentStore {
  create(payment: Payment): Promise<void> | void;
  update(payment: Payment): Promise<void> | void;
  get(id: string): Promise<Payment | undefined> | Payment | undefined;
  /**
   * All payments still occupying a unique amount slot. Implementations should
   * apply `scope` when supplied; callers also filter defensively when a
   * custom store returns records from other scopes.
   */
  listActive(scope?: PaymentScope): Promise<Payment[]> | Payment[];
}
