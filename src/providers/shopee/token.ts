import { AuthError } from "../../core/errors.js";
import {
  SHOPEE_LIVE_TOKEN_COOKIE,
  SHOPEE_PARTNER_BASE_URL,
} from "./constants.js";
import type { ShopeeCookieJar } from "./cookieJar.js";

interface ShopeeMerchantCredential {
  token: string;
  accountId: string;
  businessId?: string;
  expiresAt?: number;
}

function decodeBase64Url(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of normalized.replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base64url input");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the inner merchant token from Shopee's signed dashboard JWT cookie. */
export function readShopeeMerchantCredential(
  cookieJar: ShopeeCookieJar,
): ShopeeMerchantCredential {
  const jwt = cookieJar.get(SHOPEE_LIVE_TOKEN_COOKIE, SHOPEE_PARTNER_BASE_URL);
  if (!jwt) {
    throw new AuthError(
      "AUTH_FAILED",
      "Shopee login did not return a merchant session token",
    );
  }

  try {
    const segments = jwt.split(".");
    const payloadSegment = segments[1];
    if (segments.length !== 3 || !payloadSegment)
      throw new Error("Invalid JWT");
    const payload: unknown = JSON.parse(decodeBase64Url(payloadSegment));
    if (!isRecord(payload) || typeof payload.token !== "string") {
      throw new Error("Missing merchant token");
    }
    const accountId =
      typeof payload.userid === "string"
        ? payload.userid
        : typeof payload.userid === "number"
          ? String(payload.userid)
          : undefined;
    if (!accountId || !payload.token) throw new Error("Missing account id");

    const businessId =
      typeof payload.businessId === "string"
        ? payload.businessId
        : typeof payload.businessId === "number"
          ? String(payload.businessId)
          : undefined;
    const expiresAt =
      typeof payload.exp === "number" && Number.isFinite(payload.exp)
        ? payload.exp * 1_000
        : undefined;

    return { token: payload.token, accountId, businessId, expiresAt };
  } catch (cause) {
    throw new AuthError(
      "AUTH_FAILED",
      "Shopee returned an unreadable merchant session token",
      { cause },
    );
  }
}
