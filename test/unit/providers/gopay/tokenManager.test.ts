import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../../../../src/core/tokenManager.js";
import { AuthError, HttpError } from "../../../../src/core/errors.js";
import type { TokenRefresher, TokenSet } from "../../../../src/core/types.js";

const HOUR = 60 * 60 * 1000;

function makeTokens(partial: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-original",
    tokenType: "Bearer",
    expiresAt: Date.now() + HOUR,
    ...partial,
  };
}

/** A refresher that records calls and returns a fresh access token each time. */
function makeRefresher(
  impl?: (refreshToken: string) => Promise<TokenSet>,
): TokenRefresher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async refresh(refreshToken: string) {
      calls.push(refreshToken);
      if (impl) return impl(refreshToken);
      return {
        accessToken: `access-new-${calls.length}`,
        // GoPay's refresh endpoint omits refresh_token; mimic that.
        refreshToken: "",
        tokenType: "Bearer",
        expiresAt: Date.now() + HOUR,
      };
    },
  };
}

/** Build a JWT-shaped token whose payload carries an `exp` claim. */
function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

describe("TokenManager.getValidAccessToken", () => {
  it("returns the current token without refreshing when it is not near expiry", async () => {
    const refresher = makeRefresher();
    const manager = new TokenManager(refresher, makeTokens());

    await expect(manager.getValidAccessToken()).resolves.toBe("access-old");
    expect(refresher.calls).toHaveLength(0);
  });

  it("refreshes when the token falls inside the expiry buffer", async () => {
    const refresher = makeRefresher();
    const manager = new TokenManager(
      refresher,
      makeTokens({ expiresAt: Date.now() + 60_000 }),
      { refreshBeforeExpiryMs: 5 * 60 * 1000 },
    );

    await expect(manager.getValidAccessToken()).resolves.toBe("access-new-1");
    expect(refresher.calls).toEqual(["refresh-original"]);
  });
});

describe("TokenManager.forceRefresh", () => {
  // Regression guard: a 401 handler must be able to refresh even when the local
  // expiry estimate still considers the token valid. getValidAccessToken would
  // hand back the same rejected token and the retry would be a no-op.
  it("refreshes even when the token still looks valid locally", async () => {
    const refresher = makeRefresher();
    const manager = new TokenManager(refresher, makeTokens());

    await expect(manager.forceRefresh()).resolves.toBe("access-new-1");
    expect(refresher.calls).toEqual(["refresh-original"]);
  });

  it("collapses concurrent callers onto a single refresh request", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const refresher = makeRefresher(async () => {
      await gate;
      return makeTokens({ accessToken: "access-shared", refreshToken: "" });
    });
    const manager = new TokenManager(refresher, makeTokens());

    const all = Promise.all([
      manager.forceRefresh(),
      manager.forceRefresh(),
      manager.forceRefresh(),
    ]);
    release?.();

    await expect(all).resolves.toEqual([
      "access-shared",
      "access-shared",
      "access-shared",
    ]);
    expect(refresher.calls).toHaveLength(1);
  });

  it("preserves the original refresh token when the response omits it", async () => {
    const refresher = makeRefresher();
    const manager = new TokenManager(refresher, makeTokens());

    await manager.forceRefresh();
    expect(manager.getTokens().refreshToken).toBe("refresh-original");
  });

  // The live GoID endpoint issues a new refresh token on every refresh.
  // Pinning the original here would discard the rotation and, the moment the
  // server starts retiring spent tokens, strand a long-lived session.
  it("adopts a rotated refresh token and uses it for the next refresh", async () => {
    const refresher = makeRefresher(async () =>
      makeTokens({ accessToken: "access-2", refreshToken: "refresh-rotated" }),
    );
    const manager = new TokenManager(refresher, makeTokens());

    await manager.forceRefresh();
    expect(manager.getTokens().refreshToken).toBe("refresh-rotated");

    await manager.forceRefresh();
    expect(refresher.calls).toEqual(["refresh-original", "refresh-rotated"]);
  });

  it("invokes onTokenRefreshed so callers can persist the new tokens", async () => {
    const onTokenRefreshed = vi.fn();
    const manager = new TokenManager(makeRefresher(), makeTokens(), {
      onTokenRefreshed,
    });

    await manager.forceRefresh();

    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "access-new-1",
      refreshToken: "refresh-original",
    });
  });

  it("keeps the last durable tokens when persistence rejects a rotation", async () => {
    const persistenceError = new Error("session store unavailable");
    const refresher = makeRefresher(async () =>
      makeTokens({
        accessToken: "access-not-persisted",
        refreshToken: "refresh-not-persisted",
      }),
    );
    const manager = new TokenManager(refresher, makeTokens(), {
      onTokenRefreshed: () => {
        throw persistenceError;
      },
    });

    await expect(manager.forceRefresh()).rejects.toBe(persistenceError);
    expect(manager.getTokens()).toMatchObject({
      accessToken: "access-old",
      refreshToken: "refresh-original",
    });
  });
});

describe("TokenManager refresh failures", () => {
  // Regression guard: a rejected refresh token arrives as HttpError, not
  // AuthError, so the actionable "please login again" message must be derived
  // from the HTTP status rather than a sentinel error code.
  it.each([401, 400])(
    "maps an HTTP %i from the token endpoint to AUTH_FAILED",
    async (status) => {
      const refresher = makeRefresher(() => {
        throw new HttpError(status, "rejected", { error: "invalid_grant" });
      });
      const manager = new TokenManager(refresher, makeTokens());

      await expect(manager.forceRefresh()).rejects.toMatchObject({
        code: "AUTH_FAILED",
        message: expect.stringContaining("Please login again"),
      });
    },
  );

  it("propagates transient server failures unchanged", async () => {
    const refresher = makeRefresher(() => {
      throw new HttpError(503, "upstream unavailable", undefined);
    });
    const manager = new TokenManager(refresher, makeTokens());

    const error = await manager.forceRefresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it("clears the in-flight promise so a later refresh can retry", async () => {
    let attempt = 0;
    const refresher = makeRefresher(async () => {
      attempt += 1;
      if (attempt === 1) throw new HttpError(503, "flaky", undefined);
      return makeTokens({ accessToken: "access-recovered", refreshToken: "" });
    });
    const manager = new TokenManager(refresher, makeTokens());

    await expect(manager.forceRefresh()).rejects.toBeInstanceOf(HttpError);
    await expect(manager.forceRefresh()).resolves.toBe("access-recovered");
  });
});

describe("TokenManager expiry resolution", () => {
  it("prefers the explicit expiresAt from the auth response", () => {
    const expiresAt = Date.now() + 2 * HOUR;
    const manager = new TokenManager(
      makeRefresher(),
      makeTokens({ expiresAt }),
    );

    expect(manager.getTokens().expiresAt).toBe(expiresAt);
  });

  it("falls back to the JWT exp claim when expiresAt is absent", () => {
    const expSeconds = Math.floor((Date.now() + 3 * HOUR) / 1000);
    const manager = new TokenManager(
      makeRefresher(),
      makeTokens({ accessToken: jwtWithExp(expSeconds), expiresAt: undefined }),
    );

    expect(manager.getTokens().expiresAt).toBe(expSeconds * 1000);
  });

  it("falls back to a 30 minute window for opaque tokens", () => {
    const before = Date.now();
    const manager = new TokenManager(
      makeRefresher(),
      makeTokens({ accessToken: "opaque-token", expiresAt: undefined }),
    );

    const resolved = manager.getTokens().expiresAt ?? 0;
    expect(resolved).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
    expect(resolved).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
  });
});
