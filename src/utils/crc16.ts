/**
 * CRC-16/CCITT-FALSE implementation, the checksum algorithm mandated by the
 * EMVCo QR Code specification (and therefore Indonesia's QRIS standard).
 *
 * Parameters: polynomial 0x1021, initial value 0xFFFF, no reflection, no final
 * XOR. The result is rendered as a 4-character uppercase hexadecimal string.
 *
 * The checksum is defined over the payload's **UTF-8 bytes**. That distinction
 * only shows up outside ASCII, but it decides real money: a merchant name like
 * `CAFÉ` is one code unit and two bytes, so checksumming code units disagrees
 * with every scanner and with the QRIS the acquirer issued.
 */

export function crc16ccitt(input: string): string {
  return crc16ccittBytes(new TextEncoder().encode(input));
}

/** CRC-16/CCITT-FALSE over raw bytes, for callers that already have them. */
export function crc16ccittBytes(bytes: Uint8Array): string {
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}
