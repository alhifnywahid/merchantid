import { crc16ccitt } from "../utils/crc16.js";
import { MerchantIdError } from "../core/errors.js";

/**
 * A parsed EMVCo QR data object: a map of tag id to raw value string. Nested
 * templates keep their inner payload as the raw value.
 */
export type EmvTlvMap = Map<string, string>;

const TAG_PAYLOAD_FORMAT = "00";
const TAG_POINT_OF_INITIATION = "01";
const TAG_TRANSACTION_AMOUNT = "54";
const TAG_CRC = "63";

const POI_STATIC = "11";
const POI_DYNAMIC = "12";

/**
 * Parse an EMVCo/QRIS payload string into a flat TLV map. Each element is
 * `<2-digit tag><2-digit length><value>`. Nested templates are preserved as
 * raw values and can be parsed again by the caller if needed.
 */
export function parseEmv(payload: string): EmvTlvMap {
  // EMVCo lengths count *bytes*, not JavaScript characters. Walking the UTF-8
  // bytes keeps parsing correct for merchant names outside ASCII, where one
  // character can occupy two or three bytes.
  const bytes = new TextEncoder().encode(payload);
  const decoder = new TextDecoder();
  const map: EmvTlvMap = new Map();
  let cursor = 0;

  while (cursor < bytes.length) {
    const malformed = (): never => {
      throw new MerchantIdError(
        "QRIS_PARSE_ERROR",
        `Malformed QRIS payload near byte ${cursor}`,
      );
    };

    if (cursor + 4 > bytes.length) malformed();
    const tag = decoder.decode(bytes.subarray(cursor, cursor + 2));
    cursor += 2;

    const lengthText = decoder.decode(bytes.subarray(cursor, cursor + 2));
    cursor += 2;
    // A length must be exactly two digits; `parseInt` would otherwise accept
    // "5A" as 5 and silently mis-slice the rest of the payload.
    if (!/^\d{2}$/.test(lengthText)) malformed();

    const length = Number.parseInt(lengthText, 10);
    // Without this bound a truncated payload parses "successfully" and is then
    // re-emitted under a freshly computed, perfectly valid CRC — corrupt
    // merchant data wearing a good checksum.
    if (cursor + length > bytes.length) malformed();

    const value = decoder.decode(bytes.subarray(cursor, cursor + length));
    cursor += length;
    map.set(tag, value);
  }

  return map;
}

/**
 * Serialize a single TLV element with a zero-padded two digit length, measured
 * in UTF-8 bytes as the specification requires. Values needing more than 99
 * bytes cannot be expressed in a two-digit length and are rejected rather than
 * emitted as an unparseable three-digit length.
 */
export function encodeTlv(tag: string, value: string): string {
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > 99) {
    throw new MerchantIdError(
      "QRIS_PARSE_ERROR",
      `QRIS tag ${tag} value is ${byteLength} bytes, exceeding the 99-byte limit`,
    );
  }
  return `${tag}${byteLength.toString().padStart(2, "0")}${value}`;
}

/**
 * Rebuild an EMVCo payload from a TLV map and append a freshly computed CRC.
 * Tags are emitted in ascending numeric order to keep output deterministic,
 * except the CRC tag which is always placed last per the specification.
 */
export function buildEmv(map: EmvTlvMap): string {
  const tags = [...map.keys()]
    .filter((tag) => tag !== TAG_CRC)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  let body = "";
  for (const tag of tags) {
    body += encodeTlv(tag, map.get(tag) ?? "");
  }

  // CRC is computed over the payload including the CRC tag id and length.
  const withCrcHeader = `${body}${TAG_CRC}04`;
  const crc = crc16ccitt(withCrcHeader);
  return `${withCrcHeader}${crc}`;
}

/**
 * Convert a static QRIS payload into a dynamic one carrying a fixed amount.
 *
 * GoPay merchant QRIS codes are static (no amount). To make each order unique
 * and machine-detectable, we inject tag 54 (transaction amount) and flip the
 * point-of-initiation method (tag 01) from static (11) to dynamic (12), then
 * recompute the CRC.
 *
 * @param staticPayload The merchant's static QRIS string.
 * @param amount Whole-rupiah amount to embed.
 */
export function staticToDynamicQris(
  staticPayload: string,
  amount: number,
): string {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new MerchantIdError(
      "QRIS_PARSE_ERROR",
      "QRIS amount must be a positive integer",
    );
  }

  // Verify the source checksum before trusting the payload. This function
  // recomputes a *fresh* CRC over whatever it is given, so a corrupted or
  // hand-edited payload — a swapped merchant PAN, say — would otherwise be
  // re-emitted as a perfectly valid QR that redirects the payment. The
  // checksum is the only integrity signal available, so it is checked here,
  // at the single point where a static payload becomes a payable one.
  if (!isValidQrisChecksum(staticPayload)) {
    throw new MerchantIdError(
      "QRIS_PARSE_ERROR",
      "QRIS checksum is invalid; refusing to build a payable QR from it",
    );
  }

  const map = parseEmv(staticPayload);

  if (!map.has(TAG_PAYLOAD_FORMAT)) {
    throw new MerchantIdError(
      "QRIS_PARSE_ERROR",
      "Input does not look like a QRIS payload (missing tag 00)",
    );
  }

  map.set(TAG_POINT_OF_INITIATION, POI_DYNAMIC);
  map.set(TAG_TRANSACTION_AMOUNT, String(amount));

  return buildEmv(map);
}

/** Validate the trailing CRC of a QRIS payload. */
export function isValidQrisChecksum(payload: string): boolean {
  if (payload.length < 8) return false;
  const withoutCrc = payload.slice(0, -4);
  const provided = payload.slice(-4).toUpperCase();
  return crc16ccitt(withoutCrc) === provided;
}

export const QRIS_TAGS = {
  payloadFormat: TAG_PAYLOAD_FORMAT,
  pointOfInitiation: TAG_POINT_OF_INITIATION,
  transactionAmount: TAG_TRANSACTION_AMOUNT,
  crc: TAG_CRC,
  poiStatic: POI_STATIC,
  poiDynamic: POI_DYNAMIC,
} as const;
