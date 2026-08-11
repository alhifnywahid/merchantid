import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../core/constants.js";
import { AuthError, HttpError } from "../../core/errors.js";
import type { FetchLike } from "../../http/httpClient.js";
import type { Logger } from "../../utils/logger.js";
import { noopLogger } from "../../utils/logger.js";
import { SHOPEE_PARTNER_API_BASE_URL } from "./constants.js";
import { ShopeeCookieJar } from "./cookieJar.js";

export type ShopeeQueryValue = string | number | boolean | undefined | null;

/** Host of the merchant/switch partner API, which authenticates by header only. */
const SHOPEE_PARTNER_API_HOST = new URL(SHOPEE_PARTNER_API_BASE_URL).host;

/**
 * The desktop-browser identity observed in the reference capture. Shopee's
 * fraud gateway silently suppresses OTP delivery for requests that do not
 * look like the official passport web client, so every account request carries
 * this profile instead of a Node fetch default.
 */
export const SHOPEE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
  Accept: "application/json",
  "Accept-Language": "id,en-US;q=0.9,en;q=0.8",
} as const;

export interface ShopeeHttpRequest {
  url: string;
  method?: "GET" | "POST";
  query?: Record<string, ShopeeQueryValue>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface ShopeeHttpClientOptions {
  cookieJar?: ShopeeCookieJar;
  fetch?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
}

function resolveGlobalFetch(): FetchLike {
  if (typeof fetch === "function") {
    return (input, init) => fetch(input, init);
  }
  throw new HttpError(
    0,
    "No global fetch is available for Shopee requests",
    undefined,
  );
}

function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  try {
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      return AbortSignal.timeout(milliseconds);
    }
  } catch {
    // A timeout is best-effort on runtimes without AbortSignal.timeout.
  }
  return undefined;
}

function describeUrl(url: URL): Record<string, unknown> {
  return { provider: "shopee", host: url.host, path: url.pathname };
}

/** Fetch wrapper that owns Shopee cookies without depending on a browser. */
export class ShopeeHttpClient {
  readonly cookieJar: ShopeeCookieJar;

  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(options: ShopeeHttpClientOptions = {}) {
    this.cookieJar = options.cookieJar ?? new ShopeeCookieJar();
    this.fetchImpl = options.fetch ?? resolveGlobalFetch();
    this.logger = options.logger ?? noopLogger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async request(options: ShopeeHttpRequest): Promise<Response> {
    const method = options.method ?? "GET";
    const url = new URL(options.url);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    // The partner gateway (server `SGW`) silently rejects requests that do not
    // look like the official web client with a generic error (90004 on the
    // mer-detect service). The browser sends its identity and fetch-metadata on
    // *every* XHR, not just the login navigations, so stamp them here as the
    // baseline for all hosts and let a caller override any of them.
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": SHOPEE_BROWSER_HEADERS["User-Agent"],
      "Accept-Language": SHOPEE_BROWSER_HEADERS["Accept-Language"],
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      ...options.headers,
    };
    // The partner API host authenticates purely via the `X-Merchant-Token`
    // header and, in the reference capture, never receives a cookie. Attaching
    // the dashboard token cookie is not just unnecessary - after a merchant
    // switch it carries the *previous* merchant's token, so the server sees it
    // contradict the fresh `X-Merchant-Token` and rejects the call with 200020.
    // Mirror the browser and omit cookies for this host only; shopeepay and the
    // partner web host still receive them as before.
    if (url.host !== SHOPEE_PARTNER_API_HOST) {
      const cookie = this.cookieJar.getCookieHeader(url);
      if (cookie) headers.Cookie = cookie;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      // String bodies (the device-risk telemetry blob) are posted verbatim.
      body =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    this.logger.debug("shopee http request", {
      method,
      ...describeUrl(url),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        credentials: "include",
        redirect: "manual",
        signal: timeoutSignal(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      const timedOut = name === "AbortError" || name === "TimeoutError";
      throw new HttpError(
        timedOut ? 408 : 0,
        timedOut ? "Shopee request timed out" : "Shopee request failed",
        undefined,
        { method, ...describeUrl(url) },
      );
    }

    this.cookieJar.updateFromResponse(url, response.headers);
    this.logger.debug("shopee http response", {
      method,
      status: response.status,
      ...describeUrl(url),
    });
    return response;
  }

  async requestJson<T>(options: ShopeeHttpRequest): Promise<T> {
    const response = await this.request(options);
    const url = new URL(options.url);
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = undefined;
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "AUTH_FAILED",
        `Shopee rejected the saved session (HTTP ${response.status} at ${url.pathname}); login again`,
        { details: { ...describeUrl(url), status: response.status } },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(
        response.status,
        "Shopee request returned a non-success status",
        undefined,
        { method: options.method ?? "GET", ...describeUrl(url) },
      );
    }
    if (payload === undefined) {
      throw new HttpError(
        response.status,
        "Shopee returned a non-JSON response",
        undefined,
        { method: options.method ?? "GET", ...describeUrl(url) },
      );
    }
    return payload as T;
  }

  /** Follow a bounded GET redirect chain while retaining every Set-Cookie. */
  async followGet(url: string, maxRedirects = 5): Promise<Response> {
    let currentUrl = url;
    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
      const response = await this.request({ url: currentUrl });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(
          response.status,
          "Shopee redirect did not include a location",
          undefined,
          describeUrl(new URL(currentUrl)),
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new HttpError(
      508,
      "Shopee redirect limit was exceeded",
      undefined,
      describeUrl(new URL(currentUrl)),
    );
  }
}

export function shopeeUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}
