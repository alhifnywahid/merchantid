import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LoginService,
  createLoginService,
} from "../../../../src/auth/loginService.js";
import type { LoginStep } from "../../../../src/auth/loginService.js";
import { GopayProvider } from "../../../../src/providers/gopay/gopayProvider.js";
import type { FetchLike } from "../../../../src/http/httpClient.js";
import type { SessionState } from "../../../../src/core/types.js";

const HOUR = 60 * 60 * 1000;

/** Minimal Response stand-in: HttpClient only reads `status` and `text()`. */
function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Queue a scripted sequence of responses and record the requests made.
 * Mirrors the helper in httpClient.test.ts, extended to also capture the
 * request body so tests can assert which otp_token was actually sent.
 */
function scriptedFetch(replies: Response[]): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      // Snapshot: the client reuses and mutates the same headers object on retry.
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = replies[index++];
    if (!next) throw new Error("scriptedFetch: no reply left for this request");
    return next;
  }) as unknown as FetchLike;

  return { fetch, requests };
}

// --- Scripted GoBiz responses for each step of the login flow -------------

function otpRequestReply(): Response {
  return reply(200, { success: true, data: { otp_token: "otp-token-1" } });
}

function tokenReply(): Response {
  return reply(200, {
    access_token: "access-1",
    refresh_token: "refresh-1",
    token_type: "Bearer",
    expires_in: 3600,
  });
}

function usersMeReply(): Response {
  return reply(200, { user: { merchant_id: "G123" } });
}

/** Shared merchant payload for both `/v1/merchants/:id` and the search index. */
const MERCHANT_HIT = {
  id: "G123",
  merchant_name: "Warung Atmos",
  outlet_name: "Pusat",
  pops: [{ pop_id: "P1", gopay: { aspi_qr_string: "QRIS-STATIC" } }],
};

function merchantDetailReply(): Response {
  return reply(200, MERCHANT_HIT);
}

function merchantSearchReply(): Response {
  return reply(200, { hits: [MERCHANT_HIT] });
}

/**
 * A LoginService driving a real GopayProvider whose only fake is the injected
 * fetch, plus recorders for every callback the service can fire.
 */
function makeLoginService(replies: Response[]): {
  service: LoginService;
  requests: RecordedRequest[];
  otpSent: Array<{ phone: string; countryCode: string }>;
  sessions: SessionState[];
  errors: Array<{ message: string; step: LoginStep }>;
} {
  const { fetch, requests } = scriptedFetch(replies);
  const otpSent: Array<{ phone: string; countryCode: string }> = [];
  const sessions: SessionState[] = [];
  const errors: Array<{ message: string; step: LoginStep }> = [];

  const service = new LoginService({
    gopay: new GopayProvider({ fetch }),
    onOtpSent: (phone, countryCode) => {
      otpSent.push({ phone, countryCode });
    },
    onLoginSuccess: (session) => {
      sessions.push(session);
    },
    onError: (error, step) => {
      errors.push({ message: error.message, step });
    },
  });

  return { service, requests, otpSent, sessions, errors };
}

