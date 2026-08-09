import type { TokenRefresher, TokenSet } from "./types.js";
import { AuthError, HttpError } from "./errors.js";
import type { Logger } from "../utils/logger.js";
import { noopLogger } from "../utils/logger.js";

/**
 * Decode a base64url-encoded JWT segment to a UTF-8 string using only
 * runtime-agnostic globals (`atob` + `TextDecoder`). This works outside Node.js
 * (Cloudflare Workers, Vercel Edge, Deno, browsers) where `Buffer` is absent.
 */
function decodeJwtSegment(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface TokenManagerConfig {
  /** Callback invoked after successful token refresh for persistence. */
  onTokenRefreshed?: (tokens: TokenSet) => Promise<void> | void;
  /** Refresh tokens this many milliseconds before expiry. Default: 5 minutes. */
  refreshBeforeExpiryMs?: number;
  logger?: Logger;
}

/**
 * Manages token lifecycle with automatic refresh, expiry tracking, and
 * concurrent request deduplication. Ensures a valid access token is always
 * available without redundant refresh calls.
 *
 * Key behaviors:
 * - Proactively refreshes tokens before expiry (default: 5 min buffer)
 * - Deduplicates concurrent refresh requests (single refresh per cycle)
 * - Adopts rotated refresh tokens only after persistence succeeds
 * - Notifies callback after refresh for config persistence
 */
export class TokenManager {
  private tokens: TokenSet;
  private expiresAt: number;
  private refreshPromise: Promise<TokenSet> | null = null;
  private readonly bufferMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly refresher: TokenRefresher,
    initialTokens: TokenSet,
    private readonly config: TokenManagerConfig = {},
  ) {
    this.tokens = { ...initialTokens };
    this.bufferMs = config.refreshBeforeExpiryMs ?? 5 * 60 * 1000; // 5 minutes
    this.logger = config.logger ?? noopLogger;
    this.expiresAt = this.calculateExpiry(initialTokens);
  }

  /**
   * Get a valid access token, refreshing automatically if needed or about to
   * expire. Concurrent calls are deduplicated to a single refresh request.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.needsRefresh()) {
      return this.tokens.accessToken;
    }
    return this.refreshOnce();
  }

  /**
   * Refresh unconditionally, ignoring the local expiry estimate, and return the
   * new access token.
   *
   * This is what a `401` handler must call. {@link getValidAccessToken} is a
   * no-op when the local clock still believes the token is valid, which is
   * exactly the situation a server-side `401` contradicts: a revoked token,
   * clock skew, or a wrong expiry guess. Concurrent callers still share a
   * single in-flight refresh.
   */
  async forceRefresh(): Promise<string> {
    return this.refreshOnce();
  }

  /**
   * Run a refresh, collapsing concurrent callers onto one in-flight request.
   */
  private async refreshOnce(): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }

    const newTokens = await this.refreshPromise;
    return newTokens.accessToken;
  }

  /**
   * Check if the access token needs refresh based on expiry time and buffer.
   */
  private needsRefresh(): boolean {
    const now = Date.now();
    const timeUntilExpiry = this.expiresAt - now;
    return timeUntilExpiry < this.bufferMs;
  }

  /**
   * Perform the actual token refresh. The persistence callback must succeed
   * before the rotated token set becomes the active in-memory session.
   */
  private async performRefresh(): Promise<TokenSet> {
    this.logger.debug("TokenManager: refreshing access token", {
      expiresAt: new Date(this.expiresAt).toISOString(),
      bufferMs: this.bufferMs,
    });

    let refreshedTokens: TokenSet;
    try {
      refreshedTokens = await this.refresher.refresh(this.tokens.refreshToken);
    } catch (error) {
      this.logger.error("TokenManager: token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      // A rejected refresh token surfaces as 400/401 from the GoID token
      // endpoint. Translate it into an actionable AuthError so callers can
      // distinguish "re-login required" from a transient network failure.
      const rejected =
        error instanceof AuthError ||
        (error instanceof HttpError &&
          (error.status === 400 || error.status === 401));

      if (rejected) {
        throw new AuthError(
          "AUTH_FAILED",
          "Refresh token expired or invalid. Please login again.",
          { cause: error },
        );
      }

      throw error;
    }

    // Adopt a rotated refresh token when the refresher supplies one, and fall
    // back to the current one otherwise. Pinning the original here would
    // silently discard a rotation and strand the session on a spent token.
    const candidateTokens: TokenSet = {
      accessToken: refreshedTokens.accessToken,
      refreshToken: refreshedTokens.refreshToken || this.tokens.refreshToken,
      tokenType: refreshedTokens.tokenType,
      expiresAt: refreshedTokens.expiresAt,
    };
    const candidateExpiresAt = this.calculateExpiry(candidateTokens);
    candidateTokens.expiresAt = candidateExpiresAt;

    try {
      await this.config.onTokenRefreshed?.({ ...candidateTokens });
    } catch (error) {
      this.logger.error("TokenManager: refreshed token persistence failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.tokens = candidateTokens;
    this.expiresAt = candidateExpiresAt;
    this.logger.info("TokenManager: token refreshed successfully", {
      newExpiresAt: new Date(this.expiresAt).toISOString(),
    });

    return { ...this.tokens };
  }

  /**
   * Calculate token expiry timestamp from TokenSet. Tries multiple strategies:
   * 1. Use expiresAt if present (from auth response)
   * 2. Parse JWT exp claim
   * 3. Fallback: assume 30 minutes from now
   */
  private calculateExpiry(tokens: TokenSet): number {
    // Strategy 1: Use expiresAt from response
    if (tokens.expiresAt) {
      return tokens.expiresAt;
    }

    // Strategy 2: Parse JWT exp claim
    try {
      const [, payload] = tokens.accessToken.split(".");
      if (payload) {
        const decoded = JSON.parse(decodeJwtSegment(payload));
        if (typeof decoded.exp === "number") {
          return decoded.exp * 1000; // Convert seconds to milliseconds
        }
      }
    } catch (error) {
      this.logger.warn("TokenManager: failed to parse JWT exp claim", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Strategy 3: Fallback to 30 minutes (GoPay default)
    const fallbackExpiry = Date.now() + 30 * 60 * 1000;
    this.logger.warn("TokenManager: using fallback expiry (30 min)", {
      expiresAt: new Date(fallbackExpiry).toISOString(),
    });
    return fallbackExpiry;
  }

  /**
   * Get the current token set (read-only copy). `expiresAt` is always
   * populated, even when the auth response omitted it.
   */
  getTokens(): TokenSet {
    return { ...this.tokens, expiresAt: this.expiresAt };
  }
}
