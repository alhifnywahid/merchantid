import type { HttpClient } from "../http/httpClient.js";
import { DEFAULT_GOID_CLIENT_ID, ENDPOINTS } from "../core/constants.js";
import { ApiError, AuthError } from "../core/errors.js";
import type {
  LoginRequestResult,
  TokenRefresher,
  TokenSet,
} from "../core/types.js";

interface GoIdEnvelope<T> {
  data: T | null;
  success: boolean;
  errors?: Array<{ code?: string; message?: string; message_title?: string }>;
}

interface TokenPayload {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
}

export interface AuthClientOptions {
  clientId?: string;
}

/**
 * Wraps the GoID authentication endpoints used by the merchant dashboard:
 * OTP request, OTP verification (token exchange), token refresh, and logout.
 */
export class AuthClient implements TokenRefresher {
  private readonly http: HttpClient;
  private readonly clientId: string;

  constructor(http: HttpClient, options: AuthClientOptions = {}) {
    this.http = http;
    this.clientId = options.clientId ?? DEFAULT_GOID_CLIENT_ID;
  }

  /** Request an OTP challenge for a phone number. */
  async requestOtp(
    phoneNumber: string,
    countryCode = "62",
  ): Promise<LoginRequestResult> {
    const raw = await this.http.requestJson<
      GoIdEnvelope<Record<string, unknown>>
    >({
      method: "POST",
      path: ENDPOINTS.loginRequest,
      headers: { Authorization: "Bearer" },
      skipAuthRetry: true,
      body: {
        client_id: this.clientId,
        phone_number: normalizePhone(phoneNumber),
        country_code: countryCode,
      },
    });

    this.assertSuccess(raw, "Failed to request OTP");

    const data = raw.data ?? {};
    return {
      otpToken:
        (data["otp_token"] as string | undefined) ??
        (data["token"] as string | undefined),
      raw,
    };
  }

  /**
   * Exchange an OTP for an access/refresh token pair.
   *
   * The GoID token endpoint expects the OTP challenge fields nested under a
   * `data` object and identified by the `otp_token` returned from
   * {@link requestOtp}. The phone number is not resent here.
   */
  async verifyOtp(params: {
    otp: string;
    otpToken: string;
    /** Accepted for API symmetry; not sent to the token endpoint. */
    phoneNumber?: string;
    countryCode?: string;
  }): Promise<TokenSet> {
    if (!params.otpToken) {
      throw new AuthError(
        "AUTH_FAILED",
        "otpToken is required. Pass the value returned by requestOtp().",
      );
    }

    const raw = await this.http.requestJson<TokenPayload>({
      method: "POST",
      path: ENDPOINTS.token,
      headers: { Authorization: "Bearer" },
      skipAuthRetry: true,
      body: {
        client_id: this.clientId,
        data: {
          otp: params.otp,
          otp_token: params.otpToken,
        },
        grant_type: "otp",
      },
    });

    return this.toTokenSet(raw);
  }

  /**
   * Obtain a fresh access token from a refresh token.
   *
   * The refresh token goes **nested under `data`**, exactly like the OTP
   * fields in {@link verifyOtp}. A flat `refresh_token` at the top level is
   * rejected with `401 goid:error:unauthorized` - a generic message that looks
   * like a lapsed token rather than a malformed request, which is why this was
   * mistaken for expiry for so long. Verified against the live endpoint: the
   * nested form answers `201` with a new pair, the flat form never succeeds.
   *
   * The bearer header is deliberately empty. It is not required here (confirmed
   * against the live endpoint), and leaving it out keeps reactive refresh
   * possible: after a `401` the current access token is worthless, so a refresh
   * that depended on it could never recover a session.
   */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const raw = await this.http.requestJson<TokenPayload>({
      method: "POST",
      path: ENDPOINTS.token,
      // Never let a 401 here re-enter the token manager: it is already awaiting
      // this request, so the retry would deadlock on its own refresh promise.
      headers: { Authorization: "Bearer" },
      skipAuthRetry: true,
      body: {
        client_id: this.clientId,
        data: {
          refresh_token: refreshToken,
        },
        grant_type: "refresh_token",
      },
    });

    // The endpoint does return a new refresh token. Adopt it when present -
    // the old one currently keeps working, but persisting the server's latest
    // is what keeps a long-lived session correct if that ever changes.
    const tokens = this.toTokenSet(raw);
    return {
      ...tokens,
      refreshToken: tokens.refreshToken || refreshToken,
    };
  }

  private toTokenSet(payload: TokenPayload | null): TokenSet {
    if (!payload?.access_token) {
      throw new AuthError("AUTH_FAILED", "Token response missing access token");
    }

    // For OTP verification, refresh_token is required
    // For refresh endpoint, refresh_token may be missing (caller will preserve it)
    const refreshToken = payload.refresh_token ?? "";

    return {
      accessToken: payload.access_token,
      refreshToken,
      tokenType: payload.token_type ?? "Bearer",
      expiresAt:
        typeof payload.expires_in === "number"
          ? Date.now() + payload.expires_in * 1_000
          : undefined,
    };
  }

  private assertSuccess(raw: GoIdEnvelope<unknown>, context: string): void {
    if (raw.success) return;
    const first = raw.errors?.[0];
    const detail =
      first?.message ??
      first?.message_title ??
      first?.code ??
      JSON.stringify(raw);
    throw new ApiError(`${context}: ${detail}`, {
      apiCode: first?.code,
      details: { response: raw },
    });
  }
}

/** Strip leading zeros and country code artifacts from a local phone number. */
function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "").replace(/^0+/, "");
}
