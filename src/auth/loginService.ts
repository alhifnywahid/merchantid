/**
 * Web-UI friendly wrapper around the two-step GoID login flow.
 *
 * The CLI drives login through terminal prompts. `LoginService` exposes the
 * same flow as plain awaitable steps plus optional callbacks, so a React, Vue,
 * or Next.js front end (or a backend route serving one) can build its own
 * login screen without shelling out to the CLI.
 */

import { GopayProvider } from "../providers/gopay/gopayProvider.js";
import type { FetchLike } from "../http/httpClient.js";
import type { LoginRequestResult, SessionState } from "../core/types.js";

export interface LoginServiceConfig {
  /** A configured `GopayProvider` instance to drive the flow. */
  gopay: GopayProvider;
  /**
   * Custom fetch for probes that construct their own `GopayProvider`
   * internally ({@link LoginService.validateSession}). Without it those
   * probes fall back to the runtime's global `fetch`, even when the main
   * instance was built with an injected one - on runtimes without a global
   * `fetch` that turns a session check into a `ConfigError`.
   */
  fetch?: FetchLike;
  /** Invoked once the OTP has been dispatched to the phone number. */
  onOtpSent?: (phone: string, countryCode: string) => void | Promise<void>;
  /** Invoked after a successful login, with the session to persist. */
  onLoginSuccess?: (session: SessionState) => void | Promise<void>;
  /** Invoked when a step fails, with the step that failed. */
  onError?: (error: Error, step: LoginStep) => void | Promise<void>;
}

/** The stage of the login flow an error originated from. */
export type LoginStep = "request-otp" | "verify-otp" | "fetch-merchants";

export interface OtpRequestPayload {
  phoneNumber: string;
  /** Defaults to Indonesia (`"62"`). */
  countryCode?: string;
}

export interface OtpVerifyPayload {
  otp: string;
  /**
   * The token returned by {@link LoginService.requestOtp}. Falls back to the
   * value remembered from the preceding `requestOtp` call on this instance.
   */
  otpToken: string;
  phoneNumber?: string;
  countryCode?: string;
}

/** Condensed merchant view returned alongside a successful login. */
export interface LoginMerchantSummary {
  id: string;
  merchantName: string;
  outletName: string;
  qrString?: string;
}

export interface LoginResult {
  success: boolean;
  /**
   * Present on success. Contains access and refresh tokens, so treat it as a
   * credential: persist it encrypted or in a secret store, never expose it to
   * a browser.
   */
  session?: SessionState;
  /** Absent when the merchant lookup failed; login itself still succeeded. */
  merchants?: LoginMerchantSummary[];
  /** Present on failure. */
  error?: string;
}

/**
 * Drives the login flow step by step.
 *
 * ```typescript
 * const loginService = new LoginService({ gopay: new GopayProvider() });
 *
 * // Step 1: send the OTP.
 * const { otpToken } = await loginService.requestOtp({
 *   phoneNumber: "81234567890",
 * });
 *
 * // Step 2: verify it and receive the session.
 * const result = await loginService.verifyOtpAndLogin({
 *   otp: "123456",
 *   otpToken: otpToken ?? "",
 * });
 *
 * if (result.success) {
 *   await saveSession(result.session);
 * }
 * ```
 */
export class LoginService {
  private readonly gopay: GopayProvider;
  private readonly config: LoginServiceConfig;
  private currentOtpToken?: string;
  private currentPhone?: string;

  constructor(config: LoginServiceConfig) {
    this.gopay = config.gopay;
    this.config = config;
  }

