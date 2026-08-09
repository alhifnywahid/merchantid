import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient } from "../../../../src/api/authClient.js";
import { HttpClient, type FetchLike } from "../../../../src/http/httpClient.js";
import { TokenManager } from "../../../../src/core/tokenManager.js";
import { ApiError, AuthError, HttpError } from "../../../../src/core/errors.js";
import {
  DEFAULT_GOID_CLIENT_ID,
  ENDPOINTS,
} from "../../../../src/core/constants.js";
import type { TokenSet } from "../../../../src/core/types.js";

const BASE = "https://api.test";

/** Minimal Response stand-in: HttpClient only reads `status` and `text()`. */
function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

/**
 * Queue a scripted sequence of responses and record the requests made.
 * Extends the httpClient.test.ts helper with method and parsed JSON body so
 * the exact wire format of each auth call can be asserted.
 */
function scriptedFetch(replies: Response[]): {
  fetch: FetchLike;
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
} {
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  let index = 0;

  const fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      // Snapshot: the client reuses and mutates the same headers object on retry.
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    const next = replies[index++];
    if (!next) throw new Error("scriptedFetch: no reply left for this request");
    return next;
  }) as unknown as FetchLike;

  return { fetch, requests };
}

/** AuthClient over a real HttpClient with a scripted fetch. */
function makeAuthClient(
  replies: Response[],
  options?: { clientId?: string },
): {
  auth: AuthClient;
  requests: ReturnType<typeof scriptedFetch>["requests"];
} {
  const { fetch, requests } = scriptedFetch(replies);
  const http = new HttpClient({ baseUrl: BASE, fetch });
  return { auth: new AuthClient(http, options), requests };
}

/**
 * AuthClient wired to an HttpClient that HAS a token manager. Used to prove
 * the auth endpoints opt out of the 401 refresh-and-retry loop: a refresh
 * triggered from inside the token endpoint would deadlock on its own
 * in-flight refresh promise (see skipAuthRetry in httpClient.ts).
 */
