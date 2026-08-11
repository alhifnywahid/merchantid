import { AuthError, ConfigError, HttpError } from "../../core/errors.js";
import { parseIndonesianMobile } from "../../utils/phone.js";
import {
  partnerHeaders,
  requireAccountData,
  requirePartnerData,
} from "./api.js";
import type {
  ShopeeAccountEnvelope,
  ShopeeApiLocale,
  ShopeePartnerEnvelope,
} from "./api.js";
import {
  SHOPEE_ACCOUNT_BASE_URL,
  SHOPEE_ACCOUNT_CLIENT_ID,
  SHOPEE_AUTH_ERROR,
  SHOPEE_BUSINESS_CLIENT_ID,
  SHOPEE_CLIENT_ID_COOKIE,
  SHOPEE_DEFAULT_LANGUAGE,
  SHOPEE_DEFAULT_OTP_CHANNEL,
  SHOPEE_DEVICE_FINGERPRINT_REPORT_URL,
  SHOPEE_ENDPOINTS,
  SHOPEE_OTP_CHANNELS,
  SHOPEE_OTP_OPERATION,
  SHOPEE_PARTNER_API_BASE_URL,
  SHOPEE_PARTNER_BASE_URL,
  SHOPEE_SEND_OTP_CHANNELS,
  SHOPEE_SZ_SDK_VERSION,
  shopeeLoginReferer,
} from "./constants.js";
import { hashShopeePassword } from "./crypto.js";
import type { ShopeeHttpClient } from "./httpClient.js";
import { SHOPEE_BROWSER_HEADERS, shopeeUrl } from "./httpClient.js";
import { readShopeeMerchantCredential } from "./token.js";
import type { Logger } from "../../utils/logger.js";
import { noopLogger } from "../../utils/logger.js";
import type {
  ShopeeCompleteLoginInput,
  ShopeeMerchantSummary,
  ShopeeOtpChallenge,
  ShopeeOtpRequestOptions,
  ShopeeOtpVerification,
  ShopeeSession,
  ShopeeVerifyOtpInput,
} from "./types.js";

interface PasswordMigrationData {
  need_migrate?: boolean;
}

interface ExistByPasswordData {
  has_password?: boolean;
  otp_channel?: number[];
  otp_default_channel?: number;
}

interface AuthenticateByPasswordData {
  toc_account?: {
    has_password?: boolean;
    userid?: number;
  };
}

interface OtpSettingsData {
  available_channel_list?: number[];
  captcha_required?: boolean;
  default_channel?: number;
}

interface SendOtpData {
  seed?: string;
}

interface VerifyOtpData {
  otp_token?: string;
}

interface AuthenticateOtpData {
  toc_nonce?: string;
  toc_account?: { userid?: number };
}

interface MerchantDetectData {
  TocUid?: number;
  selectMerchant?: {
    merchantList?: RawMerchantSummary[];
  } | null;
}

interface RawMerchantSummary {
  merchantId?: number;
  merchantName?: string;
  merchantStatus?: number;
  staffTobUid?: number;
  staffRole?: number;
  staffStatus?: number;
  isActive?: boolean;
  isBanned?: boolean;
  isCurrentLoginUser?: boolean;
}

interface LoginTocData {
  nonce?: string;
}

export interface ShopeeAuthClientOptions {
  locale?: ShopeeApiLocale;
  logger?: Logger;
}

/**
 * Raised when a password-protected account reaches the OTP step without one.
 * Shopee answers `send_otp` with success either way but silently withholds the
 * code, so this must be an explicit failure rather than a silent dead end.
 */
const PASSWORD_REQUIRED_MESSAGE =
  "This Shopee account is password-protected; supply the password to receive an OTP";

