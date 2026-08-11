/** Provider-owned constants observed from the Shopee Partner web clients. */
export const SHOPEE_PROVIDER_ID = "shopee";

export const SHOPEE_ACCOUNT_BASE_URL =
  "https://partner.business.accounts.shopee.co.id";
export const SHOPEE_PARTNER_BASE_URL = "https://partner.shopee.co.id";
export const SHOPEE_PARTNER_API_BASE_URL = "https://api.partner.shopee.co.id";
export const SHOPEE_PAY_BASE_URL = "https://shopeepay.shopee.co.id";
/** Device-risk issuer used by the browser fraud SDK before any OTP request. */
export const SHOPEE_DEVICE_FINGERPRINT_REPORT_URL =
  "https://df.infra.sz.shopee.co.id/v2/shpsec/web/report";
/** Fraud SDK version the passport client advertises alongside its risk token. */
export const SHOPEE_SZ_SDK_VERSION = "1.12.26-user.1";

export const SHOPEE_ENDPOINTS = {
  checkPasswordMigration: "/api/v4/account/business/check_password_migrate",
  checkAccountExistByPassword:
    "/api/v4/account/business/check_account_exist_by_password",
  authenticateByPassword:
    "/api/v4/account/business/authenticate_toc_by_password",
  otpSettings: "/api/v4/account/business/get_otp_settings",
  sendOtp: "/api/v4/account/business/send_otp",
  verifyOtp: "/api/v4/account/business/verify_otp",
  authenticateByOtp: "/api/v4/account/business/authenticate_toc_by_otp",
  loginToc: "/api/v4/account/business/login_toc",
  /**
   * Liveness probe for the passport account session. Answers `error:0` with the
   * signed-in user while the SPC_* account cookies are still valid, and
   * `48500102` ("not login") once they are not - the signal that separates a
   * session that can be renewed silently from one that needs a new OTP.
   */
  loginStatus: "/api/v4/account/business/login_status",
  merchantDetect:
    "/nb/mss/mer-detect-api/PartnerMerchantDetectServer/MerchantDetect",
  switchMerchant:
    "/nb/mss/mer-detect-api/PartnerMerchantDetectServer/SwitchMerchant",
  userInfo: "/nb/mss/web-api/PartnerAccountServer/GetUserInfo",
  accountLogin: "/account/login/auth",
  accountLoginToken: "/authenticate/login/token/",
  accountTobAuth: "/account/login/tob/auth",
  partnerLoginAuth: "/login/auth",
  stores: "/merchant/v1/partner-web/get-store-list",
  transactions: "/merchant/v1/partner-web/get-transaction-list",
} as const;

export const SHOPEE_OTP_OPERATION = 50_001;
export const SHOPEE_OTP_CHANNELS = [1, 2, 3, 5] as const;
export const SHOPEE_SEND_OTP_CHANNELS = [1, 2, 3, 5, 4] as const;

/**
 * Passport error codes from the login bundle. `48401102` (NeedOTP) is the
 * success path for password-protected accounts: the password was accepted and
 * an OTP is required as the second factor. OTP delivery only happens after
 * this step for accounts that have a password.
 */
export const SHOPEE_AUTH_ERROR = {
  NEED_OTP: 48_401_102,
} as const;

/**
 * OTP delivery channels as numbered by the Shopee passport client. Internal:
 * callers pass a plain `channel` number on `ShopeeOtpRequestOptions`, so this
 * stays out of the public surface rather than becoming a semver commitment.
 */
const SHOPEE_OTP_CHANNEL = {
  NONE: 0,
  SMS: 1,
  VOICE_CALL: 2,
  WHATSAPP: 3,
  EMAIL: 4,
  ZALO: 5,
  VIBER: 6,
  WHATSAPP_AUTH_LINK: 9,
} as const;

/**
 * The channel observed to deliver successfully in the reference capture, and
 * the one Shopee's own settings returned as default for this account.
 */
export const SHOPEE_DEFAULT_OTP_CHANNEL = SHOPEE_OTP_CHANNEL.WHATSAPP;

export const SHOPEE_DEFAULT_LANGUAGE = "id";
export const SHOPEE_DEFAULT_TIMEZONE = "Asia/Jakarta";

/**
 * The Referer the passport SPA presents on every authentication call. The
 * gateway's fraud layer compares request context against the official web
 * client; requests that arrive with the bare `/login` referrer look scripted
 * and have OTP delivery suppressed even when they report success. The value
 * mirrors the observed browser capture, with the `business_next` hop passed
 * in because it is the same URL the SSO `state` parameter carries.
 */
export function shopeeLoginReferer(businessNext: string): string {
  const referer = new URL("/authenticate/login/", SHOPEE_ACCOUNT_BASE_URL);
  referer.searchParams.set("lang", SHOPEE_DEFAULT_LANGUAGE);
  referer.searchParams.set("should_hide_back", "true");
  const state = new URL("/", SHOPEE_PARTNER_BASE_URL);
  state.searchParams.set("business_next", businessNext);
  state.searchParams.set("business_state", SHOPEE_PARTNER_BASE_URL);
  state.searchParams.set("business_client_id", SHOPEE_BUSINESS_CLIENT_ID);
  referer.searchParams.set("state", state.toString());
  referer.searchParams.set("client_id", SHOPEE_ACCOUNT_CLIENT_ID);
  referer.searchParams.set(
    "next",
    new URL("/account/login/auth", SHOPEE_PARTNER_BASE_URL).toString(),
  );
  return referer.toString();
}
export const SHOPEE_PARTNER_LOGIN_FROM = "12";
export const SHOPEE_BUSINESS_CLIENT_ID = "1";
export const SHOPEE_ACCOUNT_CLIENT_ID = "5";

/** The only completed transaction status observed in the Shopee feed. */
export const SHOPEE_COMPLETED_TRANSACTION_STATUS = 3;
/** A page size of ten is the largest value verified against the private feed. */
export const SHOPEE_TRANSACTION_PAGE_SIZE = 10;
export const SHOPEE_STORE_PAGE_SIZE = 30;
export const SHOPEE_TRANSACTION_SERVICES = [1, 3] as const;
export const SHOPEE_STORE_SERVICES = [1, 10] as const;

export const SHOPEE_LIVE_TOKEN_COOKIE = "__shopee_partner_website_x_token_live";
export const SHOPEE_CLIENT_ID_COOKIE = "SPC_CLIENTID";

/**
 * API codes that mean the merchant token was rejected and the caller must
 * authenticate again.
 *
 * `200020` is Shopee's generic "NotAuthorized" (per the web bundle's own map:
 * `{NotAuthorized:200020, AccessDenied:200013, ErrorWebTokenInvalid:200026}`).
 * It was once treated as a transient, retryable state that a fresh merchant
 * token would clear; live testing disproved that - a token the dashboard API
 * answers `200020` for stays rejected however long the caller waits. Treating
 * it as terminal is therefore the honest classification: the session must be
 * renewed (`ShopeeProvider.refreshSession`) or re-established with an OTP.
 */
export const SHOPEE_INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  "200020",
  "2010000",
]);