function makeManagedAuthClient(replies: Response[]): {
  auth: AuthClient;
  requests: ReturnType<typeof scriptedFetch>["requests"];
  refresher: { calls: number };
} {
  const { fetch, requests } = scriptedFetch(replies);
  const refresher = {
    calls: 0,
    async refresh(): Promise<TokenSet> {
      refresher.calls += 1;
      throw new Error("refresh must not be reached from an auth endpoint");
    },
  };
  const manager = new TokenManager(refresher, {
    accessToken: "token-stale",
    refreshToken: "refresh-original",
    tokenType: "Bearer",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const http = new HttpClient({ baseUrl: BASE, fetch, tokenManager: manager });
  return { auth: new AuthClient(http), requests, refresher };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthClient.requestOtp", () => {
  it("POSTs the normalized phone number and default client id to the login-request endpoint", async () => {
    const { auth, requests } = makeAuthClient([
      reply(200, { success: true, data: { otp_token: "otp-abc" } }),
    ]);

    await auth.requestOtp("0812-3456-789");

    const request = requests[0]!;
    expect(request.url).toBe(`${BASE}${ENDPOINTS.loginRequest}`);
    expect(request.method).toBe("POST");
    // Non-digits and leading zeros are stripped; GoID expects the bare
    // national number alongside the separate country_code field.
    expect(request.body).toEqual({
      client_id: DEFAULT_GOID_CLIENT_ID,
      phone_number: "8123456789",
      country_code: "62",
    });
    // A literal "Bearer" (no token) is what the unauthenticated GoID
    // endpoints expect; the body is JSON-encoded.
    expect(request.headers.Authorization).toBe("Bearer");
    expect(request.headers["Content-Type"]).toBe("application/json");
  });

  it("extracts otpToken from otp_token and preserves the raw envelope", async () => {
    const envelope = { success: true, data: { otp_token: "otp-abc" } };
    const { auth } = makeAuthClient([reply(200, envelope)]);

    const result = await auth.requestOtp("81234");

    expect(result.otpToken).toBe("otp-abc");
    expect(result.raw).toEqual(envelope);
  });

  it("falls back to the token field when otp_token is absent", async () => {
    const { auth } = makeAuthClient([
      reply(200, { success: true, data: { token: "legacy-token" } }),
    ]);

    const result = await auth.requestOtp("81234");

    expect(result.otpToken).toBe("legacy-token");
  });

  it("returns undefined otpToken when the envelope carries no data", async () => {
    const envelope = { success: true, data: null };
    const { auth } = makeAuthClient([reply(200, envelope)]);

    const result = await auth.requestOtp("81234");

    expect(result.otpToken).toBeUndefined();
    expect(result.raw).toEqual(envelope);
  });

  it("sends a custom clientId and country code when provided", async () => {
    const { auth, requests } = makeAuthClient(
      [reply(200, { success: true, data: {} })],
      { clientId: "rotated-client" },
    );

    await auth.requestOtp("91234", "65");

    expect(requests[0]?.body).toEqual({
      client_id: "rotated-client",
      phone_number: "91234",
      country_code: "65",
    });
  });

  it("throws ApiError carrying the first API error detail on success:false", async () => {
    const envelope = {
      success: false,
      data: null,
      errors: [
        {
          code: "GoIdError:TooManyRequests",
          message: "Too many OTP requests",
          message_title: "Slow down",
        },
      ],
    };
    const { auth } = makeAuthClient([reply(200, envelope)]);

    const error = await auth.requestOtp("81234").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "API_ERROR",
      apiCode: "GoIdError:TooManyRequests",
      message: "Failed to request OTP: Too many OTP requests",
    });
    // The whole envelope rides along for diagnostics.
    expect((error as ApiError).details).toEqual({ response: envelope });
  });

  it("falls back to message_title, then code, when message is missing", async () => {
    const { auth } = makeAuthClient([
      reply(200, {
        success: false,
        data: null,
        errors: [{ message_title: "Batas percobaan" }],
      }),
      reply(200, {
        success: false,
        data: null,
        errors: [{ code: "GoIdError:1010" }],
      }),
    ]);

    await expect(auth.requestOtp("81234")).rejects.toThrow(
      "Failed to request OTP: Batas percobaan",
    );
    await expect(auth.requestOtp("81234")).rejects.toThrow(
      "Failed to request OTP: GoIdError:1010",
    );
  });

  it("stringifies the envelope when success:false carries no error entries", async () => {
    const { auth } = makeAuthClient([
      reply(200, { success: false, data: null, errors: [] }),
    ]);

    const error = await auth.requestOtp("81234").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    // With no error entry to quote, the raw JSON is the only detail available.
    expect((error as ApiError).message).toContain('"success":false');
  });

  it("surfaces a non-2xx response as HttpError", async () => {
    const { auth } = makeAuthClient([reply(429, { error: "rate limited" })]);

    await expect(auth.requestOtp("81234")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 429,
    });
  });

  it("does not attempt a token refresh when the login request gets a 401", async () => {
    const { auth, requests, refresher } = makeManagedAuthClient([
      reply(401, { error: "unauthorized" }),
    ]);

    await expect(auth.requestOtp("81234")).rejects.toMatchObject({
      status: 401,
    });
    expect(refresher.calls).toBe(0);
    expect(requests).toHaveLength(1);
  });
});

