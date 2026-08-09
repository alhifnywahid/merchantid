import { AuthError, ConfigError, HttpError } from "../core/errors.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../core/constants.js";
import type { Logger } from "../utils/logger.js";
import { noopLogger } from "../utils/logger.js";
import { safeDiagnosticText } from "../utils/redact.js";
import type { TokenManager } from "../core/tokenManager.js";

export type QueryValue = string | number | boolean | undefined | null;

/**
 * The subset of the WHATWG `fetch` signature this client relies on. Any
 * spec-compliant fetch satisfies it: the global `fetch` in Node 18+, browsers,
 * Cloudflare Workers, Vercel (Node & Edge), Deno, and Bun. A custom
 * implementation can be injected for connection pooling (e.g. an undici
 * `Agent` in Node), proxying, or testing.
 */
export type FetchLike = typeof fetch;

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  baseUrl?: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /**
   * Opt out of the automatic refresh-and-retry on `401`.
   *
   * Required for the auth endpoints themselves: a `401` from the token endpoint
   * would otherwise re-enter the token manager, which is already awaiting this
   * very request, and deadlock on its own in-flight refresh promise.
   */
  skipAuthRetry?: boolean;
}

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  logger?: Logger;
  /** Optional token manager for automatic 401 retry with refreshed token. */
  tokenManager?: TokenManager;
  /**
   * Custom fetch implementation. Defaults to the runtime's global `fetch`.
   * Provide one to run on Node < 18 or to use a pooled/proxied client.
   */
  fetch?: FetchLike;
}

/**
 * Resolve the runtime global `fetch`, wrapped so it is always invoked with the
 * correct receiver (avoids "Illegal invocation" in browser-like runtimes).
 */
function resolveGlobalFetch(): FetchLike {
  if (typeof fetch === "function") {
    return (input, init) => fetch(input, init);
  }
  throw new ConfigError(
    "No global `fetch` is available in this runtime. Upgrade to Node 18+ or " +
      "pass a `fetch` implementation via the client config.",
  );
}

/**
 * Build a single-shot timeout AbortSignal. Uses `AbortSignal.timeout` when
 * available (Node 18+, Workers, Deno, Bun, modern browsers) and degrades to no
 * timeout on runtimes that lack it.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // Ignore and proceed without an abort signal.
  }
  return undefined;
}

/**
 * Pull a short, human-readable reason out of an error response body so a
 * failure is diagnosable instead of just "status 400". Handles the GoID
 * envelope (`errors: [{ code, message }]`) and common flat shapes.
 */
function extractErrorReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (first && typeof first === "object") {
      const entry = first as Record<string, unknown>;
      const code =
        typeof entry["code"] === "string" ? entry["code"] : undefined;
      const message =
        typeof entry["message"] === "string" ? entry["message"] : undefined;
      const combined = [code, message].filter(Boolean).join(": ");
      if (combined) return combined;
    }
  }
  for (const key of ["message", "error_description", "error", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Shared with the Shopee client so the redaction rule cannot drift apart. */
const sanitizeErrorReason = safeDiagnosticText;

/**
 * Describe a request for logs and error details as host + path only.
 *
 * A full URL carries the query string, and query strings are where credentials
 * end up when an endpoint takes them that way. The Shopee client already logs
 * this shape; this keeps the GoPay client from being the one that leaks.
 */
function describeUrl(url: string, method: string): Record<string, unknown> {
  try {
    const parsed = new URL(url);
    return { method, host: parsed.host, path: parsed.pathname };
  } catch {
    return { method };
  }
}

/**
 * Thin JSON HTTP client over the WHATWG `fetch` API. It centralizes base URL
 * handling, query serialization, JSON encoding/decoding, timeouts, and non-2xx
 * error mapping so the API clients stay declarative. Being fetch-based, it runs
 * unchanged on any modern JavaScript runtime.
 *
 * When a TokenManager is provided, 401 responses automatically trigger token
 * refresh and retry the request once with the new access token.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private tokenManager?: TokenManager;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetch ?? resolveGlobalFetch();
    this.tokenManager = options.tokenManager;
  }

  /** Set the token manager for automatic 401 retry. */
  setTokenManager(tokenManager: TokenManager | undefined): void {
    this.tokenManager = tokenManager;
  }

  /** Set or remove a single default header. */
  setDefaultHeader(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete this.defaultHeaders[name];
    } else {
      this.defaultHeaders[name] = value;
    }
  }

  async requestJson<T>(options: HttpRequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const base = (options.baseUrl ?? this.baseUrl).replace(/\/+$/, "");
    const url = this.buildUrl(base, options.path, options.query);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options.headers,
    };

    let payload: string | undefined;
    if (options.body !== undefined && options.body !== null) {
      payload = JSON.stringify(options.body);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    this.logger.debug("http request", describeUrl(url, method));

    let { status, text } = await this.send(
      url,
      method,
      headers,
      payload,
      timeoutMs,
    );
    let parsed = this.tryParseJson(text);

    // Auto-refresh on 401 Unauthorized (token rejected by the server).
    if (status === 401 && this.tokenManager && !options.skipAuthRetry) {
      this.logger.info("http 401 detected, attempting token refresh");

      let newAccessToken: string | undefined;
      try {
        // Force a refresh rather than asking for a "valid" token: the server
        // just rejected the current one, so the local expiry estimate is wrong
        // and getValidAccessToken() would hand back the same failing token.
        newAccessToken = await this.tokenManager.forceRefresh();
      } catch (refreshError) {
        this.logger.error("http token refresh failed", {
          error:
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
        });
        // A rejected refresh token means the session itself is gone (revoked
        // by a login elsewhere, or expired) and only a re-login fixes it.
        // Surface that as the typed AuthError so callers can distinguish
        // "re-login required" from a transient failure; anything else falls
        // through to the original 401 below.
        if (refreshError instanceof AuthError) {
          throw refreshError;
        }
      }

      if (newAccessToken !== undefined) {
        headers.Authorization = `Bearer ${newAccessToken}`;

        this.logger.debug(
          "http retrying request with refreshed token",
          describeUrl(url, method),
        );

        // Only the refresh is guarded above. A failure of the retried request
        // itself (timeout, network) propagates as what it is; wrapping it too
        // would misreport a successful refresh as failed and surface the
        // stale 401 instead of the real error.
        ({ status, text } = await this.send(
          url,
          method,
          headers,
          payload,
          timeoutMs,
        ));
        parsed = this.tryParseJson(text);
      }
    }

    if (status < 200 || status >= 300) {
      this.logger.warn("http error", {
        ...describeUrl(url, method),
        status,
      });
      const reason = sanitizeErrorReason(extractErrorReason(parsed ?? text));
      throw new HttpError(
        status,
        `Request to ${options.path} failed with status ${status}${
          reason ? ` (${reason})` : ""
        }`,
        // Carried for callers that need to inspect the failure. `HttpError`
        // stores it non-enumerably, so logging the error does not dump it.
        parsed ?? text,
        describeUrl(url, method),
      );
    }

    return (parsed ?? {}) as T;
  }

  /** Perform a single request attempt and read the response body as text. */
  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; text: string }> {
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: timeoutSignal(timeoutMs),
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        const described = describeUrl(url, method);
        throw new HttpError(
          408,
          `Request to ${String(described.path ?? url)} timed out after ${timeoutMs}ms`,
          undefined,
          described,
        );
      }
      throw error;
    }
  }

  private buildUrl(
    base: string,
    path: string,
    query?: Record<string, QueryValue>,
  ): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private tryParseJson(text: string): unknown {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}