function pathsOf(requests: RecordedRequest[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

describe("LoginService.verifyOtpAndLogin", () => {
  // The JSDoc promises "this never throws" so a UI can render the message
  // directly. No test guarded that promise before; these two lock it for the
  // two real-world failure shapes of the token endpoint.
  it("resolves { success: false, error } instead of throwing when the token exchange returns HTTP 500", async () => {
    const { service, requests, sessions, errors } = makeLoginService([
      reply(500, { error: "boom" }),
    ]);

    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "challenge-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("/goid/token");
    expect(result.session).toBeUndefined();
    expect(result.merchants).toBeUndefined();

    // The failure stops at the token exchange: nothing else was requested,
    // no session was announced, and the failing step is reported.
    expect(pathsOf(requests)).toEqual(["/goid/token"]);
    expect(sessions).toHaveLength(0);
    expect(errors).toEqual([
      { message: expect.stringContaining("/goid/token"), step: "verify-otp" },
    ]);
  });

  it("resolves { success: false, error } when the endpoint answers 200 with success:false (no access token)", async () => {
    // GoID reports a rejected OTP as HTTP 200 with a success:false envelope,
    // which AuthClient surfaces as "missing access token". The service must
    // still convert that rejection into a result, never a thrown error.
    const { service, errors } = makeLoginService([
      reply(200, { success: false, data: null }),
    ]);

    const result = await service.verifyOtpAndLogin({
      otp: "000000",
      otpToken: "challenge-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Token response missing access token");
    expect(errors[0]?.step).toBe("verify-otp");
  });

  it("returns { success: true, session, merchants } and fires onLoginSuccess on the happy path", async () => {
    const { service, requests, otpSent, sessions, errors } = makeLoginService([
      otpRequestReply(),
      tokenReply(),
      usersMeReply(),
      merchantDetailReply(),
      merchantSearchReply(),
    ]);

    const { otpToken } = await service.requestOtp({
      phoneNumber: "081234567890",
    });
    expect(otpToken).toBe("otp-token-1");
    // The default country code is Indonesia.
    expect(otpSent).toEqual([{ phone: "081234567890", countryCode: "62" }]);

    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: otpToken ?? "",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.session?.tokens.accessToken).toBe("access-1");
    expect(result.session?.tokens.refreshToken).toBe("refresh-1");
    expect(result.session?.deviceId).toBeTruthy();
    expect(result.merchants).toEqual([
      {
        id: "G123",
        merchantName: "Warung Atmos",
        outletName: "Pusat",
        qrString: "QRIS-STATIC",
      },
    ]);

    // onLoginSuccess received the same session that was returned.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokens.accessToken).toBe("access-1");
    expect(errors).toEqual([]);

    // Lock the exact request sequence the flow makes against the private API.
    expect(pathsOf(requests)).toEqual([
      "/goid/login/request",
      "/goid/token",
      "/v1/users/me",
      "/v1/merchants/G123",
      "/v1/merchants/search",
    ]);
    // Requests after the exchange must carry the freshly issued bearer.
    expect(requests[2]?.headers.Authorization).toBe("Bearer access-1");
  });

  it("falls back to the otpToken remembered from requestOtp when given an empty one", async () => {
    const { service, requests } = makeLoginService([
      otpRequestReply(),
      tokenReply(),
      usersMeReply(),
      merchantDetailReply(),
      merchantSearchReply(),
    ]);

    await service.requestOtp({ phoneNumber: "081234567890" });
    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "",
    });

    expect(result.success).toBe(true);

    // The token exchange must have been sent with the remembered challenge,
    // not the empty string the caller passed.
    const tokenRequest = requests[1];
    expect(tokenRequest?.url).toContain("/goid/token");
    const body = JSON.parse(tokenRequest?.body ?? "{}") as {
      grant_type?: string;
      data?: { otp?: string; otp_token?: string };
    };
    expect(body.grant_type).toBe("otp");
    expect(body.data?.otp).toBe("123456");
    expect(body.data?.otp_token).toBe("otp-token-1");
  });

  it("clears the remembered otpToken after a successful login (single-use)", async () => {
    const { service, requests, errors } = makeLoginService([
      otpRequestReply(),
      tokenReply(),
      usersMeReply(),
      merchantDetailReply(),
      merchantSearchReply(),
    ]);

    await service.requestOtp({ phoneNumber: "081234567890" });
    const first = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "",
    });
    expect(first.success).toBe(true);

    // The OTP challenge is single-use; a replay with an empty otpToken must
    // not silently reuse the consumed one. AuthClient rejects the empty token
    // before any request goes out, so the request count must not grow.
    const requestsAfterLogin = requests.length;
    const replay = await service.verifyOtpAndLogin({
      otp: "654321",
      otpToken: "",
    });

    expect(replay.success).toBe(false);
    expect(replay.error).toContain("otpToken is required");
    expect(requests).toHaveLength(requestsAfterLogin);
    expect(errors.at(-1)?.step).toBe("verify-otp");
  });

  it("still succeeds with merchants undefined when the merchant search fails, reporting fetch-merchants", async () => {
    const { service, sessions, errors } = makeLoginService([
      tokenReply(),
      usersMeReply(),
      merchantDetailReply(),
      reply(500, { error: "search down" }),
    ]);

    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "challenge-1",
    });

    // Login itself succeeded; the merchant lookup is documented as non-fatal
    // and can be retried later, so `merchants` is simply absent.
    expect(result.success).toBe(true);
    expect(result.session?.tokens.accessToken).toBe("access-1");
    expect(result.merchants).toBeUndefined();
    expect(sessions).toHaveLength(1);
    expect(errors).toEqual([
      {
        message: expect.stringContaining("/v1/merchants/search"),
        step: "fetch-merchants",
      },
    ]);
  });

  it("falls back to the merchant profile when the search index returns no hits", async () => {
    // `/merchants/search` returns nothing for some accounts; the service then
    // derives a single summary from the merchant resolved via /v1/users/me.
    const { service, errors } = makeLoginService([
      tokenReply(),
      usersMeReply(),
      merchantDetailReply(), // resolveStaticQris during verifyOtp
      reply(200, { hits: [] }),
      merchantDetailReply(), // getMerchantProfile fallback
    ]);

    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "challenge-1",
    });

    expect(result.success).toBe(true);
    expect(result.merchants).toEqual([
      {
        id: "G123",
        merchantName: "Warung Atmos",
        outletName: "Pusat",
        qrString: "QRIS-STATIC",
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("survives a /v1/users/me failure because GopayProvider swallows it", async () => {
    // resolveMerchantId failures are deliberately swallowed inside
    // GopayProvider so login never breaks on the profile probe. With no
    // merchant id resolved, the static-QRIS fetch is skipped entirely and the
    // flow proceeds straight to the merchant search.
    const { service, requests, errors } = makeLoginService([
      tokenReply(),
      reply(500, { error: "profile down" }),
      merchantSearchReply(),
    ]);

    const result = await service.verifyOtpAndLogin({
      otp: "123456",
      otpToken: "challenge-1",
    });

    expect(result.success).toBe(true);
    expect(result.merchants).toHaveLength(1);
    expect(pathsOf(requests)).toEqual([
      "/goid/token",
      "/v1/users/me",
      "/v1/merchants/search",
    ]);
    // The swallowed failure must not surface through onError either.
    expect(errors).toEqual([]);
  });
});

describe("LoginService.requestOtp", () => {
  it("fires onError with step request-otp and rethrows when the OTP dispatch fails", async () => {
    // Unlike verifyOtpAndLogin, requestOtp is documented to throw; the
    // callback contract is that onError still reports the failing step first.
    const { service, otpSent, errors } = makeLoginService([
      reply(200, { success: false, errors: [{ message: "phone blocked" }] }),
    ]);

    await expect(
      service.requestOtp({ phoneNumber: "081234567890" }),
    ).rejects.toThrow("phone blocked");

    expect(otpSent).toHaveLength(0);
    expect(errors).toEqual([
      {
        message: expect.stringContaining("phone blocked"),
        step: "request-otp",
      },
    ]);
  });
});

describe("createLoginService", () => {
  // Regression guard: the factory used to build its default GopayProvider
  // without forwarding config.fetch, which threw ConfigError on fetch-less
  // runtimes and silently bypassed injected fetches everywhere else.
  it("forwards the injected fetch to its default GopayProvider", async () => {
    const { fetch, requests } = scriptedFetch([otpRequestReply()]);
    const service = createLoginService({ fetch });

    const result = await service.requestOtp({ phoneNumber: "081234567890" });

    expect(result.otpToken).toBe("otp-token-1");
    // The scripted fetch recorded the call, proving the default GopayProvider
    // was built with the injected implementation, not the global one.
    expect(pathsOf(requests)).toEqual(["/goid/login/request"]);
  });
});

describe("LoginService.validateSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function storedSession(): SessionState {
    return {
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        tokenType: "Bearer",
        expiresAt: Date.now() + HOUR,
      },
      deviceId: "device-1",
    };
  }

  // validateSession constructs its own probe GopayProvider internally, so the
  // scripted fetch cannot be injected through a constructor here; it has to be
  // provided as the global fetch the probe falls back to.
  it("returns true when the stored session can list merchants", async () => {
    const { fetch, requests } = scriptedFetch([merchantSearchReply()]);
    vi.stubGlobal("fetch", fetch);

    // The service's own gopay has no scripted replies: if validateSession
    // leaked through it instead of the fresh probe, the test would fail.
    const { service } = makeLoginService([]);

    await expect(service.validateSession(storedSession())).resolves.toBe(true);
    expect(pathsOf(requests)).toEqual(["/v1/merchants/search"]);
    expect(requests[0]?.headers.Authorization).toBe("Bearer access-1");
  });

  // Regression guard: the probe used to ignore an injected fetch entirely and
  // always fall back to the global one, which on runtimes without a global
  // fetch turned every session check into a ConfigError.
  it("uses the fetch injected through LoginServiceConfig for the probe", async () => {
    const { fetch, requests } = scriptedFetch([merchantSearchReply()]);

    const service = new LoginService({
      gopay: new GopayProvider({ fetch: scriptedFetch([]).fetch }),
      fetch,
    });

    // No global stub here: if the probe fell back to the runtime fetch, the
    // request would either hit the network or fail, not consume the script.
    await expect(service.validateSession(storedSession())).resolves.toBe(true);
    expect(pathsOf(requests)).toEqual(["/v1/merchants/search"]);
  });

  it("returns false when the probe request fails", async () => {
    // A 500 (not 401) keeps the probe away from the token-refresh path, so
    // exactly one scripted reply is enough and the result is deterministic.
    const { fetch, requests } = scriptedFetch([reply(500, { error: "down" })]);
    vi.stubGlobal("fetch", fetch);

    const { service } = makeLoginService([]);

    await expect(service.validateSession(storedSession())).resolves.toBe(false);
    expect(requests).toHaveLength(1);
  });
});