describe("AuthClient.verifyOtp", () => {
  it("exchanges the OTP nested under data and does not resend the phone number", async () => {
    const { auth, requests } = makeAuthClient([
      reply(200, { access_token: "a-1", refresh_token: "r-1" }),
    ]);

    await auth.verifyOtp({
      otp: "123456",
      otpToken: "otp-abc",
      // Accepted for API symmetry only; the exact body assertion below
      // proves neither field leaks into the token request.
      phoneNumber: "81234",
      countryCode: "62",
    });

    const request = requests[0]!;
    expect(request.url).toBe(`${BASE}${ENDPOINTS.token}`);
    expect(request.method).toBe("POST");
    expect(request.headers.Authorization).toBe("Bearer");
    expect(request.body).toEqual({
      client_id: DEFAULT_GOID_CLIENT_ID,
      data: { otp: "123456", otp_token: "otp-abc" },
      grant_type: "otp",
    });
  });

  it("normalizes the token payload into a TokenSet with an absolute expiry", async () => {
    // Freeze the clock so expires_in -> expiresAt conversion is exact.
    const NOW = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { auth } = makeAuthClient([
      reply(200, {
        access_token: "a-1",
        refresh_token: "r-1",
        token_type: "GoBearer",
        expires_in: 3600,
      }),
    ]);

    await expect(
      auth.verifyOtp({ otp: "123456", otpToken: "otp-abc" }),
    ).resolves.toEqual({
      accessToken: "a-1",
      refreshToken: "r-1",
      tokenType: "GoBearer",
      expiresAt: NOW + 3600 * 1000,
    });
  });

  it("defaults tokenType to Bearer and omits expiresAt when the payload lacks them", async () => {
    const { auth } = makeAuthClient([reply(200, { access_token: "a-1" })]);

    const tokens = await auth.verifyOtp({ otp: "123456", otpToken: "otp-abc" });

    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresAt).toBeUndefined();
    // The verify response should normally include refresh_token; when it does
    // not, the normalized set degrades to an empty string rather than crashing.
    expect(tokens.refreshToken).toBe("");
  });

  it("rejects an empty otpToken locally before hitting the network", async () => {
    const { auth, requests } = makeAuthClient([]);

    const error = await auth
      .verifyOtp({ otp: "123456", otpToken: "" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(requests).toHaveLength(0);
  });

  it("throws AUTH_FAILED when the token response has no access token", async () => {
    const { auth } = makeAuthClient([reply(200, { success: false })]);

    const error = await auth
      .verifyOtp({ otp: "123456", otpToken: "otp-abc" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("surfaces an invalid OTP (HTTP 400) as HttpError", async () => {
    const { auth } = makeAuthClient([
      reply(400, { error: "invalid_grant", error_description: "wrong otp" }),
    ]);

    const error = await auth
      .verifyOtp({ otp: "000000", otpToken: "otp-abc" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: "HTTP_ERROR",
      status: 400,
      body: { error: "invalid_grant", error_description: "wrong otp" },
    });
  });
});

describe("AuthClient.refresh", () => {
  // Regression guard for the defect that made refresh fail against the live
  // API for every release before 0.5.1: the refresh token must be NESTED under
  // `data`, exactly like the OTP grant. A flat top-level `refresh_token` is
  // answered with 401 goid:error:unauthorized - a generic message that reads
  // like a lapsed token, which is why the real cause stayed hidden. Verified
  // against the live endpoint: nested returns 201, flat never succeeds.
  it("nests the refresh token under data, like the otp grant", async () => {
    const { auth, requests } = makeAuthClient([
      reply(200, { access_token: "a-2" }),
    ]);

    await auth.refresh("refresh-1");

    const request = requests[0]!;
    expect(request.url).toBe(`${BASE}${ENDPOINTS.token}`);
    expect(request.method).toBe("POST");
    // The bearer stays empty: the endpoint does not need it, and depending on
    // it would make reactive refresh after a 401 impossible.
    expect(request.headers.Authorization).toBe("Bearer");
    expect(request.body).toEqual({
      client_id: DEFAULT_GOID_CLIENT_ID,
      data: { refresh_token: "refresh-1" },
      grant_type: "refresh_token",
    });
  });

  it("falls back to the original refresh token when the endpoint omits one", async () => {
    const { auth } = makeAuthClient([
      reply(200, { access_token: "a-2", expires_in: 900 }),
    ]);

    const tokens = await auth.refresh("refresh-1");

    expect(tokens.accessToken).toBe("a-2");
    expect(tokens.refreshToken).toBe("refresh-1");
  });

  // The live endpoint DOES return a fresh refresh token on every refresh.
  // Earlier releases discarded it and pinned the original, which only survived
  // because the old token happens to stay valid; adopting the server's value
  // is what keeps a long-lived session correct if that ever tightens.
  it("adopts the refresh token the endpoint returns", async () => {
    const { auth } = makeAuthClient([
      reply(200, { access_token: "a-2", refresh_token: "server-rotated" }),
    ]);

    const tokens = await auth.refresh("refresh-1");

    expect(tokens.refreshToken).toBe("server-rotated");
  });

  it("does not re-enter the token manager on 401 (refresh deadlock guard)", async () => {
    // Regression guard: without skipAuthRetry, a 401 from the token endpoint
    // would call TokenManager.forceRefresh, which is already awaiting this
    // very request, and both sides would wait on the same in-flight promise.
    const { auth, requests, refresher } = makeManagedAuthClient([
      reply(401, { error: "invalid refresh token" }),
    ]);

    await expect(auth.refresh("refresh-dead")).rejects.toMatchObject({
      status: 401,
    });
    expect(refresher.calls).toBe(0);
    expect(requests).toHaveLength(1);
  });
});
