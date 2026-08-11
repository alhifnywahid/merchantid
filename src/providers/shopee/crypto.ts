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

/** Round constants: the first 32 bits of the fractional parts of the cube
 *  roots of the first 64 primes (FIPS 180-4). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Pure JavaScript SHA-256 (FIPS 180-4), used when the runtime has no Web
 * Crypto.
 *
 * `globalThis.crypto` is absent on Node 18 unless started with
 * `--experimental-global-webcrypto`, and Node 18 is inside this package's
 * supported range. Without this fallback, Shopee's password step throws on
 * exactly the runtime the manifest promises to support. MD5 above is
 * hand-rolled for the same reason - the wire format needs it and no runtime
 * offers it - so the module stays self-sufficient rather than conditional on
 * an API that is not universally present.
 */
function sha256Digest(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  // Length is a 64-bit big-endian count of bits; the high word matters only
  // for inputs above 512 MB but is written correctly regardless.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const previous = schedule[index - 15] as number;
      const recent = schedule[index - 2] as number;
      const s0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const s1 =
        rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[index] =
        ((schedule[index - 16] as number) +
          s0 +
          (schedule[index - 7] as number) +
          s1) >>>
        0;
    }

    let a = hash[0] as number;
    let b = hash[1] as number;
    let c = hash[2] as number;
    let d = hash[3] as number;
    let e = hash[4] as number;
    let f = hash[5] as number;
    let g = hash[6] as number;
    let h = hash[7] as number;

    for (let index = 0; index < 64; index++) {
      const S1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h +
          S1 +
          choose +
          (SHA256_K[index] as number) +
          (schedule[index] as number)) >>>
        0;
      const S0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
    hash[5] = ((hash[5] as number) + f) >>> 0;
    hash[6] = ((hash[6] as number) + g) >>> 0;
    hash[7] = ((hash[7] as number) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 8; index++) {
    digestView.setUint32(index * 4, hash[index] as number);
  }
  return digest;
}

/**
 * SHA-256 as lowercase hexadecimal. Uses the runtime's Web Crypto when present
 * and falls back to the bundled implementation otherwise, so the function is
 * available on every runtime this package claims to support.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const crypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest), toHexByte).join("");
  }
  return Array.from(sha256Digest(encoded), toHexByte).join("");
}

/** Shopee password wire format: SHA-256 over the lowercase MD5 hex digest. */
export async function hashShopeePassword(password: string): Promise<string> {
  return sha256Hex(md5Hex(password));
}
