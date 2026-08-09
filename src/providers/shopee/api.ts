import {
  ApiError,
  AuthError,
  CaptchaRequiredError,
} from "../../core/errors.js";
import {
  SHOPEE_DEFAULT_LANGUAGE,
  SHOPEE_DEFAULT_TIMEZONE,
  SHOPEE_INVALID_TOKEN_CODES,
  SHOPEE_PARTNER_LOGIN_FROM,
} from "./constants.js";
import { uuid } from "../../utils/id.js";
import { safeDiagnosticText } from "../../utils/redact.js";

export interface ShopeeAccountEnvelope<T> {
  error?: number;
  error_msg?: string;
  data?: T;
}

export interface ShopeePartnerEnvelope<T> {
  errorCode?: number;
  errorMsg?: string;
  data?: T;
}

export interface ShopeePaymentEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface ShopeeApiLocale {
  language?: string;
  timezone?: string;
}

function apiCode(value: number | string | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function mentionsAuthentication(message: string | undefined): boolean {
  return Boolean(message && /token|auth|login|session/i.test(message));
}

/** Shared with the GoPay client so the redaction rule cannot drift apart. */
const safeApiReason = safeDiagnosticText;

/** Compose a diagnosable failure message without leaking sensitive material. */
function describeFailure(
  summary: string,
  endpoint: string,
  code: string | undefined,
  reason: string | undefined,
): string {
  const parts = [summary, `at ${endpoint}`];
  if (code !== undefined) parts.push(`(error ${code})`);
  if (reason) parts.push(`- ${reason}`);
  return parts.join(" ");
}

export function requireAccountData<T>(
  response: ShopeeAccountEnvelope<T>,
  endpoint: string,
): T {
  const maybeCaptcha = response.data as
    { captcha_required?: unknown } | undefined;
  if (
    maybeCaptcha?.captcha_required === true ||
    /captcha/i.test(response.error_msg ?? "")
  ) {
    throw new CaptchaRequiredError(undefined, {
      provider: "shopee",
      endpoint,
      apiCode: apiCode(response.error),
    });
  }
  if (response.error !== 0 || response.data === undefined) {
    const code = apiCode(response.error);
    const reason = safeApiReason(response.error_msg);
    throw new AuthError(
      "AUTH_FAILED",
      describeFailure(
        "Shopee authentication request failed",
        endpoint,
        code,
        reason,
      ),
      {
        details: {
          provider: "shopee",
          endpoint,
          apiCode: code,
          reason,
        },
      },
    );
  }
  return response.data;
}

export function requirePartnerData<T>(
  response: ShopeePartnerEnvelope<T>,
  endpoint: string,
): T {
  const code = apiCode(response.errorCode);
  if (response.errorCode !== 0 || response.data === undefined) {
    const reason = safeApiReason(response.errorMsg);
    if (
      (code !== undefined && SHOPEE_INVALID_TOKEN_CODES.has(code)) ||
      mentionsAuthentication(response.errorMsg)
    ) {
      throw new AuthError(
        "AUTH_FAILED",
        describeFailure(
          "Shopee rejected the saved session; login again",
          endpoint,
          code,
          reason,
        ),
        { details: { provider: "shopee", endpoint, apiCode: code, reason } },
      );
    }
    throw new ApiError(
      describeFailure(
        "Shopee partner API request failed",
        endpoint,
        code,
        reason,
      ),
      {
        apiCode: code,
        details: { provider: "shopee", endpoint, reason },
      },
    );
  }
  return response.data;
}

export function requirePaymentData<T>(
  response: ShopeePaymentEnvelope<T>,
  endpoint: string,
): T {
  const code = apiCode(response.code);
  if (response.code !== 0 || response.data === undefined) {
    const reason = safeApiReason(response.msg);
    if (
      (code !== undefined && SHOPEE_INVALID_TOKEN_CODES.has(code)) ||
      mentionsAuthentication(response.msg)
    ) {
      throw new AuthError(
        "AUTH_FAILED",
        // Same shape as the partner-envelope branch: which endpoint and which
        // code is what makes an auth failure diagnosable.
        describeFailure(
          "Shopee rejected the saved session; login again",
          endpoint,
          code,
          reason,
        ),
        { details: { provider: "shopee", endpoint, apiCode: code, reason } },
      );
    }
    throw new ApiError(
      describeFailure(
        "ShopeePay merchant API request failed",
        endpoint,
        code,
        reason,
      ),
      {
        apiCode: code,
        details: { provider: "shopee", endpoint, reason },
      },
    );
  }
  return response.data;
}

export function partnerHeaders(options: {
  token?: string;
  tocNonce?: string;
  locale?: ShopeeApiLocale;
}): Record<string, string> {
  const language = options.locale?.language ?? SHOPEE_DEFAULT_LANGUAGE;
  const timezone = options.locale?.timezone ?? SHOPEE_DEFAULT_TIMEZONE;
  return {
    Origin: "https://partner.shopee.co.id",
    Referer: "https://partner.shopee.co.id/",
    "X-Merchant-ToB-Clientid": "undefined",
    "X-Merchant-Login-From": SHOPEE_PARTNER_LOGIN_FROM,
    "X-Merchant-From": SHOPEE_PARTNER_LOGIN_FROM,
    "X-Merchant-Language": language,
    "X-Merchant-Timezone": timezone,
    // The official web client stamps a fresh request id and an (empty) tracing
    // baggage on every partner API call. The mer-detect service in particular
    // rejects requests that arrive without them, so mirror the browser exactly.
    "X-Merchant-RequestId": partnerRequestId(),
    "shopee-baggage": "PFB=undefined",
    "X-Merchant-Token": options.token ?? "",
    ...(options.tocNonce ? { "X-Merchant-ToC-Nonce": options.tocNonce } : {}),
  };
}

/**
 * RFC4122 request id matching the `X-Merchant-RequestId` the web client sends.
 * Reuses the shared generator (WebCrypto with graceful fallbacks) rather than
 * carrying a second copy of the same UUID logic.
 */
const partnerRequestId = uuid;

export function paymentHeaders(): Record<string, string> {
  return {
    Origin: "https://partner.shopee.co.id",
    Referer: "https://partner.shopee.co.id/",
    "X-Timestamp-Ms": String(Date.now()),
    "X-Token": "",
  };
}

export function paymentMetadata(
  token: string,
  locale: ShopeeApiLocale = {},
): { token: string; language: string; timezone: string } {
  return {
    token,
    language: locale.language ?? SHOPEE_DEFAULT_LANGUAGE,
    timezone: locale.timezone ?? SHOPEE_DEFAULT_TIMEZONE,
  };
}
