import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/server/lab.server";

/**
 * Error text from this module reaches the browser DOM through the action toast,
 * so anything credential-shaped has to be gone before it gets there. Each case
 * below is a real shape the lab has handled.
 */
describe("redactSensitiveText", () => {
  it("removes a GoPay refresh token (five-segment JWE)", () => {
    // The second segment is empty and the third is short, so a three-segment
    // JWT pattern misses this entirely.
    const jwe =
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..PA3rXfC1lPvXbYqQ.9x3jVbPqZm1nHhTt.QqL8sV2wZzYy";

    expect(redactSensitiveText(`refresh failed: ${jwe}`)).not.toContain(jwe);
  });

  it("removes a three-segment JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyaWQiOiI2MDEyNTA1MzUzIn0.s1gnatureValue0000";

    expect(redactSensitiveText(`token ${jwt}`)).not.toContain(jwt);
  });

  it("removes every pair of a Cookie header, not just the first", () => {
    const header =
      "Cookie: SPC_T_ID=abcdefghijklmnopqrstuvwxyz012345; SPC_R_T_ID=zyxwvutsrqponmlkjihgfedcba543210";
    const redacted = redactSensitiveText(header);

    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted).not.toContain("zyxwvutsrqponmlkjihgfedcba543210");
  });

  it("removes a bare base64 blob with no keyword nearby", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5";

    expect(redactSensitiveText(`unexpected ${blob}`)).not.toContain(blob);
  });

  it("removes an Indonesian mobile number", () => {
    expect(redactSensitiveText("send to 6285655207366")).not.toContain(
      "6285655207366",
    );
    expect(redactSensitiveText("send to 085655207366")).not.toContain(
      "085655207366",
    );
  });

  it("keeps ordinary diagnostic text readable", () => {
    const message = "Shopee rejected the saved session; login again";

    expect(redactSensitiveText(message)).toBe(message);
  });

  it("caps runaway messages", () => {
    expect(redactSensitiveText("x".repeat(2_000)).length).toBeLessThanOrEqual(
      480,
    );
  });
});
