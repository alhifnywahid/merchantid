import { describe, expect, it } from "vitest";
import { GopayProvider } from "../../../../src/providers/gopay/gopayProvider.js";
import type { FetchLike } from "../../../../src/http/httpClient.js";
import { AuthError, ConfigError } from "../../../../src/core/errors.js";
import { crc16ccitt } from "../../../../src/utils/crc16.js";
import {
  isValidQrisChecksum,
  parseEmv,
  QRIS_TAGS,
} from "../../../../src/qris/qris.js";
import type { SessionState, TokenSet } from "../../../../src/core/types.js";

const HOUR = 60 * 60 * 1000;

/** Minimal Response stand-in: HttpClient only reads `status` and `text()`. */
function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text } as unknown as Response;
}

/** Queue a scripted sequence of responses and record the requests made. */
function scriptedFetch(replies: Response[]): {
  fetch: FetchLike;
  requests: Array<{ url: string; headers: Record<string, string> }>;
} {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;

  const fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      // Snapshot: the client reuses and mutates the same headers object on retry.
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const next = replies[index++];
    if (!next) throw new Error("scriptedFetch: no reply left for this request");
    return next;
  }) as unknown as FetchLike;

  return { fetch, requests };
}

/** Tiny hand-built static QRIS whose CRC is computed, not hardcoded. */
function staticQris(): string {
  const body = "000201" + "010211" + "5905ATMOS";
  const withCrcHeader = `${body}6304`;
  return `${withCrcHeader}${crc16ccitt(withCrcHeader)}`;
}

function makeTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "token-live",
    refreshToken: "refresh-original",
    tokenType: "Bearer",
    // A far-future expiry keeps the TokenManager from refreshing spontaneously.
    expiresAt: Date.now() + HOUR,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return { tokens: makeTokens(), deviceId: "device-session", ...overrides };
}

/** Capture a synchronously thrown value so its typed fields can be inspected. */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("GopayProvider.payments gating", () => {
  it("throws AuthError AUTH_REQUIRED before any login", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({ fetch, merchantId: "G1" });

    const error = capture(() => gateway.payments());

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws ConfigError CONFIG_INVALID with a session but no merchantId", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({ fetch, session: makeSession() });

    const error = capture(() => gateway.payments());

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("returns the same lazily built service on every call", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      merchantId: "G1",
      session: makeSession(),
    });

    // The facade memoizes the PaymentService so listeners registered on one
    // handle keep firing for payments created through another.
    expect(gateway.payments()).toBe(gateway.payments());
  });
});

describe("GopayProvider.exportSession", () => {
  it("throws AuthError AUTH_REQUIRED without a login", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({ fetch });

    const error = capture(() => gateway.exportSession());

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("returns the current tokens with expiresAt always populated", () => {
    const { fetch } = scriptedFetch([]);
    const tokens = makeTokens();
    const gateway = new GopayProvider({
      fetch,
      session: { tokens, deviceId: "device-session" },
    });

    const exported = gateway.exportSession();

    expect(exported.tokens.accessToken).toBe(tokens.accessToken);
    expect(exported.tokens.refreshToken).toBe(tokens.refreshToken);
    expect(exported.tokens.expiresAt).toBe(tokens.expiresAt);
    expect(exported.deviceId).toBe("device-session");
    expect(exported.lastRefreshedAt).toBeTypeOf("number");
  });

  it("prefers the session deviceId over the config deviceId", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      session: makeSession(),
      deviceId: "device-config",
    });

    // A restored session must keep presenting the identity it was created
    // with; switching x-uniqueid mid-session can invalidate it server-side.
    expect(gateway.exportSession().deviceId).toBe("device-session");
  });

  it("falls back to the config deviceId when the session has none", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      session: { tokens: makeTokens() },
      deviceId: "device-config",
    });

    expect(gateway.exportSession().deviceId).toBe("device-config");
  });

  it("generates a stable RFC4122 v4 uuid when no deviceId is supplied", () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      session: { tokens: makeTokens() },
    });

    const first = gateway.exportSession().deviceId;
    const second = gateway.exportSession().deviceId;

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The generated id must not churn between exports, or every persisted
    // session would present a new device identity on restore.
    expect(second).toBe(first);
  });
});

