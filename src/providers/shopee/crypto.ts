import { ConfigError } from "../../core/errors.js";

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
] as const;

const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) | 0,
);

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** Pure JavaScript MD5 used only for Shopee's password wire transform. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index++) {
      let mixed: number;
      let wordIndex: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const previousD = d;
      d = c;
      c = b;
      const sum =
        (a +
          mixed +
          (MD5_CONSTANTS[index] ?? 0) +
          view.getInt32(offset + wordIndex * 4, true)) |
        0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index] ?? 0)) | 0;
      a = previousD;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0]
    .flatMap((word) => [
      word & 0xff,
      (word >>> 8) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 24) & 0xff,
    ])
    .map(toHexByte)
    .join("");
}

interface SubtleCryptoLike {
  digest(algorithm: string, data: ArrayBufferView): Promise<ArrayBuffer>;
}

interface WebCryptoLike {
  subtle?: SubtleCryptoLike;
}

/** SHA-256 as lowercase hexadecimal using the runtime Web Crypto API. */
export async function sha256Hex(input: string): Promise<string> {
  const crypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!crypto?.subtle) {
    throw new ConfigError("Web Crypto SHA-256 is unavailable in this runtime");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), toHexByte).join("");
}

/** Shopee password wire format: SHA-256 over the lowercase MD5 hex digest. */
export async function hashShopeePassword(password: string): Promise<string> {
  return sha256Hex(md5Hex(password));
}