function partnerState(): string {
  const state = new URL("/", SHOPEE_PARTNER_BASE_URL);
  state.searchParams.set(
    "business_next",
    shopeeUrl(SHOPEE_PARTNER_BASE_URL, SHOPEE_ENDPOINTS.partnerLoginAuth),
  );
  state.searchParams.set("business_state", SHOPEE_PARTNER_BASE_URL);
  state.searchParams.set("business_client_id", SHOPEE_BUSINESS_CLIENT_ID);
  return state.toString();
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Render an e164 phone number the way the passport client formats it in the
 * `verify_otp` body, e.g. `(+62) 897 7110 640`. The endpoint rejects the
 * compact e164 form.
 */
function formatPhoneForVerification(e164: string): string {
  const subscriber = e164.replace(/^62/, "");
  const groups = [
    subscriber.slice(0, 3),
    subscriber.slice(3, 7),
    subscriber.slice(7),
  ].filter(Boolean);
  return `(+62) ${groups.join(" ")}`;
}

/** Fetch-only Shopee business-account OTP and merchant-token exchange. */
export class ShopeeAuthClient {
  private readonly http: ShopeeHttpClient;
  private readonly locale: ShopeeApiLocale;
  private readonly logger: Logger;

  constructor(http: ShopeeHttpClient, options: ShopeeAuthClientOptions = {}) {
    this.http = http;
    this.locale = options.locale ?? {};
    this.logger = options.logger ?? noopLogger;
  }

  async requestOtp(
    phoneNumber: string,
    options: ShopeeOtpRequestOptions = {},
  ): Promise<ShopeeOtpChallenge> {
    const phone = parseIndonesianMobile(phoneNumber).e164;
    this.http.cookieJar.clear();
    await this.bootstrapAccountSession();
    const deviceFingerprint = await this.acquireDeviceFingerprint(
      options.deviceReport,
    );

    await this.accountRequest<PasswordMigrationData>(
      SHOPEE_ENDPOINTS.checkPasswordMigration,
      { phone },
      deviceFingerprint,
    );
    this.logger.info("shopee otp: migration check passed");
    await this.checkAccountExists(phone, options.password, deviceFingerprint);
    this.logger.info("shopee otp: account existence checked");
    const hasPassword = await this.authenticateByPassword(
      phone,
      options.password,
      deviceFingerprint,
    );
    this.logger.info(
      hasPassword
        ? "shopee otp: password accepted, OTP second factor required"
        : "shopee otp: password step skipped (passwordless account)",
    );
    const settings = await this.accountRequest<OtpSettingsData>(
      SHOPEE_ENDPOINTS.otpSettings,
      {
        operation: SHOPEE_OTP_OPERATION,
        phone,
        security_device_fingerprint: deviceFingerprint,
        support_session: false,
        supported_channels: [...SHOPEE_OTP_CHANNELS],
      },
      deviceFingerprint,
    );

    const availableChannels = (settings.available_channel_list ?? []).filter(
      (channel): channel is number =>
        typeof channel === "number" && Number.isFinite(channel),
    );
    const channel =
      options.channel ??
      numberOr(settings.default_channel, SHOPEE_DEFAULT_OTP_CHANNEL);
    if (availableChannels.length > 0 && !availableChannels.includes(channel)) {
      throw new ConfigError("Requested Shopee OTP channel is unavailable", {
        channel,
        availableChannels,
      });
    }

    const sendResult = await this.accountRequest<SendOtpData>(
      SHOPEE_ENDPOINTS.sendOtp,
      {
        operation: SHOPEE_OTP_OPERATION,
        phone,
        security_device_fingerprint: deviceFingerprint,
        support_session: false,
        supported_channels: [...SHOPEE_SEND_OTP_CHANNELS],
        channel,
        captcha_signature: "",
      },
      deviceFingerprint,
    );
    this.logger.info(
      sendResult.seed
        ? "shopee otp: send accepted with delivery seed"
        : "shopee otp: send accepted but no delivery seed returned",
    );

    return {
      version: 1,
      phoneNumber: phone,
      channel,
      availableChannels,
      deviceFingerprint,
      riskToken: deviceFingerprint,
      hasPassword,
      cookies: this.http.cookieJar.snapshot(),
      requestedAt: Date.now(),
    };
  }

  /**
   * Load the passport login page so the gateway issues the anonymous session
   * cookies (csrftoken, SPC_*, language) the browser collects before the
   * first authentication call.
   */
  private async bootstrapAccountSession(): Promise<void> {
    const language = this.locale.language ?? SHOPEE_DEFAULT_LANGUAGE;
    const response = await this.http.request({
      url: shopeeUrl(SHOPEE_ACCOUNT_BASE_URL, "/login"),
      query: { lang: language },
      headers: { ...SHOPEE_BROWSER_HEADERS, Accept: "text/html" },
    });
    // The page body itself is irrelevant; only the cookies matter. Drain the
    // stream so the connection can close even on runtimes that keep it open.
    void response.text().catch(() => undefined);
  }

  /**
   * Obtain the device-risk token Shopee's fraud SDK normally generates. The
   * issuer grades the request body: a report without telemetry returns a
   * degraded `riskToken` (segment lengths `24,76,...`) whose OTP delivery is
   * silently suppressed even though every endpoint reports success. Passing
   * the telemetry blob the passport web client posts (`deviceReport`) yields
   * the full-strength token (`24,80,...`) the reference capture used. The
   * token is echoed as `security_device_fingerprint` and as the
   * `af-ac-enc-sz-token` header on every authentication request.
   */
  private async acquireDeviceFingerprint(
    deviceReport?: string,
  ): Promise<string> {
    const headers: Record<string, string> = {
      ...SHOPEE_BROWSER_HEADERS,
      Origin: SHOPEE_ACCOUNT_BASE_URL,
      Referer: `${SHOPEE_ACCOUNT_BASE_URL}/`,
    };
    const requestInit = deviceReport
      ? {
          headers: {
            ...headers,
            "Content-Type": "text/plain;charset=UTF-8",
            szdet: String(Date.now()),
          },
          body: deviceReport,
        }
      : {
          headers: { ...headers, "Content-Type": "application/json" },
          body: {},
        };
    const response = await this.http.requestJson<{
      code?: number;
      msg?: string;
      data?: { riskToken?: string };
    }>({
      method: "POST",
      url: SHOPEE_DEVICE_FINGERPRINT_REPORT_URL,
      ...requestInit,
    });
    if (response.code !== 0 || !response.data?.riskToken) {
      throw new HttpError(
        response.code ?? 0,
        "Shopee device-risk service returned no risk token",
        undefined,
        { provider: "shopee", endpoint: "/v2/shpsec/web/report" },
      );
    }
    return response.data.riskToken;
  }

  async verifyOtp(input: ShopeeVerifyOtpInput): Promise<ShopeeOtpVerification> {
    if (input.challenge.version !== 1) {
      throw new ConfigError("Unsupported Shopee OTP challenge version");
    }
    const otp = input.otp.trim();
    if (!/^\d{4,10}$/.test(otp)) {
      throw new ConfigError("Shopee OTP must contain 4 to 10 digits");
    }
    this.http.cookieJar.restore(input.challenge.cookies);

    const verified = await this.accountRequest<VerifyOtpData>(
      SHOPEE_ENDPOINTS.verifyOtp,
      {
        operation: SHOPEE_OTP_OPERATION,
        otp,
        phone: formatPhoneForVerification(input.challenge.phoneNumber),
        security_device_fingerprint: input.challenge.deviceFingerprint,
        support_session: false,
      },
      input.challenge.riskToken ?? input.challenge.deviceFingerprint,
    );
    if (!verified.otp_token) {
      throw new AuthError(
        "AUTH_FAILED",
        "Shopee OTP verification returned no token",
      );
    }

    const authenticated = await this.accountRequest<AuthenticateOtpData>(
      SHOPEE_ENDPOINTS.authenticateByOtp,
      {
        otp_token: verified.otp_token,
        security_device_fingerprint: input.challenge.deviceFingerprint,
        is_signup: false,
      },
      input.challenge.riskToken ?? input.challenge.deviceFingerprint,
    );
    const tocNonce = authenticated.toc_nonce;
    const tocUserId = authenticated.toc_account?.userid;
    if (!tocNonce || typeof tocUserId !== "number") {
      throw new AuthError(
        "AUTH_FAILED",
        "Shopee OTP authentication returned an incomplete account session",
      );
    }

    const spcClientId = this.http.cookieJar.get(
      SHOPEE_CLIENT_ID_COOKIE,
      SHOPEE_ACCOUNT_BASE_URL,
    );
    if (!spcClientId) {
      throw new AuthError(
        "AUTH_FAILED",
        "Shopee authentication returned no client session id",
      );
    }

    const accountLoginUrl = new URL(
      SHOPEE_ENDPOINTS.accountLogin,
      SHOPEE_PARTNER_BASE_URL,
    );
    accountLoginUrl.searchParams.set(
      "lang",
      this.locale.language ?? SHOPEE_DEFAULT_LANGUAGE,
    );
    accountLoginUrl.searchParams.set("spc_clientid", spcClientId);
    accountLoginUrl.searchParams.set("state", partnerState());
    accountLoginUrl.searchParams.set("toc_nonce", tocNonce);
    await this.http.followGet(accountLoginUrl.toString());

    const detectResponse = await this.http.requestJson<
      ShopeePartnerEnvelope<MerchantDetectData>
    >({
      method: "POST",
      url: shopeeUrl(
        SHOPEE_PARTNER_API_BASE_URL,
        SHOPEE_ENDPOINTS.merchantDetect,
      ),
      headers: partnerHeaders({ tocNonce, locale: this.locale }),
      body: {},
    });
    const detected = requirePartnerData(
      detectResponse,
      SHOPEE_ENDPOINTS.merchantDetect,
    );
    const merchants = (detected.selectMerchant?.merchantList ?? [])
      .map(normalizeMerchant)
      .filter(
        (merchant): merchant is ShopeeMerchantSummary => merchant !== undefined,
      );
    if (merchants.length === 0) {
      throw new AuthError(
        "AUTH_FAILED",
        "The Shopee account has no accessible merchant",
      );
    }

    return {
      version: 1,
      tocNonce,
      tocUserId,
      spcClientId,
      deviceFingerprint: input.challenge.deviceFingerprint,
      cookies: this.http.cookieJar.snapshot(),
      merchants,
      verifiedAt: Date.now(),
    };
  }

  /**
   * Whether Shopee still recognises the passport account session held in the
   * cookie jar. The dashboard token cookie carries a ~1000-day `exp` that says
   * nothing about the server-side session, so this is the only honest liveness
   * signal: while it answers `error:0` a merchant token can be re-minted
   * without a new OTP; once it answers `48500102` the account must log in again.
   */
  async accountSessionAlive(): Promise<boolean> {
    const response = await this.http.requestJson<
      ShopeeAccountEnvelope<{ userid?: number }>
    >({
      method: "POST",
      url: shopeeUrl(SHOPEE_ACCOUNT_BASE_URL, SHOPEE_ENDPOINTS.loginStatus),
      headers: this.accountHeaders(),
      body: {},
    });
    return response.error === 0;
  }

  async completeLogin(input: ShopeeCompleteLoginInput): Promise<ShopeeSession> {
    if (input.verification.version !== 1) {
      throw new ConfigError("Unsupported Shopee OTP verification version");
    }
    this.http.cookieJar.restore(input.verification.cookies);
    const merchant = selectMerchant(
      input.verification.merchants,
      input.merchantId,
    );
    if (!merchant.isActive || merchant.isBanned) {
      throw new AuthError(
        "AUTH_FAILED",
        "The selected Shopee merchant is inactive or banned",
      );
    }

    const tokenPage = new URL(
      SHOPEE_ENDPOINTS.accountLoginToken,
      SHOPEE_ACCOUNT_BASE_URL,
    );
    tokenPage.searchParams.set(
      "lang",
      this.locale.language ?? SHOPEE_DEFAULT_LANGUAGE,
    );
    tokenPage.searchParams.set("spc_clientid", input.verification.spcClientId);
    tokenPage.searchParams.set("state", partnerState());
    tokenPage.searchParams.set("tob_userid", String(merchant.staffUserId));
    tokenPage.searchParams.set(
      "next",
      shopeeUrl(SHOPEE_PARTNER_BASE_URL, SHOPEE_ENDPOINTS.accountTobAuth),
    );
    tokenPage.searchParams.set("client_id", SHOPEE_ACCOUNT_CLIENT_ID);
    tokenPage.searchParams.set("toc_nonce", input.verification.tocNonce);
    await this.http.followGet(tokenPage.toString());

    const login = await this.accountRequest<LoginTocData>(
      SHOPEE_ENDPOINTS.loginToc,
      {
        toc_nonce: input.verification.tocNonce,
        tob_userid: merchant.staffUserId,
        security_device_fingerprint: input.verification.deviceFingerprint,
      },
      input.verification.deviceFingerprint,
    );
    if (!login.nonce) {
      throw new AuthError(
        "AUTH_FAILED",
        "Shopee merchant login returned no authorization code",
      );
    }

    const exchangeUrl = new URL(
      SHOPEE_ENDPOINTS.accountTobAuth,
      SHOPEE_PARTNER_BASE_URL,
    );
    exchangeUrl.searchParams.set("code", login.nonce);
    exchangeUrl.searchParams.set(
      "lang",
      this.locale.language ?? SHOPEE_DEFAULT_LANGUAGE,
    );
    exchangeUrl.searchParams.set(
      "spc_clientid",
      input.verification.spcClientId,
    );
    exchangeUrl.searchParams.set("state", partnerState());
    await this.http.followGet(exchangeUrl.toString());

    const credential = readShopeeMerchantCredential(this.http.cookieJar);
    // The dashboard token identifies the staff (ToB) user it was minted for,
    // which is the `tob_userid` posted to `login_toc` - i.e. the selected
    // merchant's `staffUserId`. The token's `businessId` is the SSO
    // business_client_id (a constant `1`), never the Shopee merchant id, so it
    // must not be used to validate the merchant.
    if (
      credential.accountId !== undefined &&
      credential.accountId !== String(merchant.staffUserId)
    ) {
      throw new AuthError(
        "AUTH_FAILED",
        "Shopee returned a token for a different merchant",
      );
    }

    return {
      version: 1,
      cookies: this.http.cookieJar.snapshot(),
      accountId: credential.accountId,
      merchant,
      merchants: input.verification.merchants.map((entry) => ({ ...entry })),
      stores: [],
      storeId: input.storeId,
      createdAt: Date.now(),
      expiresAt: credential.expiresAt,
    };
  }

  private accountHeaders(riskToken?: string): Record<string, string> {
    const csrfToken = this.http.cookieJar.get(
      "csrftoken",
      SHOPEE_ACCOUNT_BASE_URL,
    );
    return {
      ...SHOPEE_BROWSER_HEADERS,
      Origin: SHOPEE_ACCOUNT_BASE_URL,
      Referer: shopeeLoginReferer(
        shopeeUrl(SHOPEE_PARTNER_BASE_URL, SHOPEE_ENDPOINTS.partnerLoginAuth),
      ),
      "X-App-Type": "2",
      ...(riskToken
        ? {
            "af-ac-enc-sz-token": riskToken,
            "x-sz-sdk-version": SHOPEE_SZ_SDK_VERSION,
          }
        : {}),
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Priority: "u=0",
    };
  }

  private async accountRequest<T>(
    path: string,
    body: unknown,
    riskToken?: string,
  ): Promise<T> {
    const response = await this.http.requestJson<ShopeeAccountEnvelope<T>>({
      method: "POST",
      url: shopeeUrl(SHOPEE_ACCOUNT_BASE_URL, path),
      headers: this.accountHeaders(riskToken),
      body,
    });
    return requireAccountData(response, path);
  }

  /**
   * The passport SPA posts the phone and password hash to this endpoint before
   * authenticating, purely as a lookup. The reference capture answers
   * `48401004` here yet still proceeds to `authenticate_toc_by_password`, so a
   * non-zero envelope is expected and must not abort the flow - only a
   * transport failure does. Sending the phone alone (no password) returns
   * `10002` (invalid params), which is why this must mirror the browser body.
   */
  private async checkAccountExists(
    phone: string,
    password: string | undefined,
    riskToken: string,
  ): Promise<void> {
    await this.http.requestJson<ShopeeAccountEnvelope<ExistByPasswordData>>({
      method: "POST",
      url: shopeeUrl(
        SHOPEE_ACCOUNT_BASE_URL,
        SHOPEE_ENDPOINTS.checkAccountExistByPassword,
      ),
      headers: this.accountHeaders(riskToken),
      body: {
        phone,
        password: password ? await hashShopeePassword(password) : "",
      },
    });
  }

  /**
   * Password-protected accounts only receive an OTP after this step accepts
   * the password - the reference capture answers `48401102` (NeedOTP), which
   * here counts as success. Skipping it leaves `send_otp` reporting success
   * while Shopee silently suppresses the delivery. Accounts without a
   * password skip the second factor entirely (`error:0`).
   */
  private async authenticateByPassword(
    phone: string,
    password: string | undefined,
    riskToken: string,
  ): Promise<boolean> {
    const path = SHOPEE_ENDPOINTS.authenticateByPassword;
    const response = await this.http.requestJson<
      ShopeeAccountEnvelope<AuthenticateByPasswordData>
    >({
      method: "POST",
      url: shopeeUrl(SHOPEE_ACCOUNT_BASE_URL, path),
      headers: this.accountHeaders(riskToken),
      body: {
        phone,
        password: password ? await hashShopeePassword(password) : "",
        security_device_fingerprint: riskToken,
      },
    });
    if (response.error === SHOPEE_AUTH_ERROR.NEED_OTP) {
      if (!password) {
        throw new ConfigError(PASSWORD_REQUIRED_MESSAGE);
      }
      return true;
    }
    if (response.error === 0) return false;
    if (response.data?.toc_account?.has_password === true) {
      throw new ConfigError(PASSWORD_REQUIRED_MESSAGE);
    }
    throw new AuthError(
      "AUTH_FAILED",
      `Shopee rejected the password before sending the OTP (error ${response.error ?? 0})`,
      {
        details: { provider: "shopee", endpoint: path },
      },
    );
  }
}

function normalizeMerchant(
  raw: RawMerchantSummary,
): ShopeeMerchantSummary | undefined {
  if (
    typeof raw.merchantId !== "number" ||
    typeof raw.staffTobUid !== "number"
  ) {
    return undefined;
  }
  return {
    id: String(raw.merchantId),
    name: raw.merchantName ?? "",
    status: numberOr(raw.merchantStatus, 0),
    staffUserId: raw.staffTobUid,
    staffRole: numberOr(raw.staffRole, 0),
    staffStatus: numberOr(raw.staffStatus, 0),
    isActive: raw.isActive === true,
    isBanned: raw.isBanned === true,
    isCurrentLoginUser: raw.isCurrentLoginUser === true,
  };
}

function selectMerchant(
  merchants: readonly ShopeeMerchantSummary[],
  requestedId?: string,
): ShopeeMerchantSummary {
  if (requestedId) {
    const selected = merchants.find((merchant) => merchant.id === requestedId);
    if (!selected) {
      throw new ConfigError("Configured Shopee merchantId is not accessible", {
        merchantId: requestedId,
        availableMerchants: merchants.map((merchant) => ({
          id: merchant.id,
          name: merchant.name,
        })),
      });
    }
    return selected;
  }

  const resolved = resolveSingleMerchant(merchants);
  if (resolved) return resolved;
  const usable = usableMerchants(merchants);
  throw new ConfigError(
    "merchantId is required when multiple Shopee merchants are accessible",
    {
      availableMerchants: usable.map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
      })),
    },
  );
}

/** Merchants a login can actually select: active and not banned. */
export function usableMerchants(
  merchants: readonly ShopeeMerchantSummary[],
): ShopeeMerchantSummary[] {
  return merchants.filter(
    (merchant) => merchant.isActive && !merchant.isBanned,
  );
}

/**
 * The single merchant a login can pick without a human, or `undefined` when the
 * choice is ambiguous. Mirrors {@link selectMerchant}'s no-`requestedId` branch
 * so callers can detect ambiguity before committing to a login.
 */
export function resolveSingleMerchant(
  merchants: readonly ShopeeMerchantSummary[],
): ShopeeMerchantSummary | undefined {
  const usable = usableMerchants(merchants);
  const current = usable.filter((merchant) => merchant.isCurrentLoginUser);
  if (current.length === 1) return current[0]!;
  if (usable.length === 1) return usable[0]!;
  return undefined;
}
