/** Serializable cookie state used by the fetch-only Shopee login flow. */
export interface ShopeeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none";
  expiresAt?: number;
}

export interface ShopeeOtpRequestOptions {
  /**
   * Shopee OTP channel (1=SMS, 2=voice call, 3=WhatsApp). Defaults to the
   * channel Shopee's settings endpoint returns, which matches the reference
   * capture (WhatsApp).
   */
  channel?: number;
  /**
   * The account password, required when the account is password-protected.
   * Shopee only delivers an OTP after the password is accepted; without it
   * `send_otp` reports success but the code is silently suppressed.
   */
  password?: string;
  /**
   * Body for the device-risk report. Without it the report sends an empty
   * JSON object and receives a degraded risk token (segment lengths
   * `24,76,...`) whose OTP delivery is silently suppressed. Supplying the
   * telemetry blob the official passport web client posts yields the full
   * token (`24,80,...`) the reference capture used for delivery.
   */
  deviceReport?: string;
}

/** Sensitive, short-lived state returned after an OTP is sent. */
export interface ShopeeOtpChallenge {
  version: 1;
  phoneNumber: string;
  channel: number;
  availableChannels: number[];
  /** Signed device-risk token used as `security_device_fingerprint`. */
  deviceFingerprint: string;
  /** Alias of `deviceFingerprint`; kept for the fraud-header echo. */
  riskToken?: string;
  /** True once the password step (if any) was accepted before the OTP. */
  hasPassword?: boolean;
  cookies: ShopeeCookie[];
  requestedAt: number;
}

export interface ShopeeMerchantSummary {
  id: string;
  name: string;
  status: number;
  staffUserId: number;
  staffRole: number;
  staffStatus: number;
  isActive: boolean;
  isBanned: boolean;
  isCurrentLoginUser: boolean;
}

/**
 * Sensitive intermediate state returned after OTP verification. It can be
 * reused to select a merchant without requesting a second OTP.
 */
export interface ShopeeOtpVerification {
  version: 1;
  tocNonce: string;
  tocUserId: number;
  spcClientId: string;
  deviceFingerprint: string;
  cookies: ShopeeCookie[];
  merchants: ShopeeMerchantSummary[];
  verifiedAt: number;
}

export interface ShopeeStore {
  id: string;
  name: string;
  status: number;
}

/** Owner metadata that prevents a manually supplied QRIS crossing stores. */
export interface ShopeeStaticQrisScope {
  merchantId: string;
  storeId: string;
}

export interface ShopeeMerchantProfile {
  merchantId: string;
  merchantName: string;
  storeId?: string;
  accountId: string;
  userId: string;
  userName: string;
  language: string;
  shopeePayServiceStatus: number;
  raw: unknown;
}

/** Persist this object privately to restore a Shopee merchant session. */
export interface ShopeeSession {
  version: 1;
  cookies: ShopeeCookie[];
  accountId: string;
  /** The currently active business merchant. */
  merchant: ShopeeMerchantSummary;
  /**
   * Every business merchant the account can access, so the active merchant can
   * be switched without logging in again. Defaults to `[merchant]` for
   * sessions persisted before multi-merchant support existed.
   */
  merchants: ShopeeMerchantSummary[];
  /**
   * Account-session material captured at login so the active merchant can be
   * changed without a second OTP. Switching re-runs the login token exchange
   * (`login_toc` → `/account/login/tob/auth`) for the target merchant's staff
   * user id - the same chain a fresh login uses - which mints a dashboard token
   * the API accepts. Absent on sessions created before switch support (or
   * imported via a raw token cookie), which therefore cannot switch and must
   * log in again. Sensitive: persisted alongside the equally sensitive cookies.
   */
  switchCredential?: {
    tocNonce: string;
    spcClientId: string;
    deviceFingerprint: string;
  };
  stores: ShopeeStore[];
  storeId?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ShopeeVerifyOtpInput {
  challenge: ShopeeOtpChallenge;
  otp: string;
}

export interface ShopeeCompleteLoginInput {
  verification: ShopeeOtpVerification;
  merchantId?: string;
  storeId?: string;
}

export interface ShopeeLoginWithOtpInput {
  challenge: ShopeeOtpChallenge;
  otp: string;
  merchantId?: string;
  storeId?: string;
}

/**
 * Result of {@link ShopeeProvider.loginWithOtp}. When the account can reach more
 * than one business merchant and no `merchantId` was supplied, the login stops
 * at `merchant-selection-required` and hands back the sensitive `verification`
 * plus the usable `merchants`, so a caller can let a human pick and then finish
 * with {@link ShopeeProvider.completeLogin} - no second OTP required.
 */
export type ShopeeLoginOutcome =
  | { status: "complete"; session: ShopeeSession }
  | {
      status: "merchant-selection-required";
      verification: ShopeeOtpVerification;
      merchants: ShopeeMerchantSummary[];
    };
