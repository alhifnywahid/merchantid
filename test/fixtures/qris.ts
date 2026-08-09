import { crc16ccitt } from "../../src/utils/crc16.js";

/** Synthetic static QRIS fixture with a computed checksum and no merchant data. */
export function syntheticStaticQris(): string {
  // Tag 59 length must match the value exactly: "DEV LAB" is 7 bytes. The
  // previous "5908" over-declared by one and made the parser swallow the
  // leading "6" of the CRC header, yielding a phantom tag.
  const body = "000201" + "010211" + "5907DEV LAB";
  const withCrcHeader = `${body}6304`;
  return `${withCrcHeader}${crc16ccitt(withCrcHeader)}`;
}
