import { describe, expect, it } from "vitest";
import { crc16ccitt } from "../../../src/utils/crc16.js";
import {
  parseEmv,
  buildEmv,
  encodeTlv,
  staticToDynamicQris,
  isValidQrisChecksum,
  QRIS_TAGS,
} from "../../../src/qris/qris.js";

// A minimal but structurally valid static QRIS-like payload for testing.
// Tags: 00 (format), 01 (POI=11 static), 59 (name), then CRC (63).
function makeStaticQris(): string {
  const body = "000201" + "010211" + "5905ATMOS";
  const withCrcHeader = `${body}6304`;
  return `${withCrcHeader}${crc16ccitt(withCrcHeader)}`;
}

describe("crc16ccitt", () => {
  it("matches known EMVCo checksum vector", () => {
    // "123456789" under CRC-16/CCITT-FALSE => 0x29B1
    expect(crc16ccitt("123456789")).toBe("29B1");
  });

  it("checksums UTF-8 bytes, not UTF-16 code units", () => {
    // "É" is one code unit but two UTF-8 bytes. Checksumming code units would
    // disagree with every scanner and with the QRIS the acquirer issued, so a
    // legitimate non-ASCII merchant QRIS would be rejected as corrupt.
    // Reference values computed over the UTF-8 bytes.
    expect(crc16ccitt("CAFÉ ANE")).toBe("7628");
    expect(crc16ccitt("KOPI ☕")).toBe("3485");
  });
});

describe("parseEmv / buildEmv", () => {
  it("round-trips a payload and recomputes a valid CRC", () => {
    const payload = makeStaticQris();
    const map = parseEmv(payload);
    expect(map.get(QRIS_TAGS.payloadFormat)).toBe("01");
    expect(map.get(QRIS_TAGS.pointOfInitiation)).toBe("11");

    const rebuilt = buildEmv(map);
    expect(isValidQrisChecksum(rebuilt)).toBe(true);
  });
});

describe("staticToDynamicQris", () => {
  it("injects amount, flips POI to dynamic, and keeps a valid checksum", () => {
    const staticPayload = makeStaticQris();
    const dynamic = staticToDynamicQris(staticPayload, 10001);

    const map = parseEmv(dynamic);
    expect(map.get(QRIS_TAGS.pointOfInitiation)).toBe(QRIS_TAGS.poiDynamic);
    expect(map.get(QRIS_TAGS.transactionAmount)).toBe("10001");
    expect(isValidQrisChecksum(dynamic)).toBe(true);
  });

  it("rejects non-positive or non-integer amounts", () => {
    const staticPayload = makeStaticQris();
    expect(() => staticToDynamicQris(staticPayload, 0)).toThrow();
    expect(() => staticToDynamicQris(staticPayload, 1.5)).toThrow();
  });

  it("rejects payloads without tag 00", () => {
    expect(() => staticToDynamicQris("0102115905ATMOS", 100)).toThrow();
  });

  it("refuses a tampered payload instead of re-signing it", () => {
    // The function recomputes a fresh CRC, so without this gate a swapped
    // merchant PAN would come back out as a perfectly valid QR pointing at the
    // attacker's account. The stale checksum is the only signal that the
    // payload was altered.
    const valid = makeStaticQris();
    const tampered = valid.replace("5905ATMOS", "5905EVILX");
    expect(tampered).not.toBe(valid);

    expect(() => staticToDynamicQris(tampered, 10001)).toThrow(
      /checksum is invalid/,
    );
  });

  it("keeps a non-ASCII merchant name byte-accurate end to end", () => {
    // Tag 59 "CAFÉ ANE" is 8 characters but 9 UTF-8 bytes; declaring 08 would
    // truncate the name for the payer's app and invalidate the checksum.
    const body = "000201" + "010211" + "5909CAFÉ ANE";
    const staticPayload = `${body}6304${crc16ccitt(`${body}6304`)}`;
    expect(isValidQrisChecksum(staticPayload)).toBe(true);

    const dynamic = staticToDynamicQris(staticPayload, 10001);
    expect(dynamic).toContain("5909CAFÉ ANE");
    expect(parseEmv(dynamic).get("59")).toBe("CAFÉ ANE");
    expect(isValidQrisChecksum(dynamic)).toBe(true);
  });
});

describe("parseEmv hardening", () => {
  it("rejects a truncated TLV instead of re-emitting corrupt data", () => {
    // Tag 59 declares 5 bytes but only 2 remain. Accepting this produced a
    // payload carrying a freshly computed, valid CRC over corrupted data.
    expect(() => parseEmv("000201" + "010211" + "5905" + "AT")).toThrow(
      /Malformed QRIS payload/,
    );
  });

  it("rejects a non-numeric length rather than silently mis-slicing", () => {
    expect(() => parseEmv("000201" + "015A" + "1")).toThrow(
      /Malformed QRIS payload/,
    );
  });

  it("rejects a trailing fragment too short to hold a TLV header", () => {
    expect(() => parseEmv("000201" + "01")).toThrow(/Malformed QRIS payload/);
  });
});

describe("encodeTlv", () => {
  it("measures length in UTF-8 bytes", () => {
    expect(encodeTlv("59", "CAFÉ")).toBe("5905CAFÉ");
  });

  it("refuses a value that cannot fit a two-digit length", () => {
    // A 100-byte value previously emitted length "100", producing a payload
    // that carried a valid CRC yet could not be parsed back.
    expect(() => encodeTlv("59", "X".repeat(100))).toThrow(/99-byte limit/);
  });
});
