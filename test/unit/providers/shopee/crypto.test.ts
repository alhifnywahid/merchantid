import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashShopeePassword,
  md5Hex,
  sha256Hex,
} from "../../../../src/providers/shopee/crypto.js";

/**
 * `globalThis.crypto` is absent on Node 18 unless it is started with
 * `--experimental-global-webcrypto`, and Node 18 is inside this package's
 * supported range — so the bundled SHA-256 is the code path that actually runs
 * there. It is verified against Node's own implementation rather than a
 * handful of copied digests, with the block-boundary lengths where padding
 * bugs hide.
 */

/** Run a function with `globalThis.crypto` removed, as on bare Node 18. */
async function withoutWebCrypto<T>(run: () => Promise<T>): Promise<T> {
  vi.stubGlobal("crypto", undefined);
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

const reference = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sha256Hex", () => {
  const vectors = [
    "",
    "a",
    "abc",
    "hunter2",
    // Lengths around the 55/56 and 63/64 byte padding boundaries, where an
    // extra block must be emitted.
    "x".repeat(54),
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(57),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "x".repeat(119),
    "x".repeat(120),
    "x".repeat(255),
    "x".repeat(1000),
    // Multi-byte UTF-8: the digest is over bytes, not code units.
    "Ñ",
    "CAFÉ ANE",
    "kopi ☕ susu",
    "😀😀😀",
    // A realistic input: the MD5 hex digest the Shopee wire format hashes.
    md5Hex("correct horse battery staple"),
  ];

  it.each(vectors)(
    "matches Node's digest for %j (Web Crypto path)",
    async (value) => {
      expect(await sha256Hex(value)).toBe(reference(value));
    },
  );

  it.each(vectors)(
    "matches Node's digest for %j (bundled fallback)",
    async (value) => {
      const digest = await withoutWebCrypto(() => sha256Hex(value));
      expect(digest).toBe(reference(value));
    },
  );

  it("produces the same digest with and without Web Crypto", async () => {
    const value = "the two paths must never disagree";
    const viaWebCrypto = await sha256Hex(value);
    const viaFallback = await withoutWebCrypto(() => sha256Hex(value));

    expect(viaFallback).toBe(viaWebCrypto);
  });
});

describe("hashShopeePassword", () => {
  it("is SHA-256 over the lowercase MD5 hex digest", async () => {
    const expected = reference(md5Hex("hunter2"));

    expect(await hashShopeePassword("hunter2")).toBe(expected);
  });

  it("still works on a runtime without Web Crypto", async () => {
    // The regression this guards: Shopee's password step threw
    // "Web Crypto SHA-256 is unavailable in this runtime" on bare Node 18,
    // making password-protected login impossible on a supported runtime.
    const hashed = await withoutWebCrypto(() => hashShopeePassword("hunter2"));

    expect(hashed).toBe(reference(md5Hex("hunter2")));
  });
});

describe("md5Hex", () => {
  it.each([
    "",
    "a",
    "abc",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "Ñ",
  ])("matches Node's MD5 for %j", (value) => {
    expect(md5Hex(value)).toBe(
      createHash("md5").update(value, "utf8").digest("hex"),
    );
  });
});
