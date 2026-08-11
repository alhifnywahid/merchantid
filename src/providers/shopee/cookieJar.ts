import type { ShopeeCookie } from "./types.js";

function splitCombinedSetCookie(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }
  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function domainMatches(hostname: string, cookie: ShopeeCookie): boolean {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.toLowerCase();
  return cookie.hostOnly
    ? host === domain
    : host === domain || host.endsWith(`.${domain}`);
}

/**
 * Reject `Domain` attributes that are a public suffix rather than a registrable
 * domain, e.g. `Domain=co.id` from `partner.shopee.co.id`. Plain suffix
 * matching would accept it and then send that cookie to *every* `*.co.id` host
 * the client is ever redirected to - a session token handed to strangers.
 *
 * This is a deliberately small check rather than a bundled public-suffix list:
 * the jar only ever talks to a fixed set of Shopee hosts, and a list would be
 * a large, staleness-prone dependency for one rule. It rejects bare TLDs, the
 * common two-label public suffixes this client can encounter, and any domain
 * with no registrable label below the suffix.
 */
const PUBLIC_SUFFIXES = new Set([
  "co.id",
  "or.id",
  "web.id",
  "ac.id",
  "go.id",
  "sch.id",
  "my.id",
  "co.uk",
  "com.au",
  "com.sg",
  "com.my",
  "co.th",
  "com.br",
  "com.cn",
  "co.jp",
]);

function isPublicSuffix(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  // A bare TLD ("com", "id") has no registrable label at all.
  if (!normalized.includes(".")) return true;
  return PUBLIC_SUFFIXES.has(normalized);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || pathname[cookiePath.length] === "/";
}

function cloneCookie(cookie: ShopeeCookie): ShopeeCookie {
  return { ...cookie };
}

/** Minimal RFC6265 cookie jar sufficient for Shopee's server-side login flow. */
export class ShopeeCookieJar {
  private readonly cookies: ShopeeCookie[] = [];

  constructor(initial: readonly ShopeeCookie[] = []) {
    this.restore(initial);
  }

  clear(): void {
    this.cookies.length = 0;
  }

  restore(cookies: readonly ShopeeCookie[]): void {
    this.clear();
    for (const cookie of cookies) {
      if (!cookie.name || !cookie.domain || !cookie.path) continue;
      // `;` is rejected in the value too, not just the name: `getCookieHeader`
      // joins pairs with "; ", so a value containing a semicolon would inject
      // additional cookies into every outgoing request.
      if (/[\r\n;]/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) continue;
      this.upsert(cloneCookie(cookie));
    }
    this.purgeExpired();
  }

  snapshot(): ShopeeCookie[] {
    this.purgeExpired();
    return this.cookies.map(cloneCookie);
  }

  updateFromResponse(requestUrl: string | URL, headers: Headers): void {
    const url =
      typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    for (const line of readSetCookieHeaders(headers)) {
      const parsed = this.parseSetCookie(line, url);
      if (!parsed) continue;
      this.remove(parsed.name, parsed.domain, parsed.path);
      if (parsed.expiresAt === undefined || parsed.expiresAt > Date.now()) {
        this.cookies.push(parsed);
      }
    }
    this.purgeExpired();
  }

  get(name: string, requestUrl?: string | URL): string | undefined {
    this.purgeExpired();
    if (!requestUrl) {
      return this.cookies.find((cookie) => cookie.name === name)?.value;
    }
    const url =
      typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    return this.matching(url).find((cookie) => cookie.name === name)?.value;
  }

  getCookieHeader(requestUrl: string | URL): string | undefined {
    this.purgeExpired();
    const url =
      typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
    const matching = this.matching(url).sort(
      (left, right) => right.path.length - left.path.length,
    );
    if (matching.length === 0) return undefined;
    return matching
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private matching(url: URL): ShopeeCookie[] {
    return this.cookies.filter(
      (cookie) =>
        domainMatches(url.hostname, cookie) &&
        pathMatches(url.pathname || "/", cookie.path) &&
        (!cookie.secure || url.protocol === "https:"),
    );
  }

  private parseSetCookie(
    line: string,
    requestUrl: URL,
  ): ShopeeCookie | undefined {
    const parts = line.split(";");
    const first = parts.shift()?.trim();
    if (!first) return undefined;
    const equals = first.indexOf("=");
    if (equals <= 0) return undefined;

    const cookie: ShopeeCookie = {
      name: first.slice(0, equals).trim(),
      value: first.slice(equals + 1).trim(),
      domain: requestUrl.hostname.toLowerCase(),
      path: defaultCookiePath(requestUrl.pathname),
      hostOnly: true,
    };

    for (const rawAttribute of parts) {
      const attribute = rawAttribute.trim();
      if (!attribute) continue;
      const separator = attribute.indexOf("=");
      const key = (separator < 0 ? attribute : attribute.slice(0, separator))
        .trim()
        .toLowerCase();
      const value = separator < 0 ? "" : attribute.slice(separator + 1).trim();

      if (key === "domain" && value) {
        const domain = value.replace(/^\./, "").toLowerCase();
        // Ignore a public-suffix Domain rather than rejecting the whole cookie:
        // dropping the attribute falls back to a host-only cookie, which is the
        // strictly safer scope and keeps the session working.
        if (!isPublicSuffix(domain)) {
          cookie.domain = domain;
          cookie.hostOnly = false;
        }
      } else if (key === "path" && value.startsWith("/")) {
        cookie.path = value;
      } else if (key === "max-age") {
        const seconds = Number.parseInt(value, 10);
        if (Number.isFinite(seconds)) {
          cookie.expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1_000;
        }
      } else if (key === "expires" && cookie.expiresAt === undefined) {
        const expiresAt = Date.parse(value);
        if (!Number.isNaN(expiresAt)) cookie.expiresAt = expiresAt;
      } else if (key === "secure") {
        cookie.secure = true;
      } else if (key === "httponly") {
        cookie.httpOnly = true;
      } else if (key === "samesite") {
        const sameSite = value.toLowerCase();
        if (
          sameSite === "strict" ||
          sameSite === "lax" ||
          sameSite === "none"
        ) {
          cookie.sameSite = sameSite;
        }
      }
    }

    if (!cookie.name || /[\r\n;]/.test(cookie.name)) return undefined;
    // See `restore`: a `;` in the value would inject extra pairs into the
    // Cookie header this jar emits.
    if (/[\r\n;]/.test(cookie.value)) return undefined;
    if (!domainMatches(requestUrl.hostname, cookie)) return undefined;
    return cookie;
  }

  private upsert(cookie: ShopeeCookie): void {
    this.remove(cookie.name, cookie.domain, cookie.path);
    this.cookies.push(cookie);
  }

  private remove(name: string, domain: string, path: string): void {
    for (let index = this.cookies.length - 1; index >= 0; index--) {
      const existing = this.cookies[index];
      if (
        existing?.name === name &&
        existing.domain === domain &&
        existing.path === path
      ) {
        this.cookies.splice(index, 1);
      }
    }
  }

  private purgeExpired(now = Date.now()): void {
    for (let index = this.cookies.length - 1; index >= 0; index--) {
      const expiresAt = this.cookies[index]?.expiresAt;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.cookies.splice(index, 1);
      }
    }
  }
}