  /**
   * Step 1: send an OTP to the given phone number.
   *
   * The returned `otpToken` must be passed to
   * {@link LoginService.verifyOtpAndLogin}. It is also remembered on this
   * instance so single-instance flows may omit it.
   */
  async requestOtp(payload: OtpRequestPayload): Promise<LoginRequestResult> {
    const { phoneNumber, countryCode = "62" } = payload;

    try {
      const result = await this.gopay.requestOtp(phoneNumber, countryCode);

      this.currentOtpToken = result.otpToken;
      this.currentPhone = phoneNumber;

      await this.config.onOtpSent?.(phoneNumber, countryCode);
      return result;
    } catch (error) {
      await this.config.onError?.(error as Error, "request-otp");
      throw error;
    }
  }

  /**
   * Step 2: verify the OTP, then export the session and the accessible
   * merchants.
   *
   * Unlike {@link LoginService.requestOtp}, this never throws: failures are
   * reported through the returned {@link LoginResult} so a UI can render the
   * message directly.
   */
  async verifyOtpAndLogin(payload: OtpVerifyPayload): Promise<LoginResult> {
    const { otp, otpToken, phoneNumber, countryCode } = payload;

    try {
      await this.gopay.verifyOtp({
        otp,
        otpToken: otpToken || this.currentOtpToken || "",
        phoneNumber: phoneNumber || this.currentPhone,
        countryCode,
      });

      const session = this.gopay.exportSession();
      const merchants = await this.collectMerchantSummaries();

      await this.config.onLoginSuccess?.(session);

      // The OTP challenge is single-use; drop it so it cannot be replayed.
      this.currentOtpToken = undefined;
      this.currentPhone = undefined;

      return { success: true, session, merchants };
    } catch (error) {
      await this.config.onError?.(error as Error, "verify-otp");
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check whether a stored session still authenticates, without disturbing the
   * state of the instance this service was constructed with.
   *
   * Returns `false` for *any* failure, so a rejected session and an unreachable
   * network are indistinguishable here by design - the probe answers one
   * question ("can this session be used right now?") and a timeout is a
   * legitimate "no". Callers that must tell the two apart should make a real
   * request and inspect the thrown `AuthError` / `HttpError` instead of
   * treating `false` as proof that the credentials are dead.
   */
  async validateSession(session: SessionState): Promise<boolean> {
    try {
      const probe = new GopayProvider({ session, fetch: this.config.fetch });
      await probe.listMerchants();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the merchants the account can access. Returns `undefined` when the
   * lookup fails, which is not fatal: login has already succeeded at this point
   * and the data can be fetched again later.
   */
  private async collectMerchantSummaries(): Promise<
    LoginMerchantSummary[] | undefined
  > {
    try {
      const merchants = await this.gopay.listMerchants();
      if (merchants.length > 0) {
        return merchants.map((merchant) => ({
          id: merchant.id,
          merchantName: merchant.merchantName,
          outletName: merchant.outletName ?? "",
          qrString: merchant.qrString,
        }));
      }

      // `/merchants/search` returns nothing for some accounts; fall back to the
      // single merchant resolved from the authenticated user profile.
      const profile = await this.gopay
        .getMerchantProfile()
        .catch(() => undefined);
      if (!profile) return undefined;

      return [
        {
          id: profile.id,
          merchantName: profile.merchantName,
          outletName: profile.outletName ?? "",
          qrString: profile.outlets.find((outlet) => outlet.qrString)?.qrString,
        },
      ];
    } catch (error) {
      await this.config.onError?.(error as Error, "fetch-merchants");
      return undefined;
    }
  }
}

/**
 * Create a {@link LoginService} with minimal configuration, defaulting to a
 * fresh unauthenticated {@link GopayProvider} when none is supplied.
 */
export function createLoginService(
  config?: Partial<LoginServiceConfig>,
): LoginService {
  return new LoginService({
    ...config,
    // Forward the injected fetch: HttpClient resolves the global fetch
    // eagerly in its constructor, so on a fetch-less runtime an unforwarded
    // default GopayProvider would throw ConfigError despite the caller
    // having supplied an implementation.
    gopay: config?.gopay ?? new GopayProvider({ fetch: config?.fetch }),
  });
}
