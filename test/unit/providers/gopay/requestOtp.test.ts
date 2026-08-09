import { describe, expect, it } from "vitest";
import { GopayProvider } from "../../../../src/providers/gopay/gopayProvider.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";

/** Body shape of the GoID login-request call. */
function loginBody(body: unknown): {
  phone_number?: string;
  country_code?: string;
} {
  return (body ?? {}) as { phone_number?: string; country_code?: string };
}

describe("GopayProvider.requestOtp phone normalization", () => {
  it("sends the bare subscriber number and never doubles the country code", async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { success: true, data: { otp_token: "otp-1" } }),
    ]);
    const provider = new GopayProvider({ fetch });

    await provider.requestOtp("+62 812-3456-7890");

    const body = loginBody(requests[0]?.body);
    expect(body.phone_number).toBe("81234567890");
    expect(body.country_code).toBe("62");
  });

  it("normalizes a local 0-prefixed number to the same subscriber form", async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { success: true, data: { otp_token: "otp-1" } }),
    ]);
    const provider = new GopayProvider({ fetch });

    await provider.requestOtp("0812-3456-7890");

    expect(loginBody(requests[0]?.body).phone_number).toBe("81234567890");
  });

  it("rejects a non-Indonesian number before any request is made", async () => {
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, { success: true, data: {} }),
    ]);
    const provider = new GopayProvider({ fetch });

    await expect(provider.requestOtp("+1 415 555 0100")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(requests).toHaveLength(0);
  });
});
