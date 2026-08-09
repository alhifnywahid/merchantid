/**
 * Runtime-agnostic identifier helpers. Prefers the Web Crypto API
 * (`globalThis.crypto`), which is available on Node 18+, Cloudflare Workers,
 * Vercel (Node & Edge), Deno, Bun, and browsers, and degrades gracefully when
 * it is unavailable.
 */

/** Minimal structural view of the Web Crypto API this module relies on. */
interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

/** Generate an RFC4122 v4 UUID. */
export const uuid = (): string => {
  const c: WebCryptoLike | undefined = (
    globalThis as { crypto?: WebCryptoLike }
  ).crypto;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    // Per RFC4122 v4: set version (4) and variant (10xx) bits.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b: number) =>
      b.toString(16).padStart(2, "0"),
    );
    return (
      `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-` +
      `${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-` +
      `${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
    );
  }

  // Last-resort fallback (non-cryptographic). Sufficient for device ids.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Generate a short, url-safe, time-ordered identifier for payments. Combines a
 * base36 timestamp with random entropy so ids sort roughly by creation time.
 */
export function paymentId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pay_${time}${rand}`;
}
