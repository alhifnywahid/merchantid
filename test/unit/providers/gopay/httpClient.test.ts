import { describe, expect, it, vi } from "vitest";
import { HttpClient, type FetchLike } from "../../../../src/http/httpClient.js";
import { TokenManager } from "../../../../src/core/tokenManager.js";
import { AuthError, HttpError } from "../../../../src/core/errors.js";
import type { TokenRefresher, TokenSet } from "../../../../src/core/types.js";

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

function makeTokenManager(
  refresh: () => Promise<TokenSet>,
  expiresAt = Date.now() + HOUR,
): { manager: TokenManager; refresher: TokenRefresher & { calls: number } } {
  const refresher = {
    calls: 0,
    async refresh() {
      refresher.calls += 1;
      return refresh();
    },
  };
  const manager = new TokenManager(refresher, {
    accessToken: "token-stale",
    refreshToken: "refresh-original",
    tokenType: "Bearer",
    expiresAt,
  });
  return { manager, refresher };
}

describe("HttpClient.requestJson", () => {
  it("parses a JSON body on success", async () => {
    const { fetch, requests } = scriptedFetch([reply(200, { ok: true })]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch });

    await expect(client.requestJson({ path: "/thing" })).resolves.toEqual({
      ok: true,
    });
    expect(requests[0]?.url).toBe("https://api.test/thing");
  });

  it("serializes query parameters and skips null/undefined", async () => {
    const { fetch, requests } = scriptedFetch([reply(200, {})]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch });

    await client.requestJson({
      path: "/search",
      query: { size: 10, cursor: undefined, tag: null, q: "abc" },
    });

    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("size")).toBe("10");
    expect(url.searchParams.get("q")).toBe("abc");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("throws HttpError carrying the status and parsed body on non-2xx", async () => {
    const { fetch } = scriptedFetch([reply(422, { message: "bad amount" })]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch });

    const error = await client
      .requestJson({ path: "/pay" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 422,
      code: "HTTP_ERROR",
      body: { message: "bad amount" },
    });
  });

  it("maps an aborted request to HttpError 408", async () => {
    const fetch = (async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as FetchLike;
    const client = new HttpClient({ baseUrl: "https://api.test", fetch });

    await expect(client.requestJson({ path: "/slow" })).rejects.toMatchObject({
      status: 408,
    });
  });
});

describe("HttpClient 401 handling", () => {
  // Regression guard for the core defect: the retry must send a *different*
  // bearer. Previously it asked the manager for a "valid" token, which returned
  // the same rejected one whenever the local expiry looked fine.
  it("force-refreshes and retries once with the new bearer", async () => {
    const { fetch, requests } = scriptedFetch([
      reply(401, { error: "unauthorized" }),
      reply(200, { ok: true }),
    ]);
    const { manager, refresher } = makeTokenManager(async () => ({
      accessToken: "token-fresh",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: Date.now() + HOUR,
    }));

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
      defaultHeaders: { Authorization: "Bearer token-stale" },
    });

    await expect(client.requestJson({ path: "/me" })).resolves.toEqual({
      ok: true,
    });

    expect(refresher.calls).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.Authorization).toBe("Bearer token-stale");
    expect(requests[1]?.headers.Authorization).toBe("Bearer token-fresh");
  });

  it("retries at most once and surfaces a persistent 401", async () => {
    const { fetch, requests } = scriptedFetch([
      reply(401, { error: "unauthorized" }),
      reply(401, { error: "unauthorized" }),
    ]);
    const { manager } = makeTokenManager(async () => ({
      accessToken: "token-fresh",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: Date.now() + HOUR,
    }));

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
    });

    await expect(client.requestJson({ path: "/me" })).rejects.toMatchObject({
      status: 401,
    });
    expect(requests).toHaveLength(2);
  });

  // Regression guard: without skipAuthRetry, a 401 from the token endpoint
  // re-enters the token manager that is already awaiting this very request,
  // and both sides wait on the same in-flight refresh promise.
  it("does not attempt a refresh when skipAuthRetry is set", async () => {
    const { fetch, requests } = scriptedFetch([reply(401, { error: "nope" })]);
    const refresh = vi.fn();
    const { manager, refresher } = makeTokenManager(async () => {
      refresh();
      throw new Error("refresh must not be reached");
    });

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
    });

    await expect(
      client.requestJson({ path: "/goid/token", skipAuthRetry: true }),
    ).rejects.toMatchObject({ status: 401 });

    expect(refresher.calls).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  // Regression guard: a revoked session used to surface as a plain HTTP_ERROR
  // 401, indistinguishable from a transient failure. Consumers need the typed
  // AUTH_FAILED to know that only a re-login fixes this (AGENTS.md 5.7).
  it("surfaces AUTH_FAILED when the refresh token itself is rejected", async () => {
    const { fetch, requests } = scriptedFetch([reply(401, { error: "nope" })]);
    const { manager } = makeTokenManager(async () => {
      // The GoID token endpoint answers 400/401 for a dead refresh token,
      // which TokenManager translates into AuthError AUTH_FAILED.
      throw new HttpError(400, "invalid_grant", undefined);
    });

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
    });

    const error = await client
      .requestJson({ path: "/me" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(requests).toHaveLength(1);
  });

  // Regression guard: the recovery block used to wrap the refresh AND the
  // retried request in one catch, so a retry-send failure was logged as
  // "token refresh failed" and surfaced as the stale 401.
  it("propagates a failed retry request as itself, not as the original 401", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) return reply(401, { error: "unauthorized" });
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as FetchLike;

    const { manager, refresher } = makeTokenManager(async () => ({
      accessToken: "token-fresh",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: Date.now() + HOUR,
    }));

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
    });

    // The refresh succeeded and the retried request then timed out; the
    // caller must see the timeout (408), not a fabricated auth failure.
    await expect(client.requestJson({ path: "/me" })).rejects.toMatchObject({
      status: 408,
    });
    expect(refresher.calls).toBe(1);
    expect(calls).toBe(2);
  });

  it("surfaces the original 401 when the refresh fails transiently", async () => {
    const { fetch, requests } = scriptedFetch([reply(401, { error: "nope" })]);
    const { manager } = makeTokenManager(async () => {
      // A 5xx from the token endpoint is not a rejected session; the caller
      // should see the original 401 and may simply retry later.
      throw new HttpError(503, "service unavailable", undefined);
    });

    const client = new HttpClient({
      baseUrl: "https://api.test",
      fetch,
      tokenManager: manager,
    });

    await expect(client.requestJson({ path: "/me" })).rejects.toMatchObject({
      status: 401,
      code: "HTTP_ERROR",
    });
    expect(requests).toHaveLength(1);
  });

  it("leaves 401 untouched when no token manager is wired", async () => {
    const { fetch, requests } = scriptedFetch([reply(401, { error: "nope" })]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch });

    await expect(client.requestJson({ path: "/me" })).rejects.toMatchObject({
      status: 401,
    });
    expect(requests).toHaveLength(1);
  });
});
