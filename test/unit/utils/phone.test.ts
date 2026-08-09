import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import { parseIndonesianMobile } from "../../../src/utils/phone.js";

describe("parseIndonesianMobile", () => {
  const canonical = {
    countryCode: "62",
    subscriber: "81234567890",
    national: "081234567890",
    e164: "6281234567890",
  };

  it.each([
    ["national with leading zero", "081234567890"],
    ["bare subscriber", "81234567890"],
    ["international without plus", "6281234567890"],
    ["international with plus", "+6281234567890"],
    ["spaced and dashed local", "0812-3456-7890"],
    ["spaced international", "+62 812 3456 7890"],
    ["parenthesised", "(0812) 3456-7890"],
    ["double-zero access code", "006281234567890"],
    ["country code with trunk zero", "62081234567890"],
  ])("normalizes %s to a single canonical form", (_label, input) => {
    expect(parseIndonesianMobile(input)).toEqual(canonical);
  });

  it("returns all forms so each provider can pick the shape it needs", () => {
    const parsed = parseIndonesianMobile("0812-3456-7890");
    expect(parsed.subscriber).toBe("81234567890"); // GoPay phone_number
    expect(parsed.e164).toBe("6281234567890"); // Shopee phone
    expect(parsed.national).toBe("081234567890");
    expect(parsed.countryCode).toBe("62");
  });

  it("accepts the shortest and longest plausible mobile numbers", () => {
    // 9-digit subscriber (national 10) is the lower bound.
    expect(parseIndonesianMobile("0812345678").subscriber).toBe("812345678");
    // 13-digit subscriber (national 14) is the upper bound.
    expect(parseIndonesianMobile("08123456789012").subscriber).toBe(
      "8123456789012",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["no digits", "----"],
    ["landline (does not start with 8)", "0217654321"],
    ["foreign / non-8 start", "6512345678"],
    ["too short", "0812345"],
    ["too long", "0812345678901234"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseIndonesianMobile(input)).toThrow(ConfigError);
  });

  it("does not prescribe a format in the error message", () => {
    try {
      parseIndonesianMobile("123");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).not.toMatch(/\b62\b/);
      expect(message).not.toMatch(/\b08\b/);
    }
  });
});