describe("GopayProvider token refresh persistence", () => {
  it("invokes onTokenRefreshed with an updated session carrying the same deviceId", async () => {
    const { fetch, requests } = scriptedFetch([
      reply(200, {
        access_token: "token-fresh",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    ]);
    const seen: SessionState[] = [];
    const gateway = new GopayProvider({
      fetch,
      merchantId: "G1",
      session: {
        // Already expired, so refreshSession() must actually hit the token
        // endpoint instead of treating the stale token as still valid.
        tokens: makeTokens({
          accessToken: "token-stale",
          expiresAt: Date.now() - 1_000,
        }),
        deviceId: "device-session",
      },
      onTokenRefreshed: (session) => {
        seen.push(session);
      },
    });

    const refreshed = await gateway.refreshSession();

    expect(refreshed.accessToken).toBe("token-fresh");
    // GoPay's refresh endpoint does not rotate the refresh token; losing the
    // original here would silently break every later refresh.
    expect(refreshed.refreshToken).toBe("refresh-original");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.deviceId).toBe("device-session");
    expect(seen[0]?.tokens.accessToken).toBe("token-fresh");
    expect(seen[0]?.tokens.refreshToken).toBe("refresh-original");
    expect(seen[0]?.lastRefreshedAt).toBeTypeOf("number");

    // The refresh call itself must go to the GoID token endpoint without
    // presenting the stale bearer (AuthClient overrides Authorization).
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.gobiz.co.id/goid/token");
    expect(requests[0]?.headers.Authorization).toBe("Bearer");

    // exportSession must agree with what the callback persisted.
    const exported = gateway.exportSession();
    expect(exported.tokens.accessToken).toBe("token-fresh");
    expect(exported.deviceId).toBe("device-session");
  });
});

describe("GopayProvider.createPayment delegation", () => {
  it("produces uniqueAmount = amount + 1 with a valid dynamic QRIS, offline", async () => {
    const { fetch, requests } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      merchantId: "G1",
      session: makeSession(),
      staticQris: staticQris(),
    });

    const payment = await gateway.createPayment({ amount: 10_000 });

    expect(payment.baseAmount).toBe(10_000);
    expect(payment.uniqueOffset).toBe(1);
    expect(payment.uniqueAmount).toBe(10_001);
    expect(payment.status).toBe("pending");

    // The configured static QRIS must be threaded through to the payment
    // service: tag 54 carries the unique amount and the CRC is recomputed.
    const tags = parseEmv(payment.qrString!);
    expect(tags.get(QRIS_TAGS.transactionAmount)).toBe("10001");
    expect(tags.get(QRIS_TAGS.pointOfInitiation)).toBe(QRIS_TAGS.poiDynamic);
    expect(isValidQrisChecksum(payment.qrString!)).toBe(true);

    // Creating a payment is purely local (allocation + QRIS derivation); any
    // fetch here would mean the facade wired the service to the network path.
    expect(requests).toHaveLength(0);
  });

  it("routes consecutive payments through the same allocator state", async () => {
    const { fetch } = scriptedFetch([]);
    const gateway = new GopayProvider({
      fetch,
      merchantId: "G1",
      session: makeSession(),
      staticQris: staticQris(),
    });

    const first = await gateway.createPayment({ amount: 10_000 });
    const second = await gateway.createPayment({ amount: 10_000 });

    // If createPayment rebuilt the service per call, both would get +1 and
    // become indistinguishable to the amount-only matcher.
    expect(first.uniqueAmount).toBe(10_001);
    expect(second.uniqueAmount).toBe(10_002);
  });
});
