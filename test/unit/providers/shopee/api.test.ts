import { describe, expect, it } from "vitest";
import {
  ApiError,
  AuthError,
  CaptchaRequiredError,
} from "../../../../src/core/errors.js";
import {
  requireAccountData,
  requirePartnerData,
  requirePaymentData,
} from "../../../../src/providers/shopee/api.js";

const ACCOUNT_ENDPOINT = "/api/v4/account/business/send_otp";
const PARTNER_ENDPOINT = "/nb/mss/partner/example";

describe("requireAccountData", () => {
  it("returns the payload when the account envelope succeeds", () => {
    const data = requireAccountData(
      { error: 0, data: { seed: "abc" } },
      ACCOUNT_ENDPOINT,
    );
    expect(data).toEqual({ seed: "abc" });
  });

  it("names the failing endpoint and numeric code so failures are distinguishable", () => {
    let captured: AuthError | undefined;
    try {
      requireAccountData(
        { error: 4, error_msg: "invalid parameter" },
        ACCOUNT_ENDPOINT,
      );
    } catch (error) {
      captured = error as AuthError;
    }

    expect(captured).toBeInstanceOf(AuthError);
    expect(captured?.code).toBe("AUTH_FAILED");
    expect(captured?.message).toContain(ACCOUNT_ENDPOINT);
    expect(captured?.message).toContain("error 4");
    expect(captured?.message).toContain("invalid parameter");
    expect(captured?.details).toMatchObject({ apiCode: "4" });
  });

  it("keeps a token-like account message out of the surfaced error", () => {
    const leak = "session eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0abcdefghijklmnop";
    let captured: AuthError | undefined;
    try {
      requireAccountData({ error: 7, error_msg: leak }, ACCOUNT_ENDPOINT);
    } catch (error) {
      captured = error as AuthError;
    }

    expect(captured).toBeInstanceOf(AuthError);
    expect(captured?.message).toContain("error 7");
    expect(captured?.message).not.toContain(leak);
    expect(captured?.details).toMatchObject({ reason: undefined });
  });

  it("raises a captcha error before the generic auth failure", () => {
    expect(() =>
      requireAccountData(
        {
          error: 1,
          error_msg: "captcha required",
          data: { captcha_required: true },
        },
        ACCOUNT_ENDPOINT,
      ),
    ).toThrow(CaptchaRequiredError);
  });
});

describe("requirePartnerData", () => {
  it("returns the payload when the partner envelope succeeds", () => {
    const data = requirePartnerData(
      { errorCode: 0, data: { ok: true } },
      PARTNER_ENDPOINT,
    );
    expect(data).toEqual({ ok: true });
  });

  it("maps a known invalid-token code to AUTH_FAILED", () => {
    let captured: AuthError | undefined;
    try {
      requirePartnerData({ errorCode: 200020 }, PARTNER_ENDPOINT);
    } catch (error) {
      captured = error as AuthError;
    }
    expect(captured).toBeInstanceOf(AuthError);
    expect(captured?.code).toBe("AUTH_FAILED");
  });

  it("surfaces a diagnosable ApiError for an unknown partner failure", () => {
    let captured: ApiError | undefined;
    try {
      requirePartnerData(
        { errorCode: 500, errorMsg: "backend unavailable" },
        PARTNER_ENDPOINT,
      );
    } catch (error) {
      captured = error as ApiError;
    }
    expect(captured).toBeInstanceOf(ApiError);
    expect(captured?.apiCode).toBe("500");
    expect(captured?.message).toContain(PARTNER_ENDPOINT);
    expect(captured?.message).toContain("error 500");
    expect(captured?.message).toContain("backend unavailable");
  });
});

describe("requirePaymentData", () => {
  it("returns the payload when the payment envelope succeeds", () => {
    const data = requirePaymentData({ code: 0, data: 42 }, PARTNER_ENDPOINT);
    expect(data).toBe(42);
  });

  it("maps an authentication hint in the message to AUTH_FAILED", () => {
    let captured: AuthError | undefined;
    try {
      requirePaymentData({ code: 10, msg: "invalid token" }, PARTNER_ENDPOINT);
    } catch (error) {
      captured = error as AuthError;
    }
    expect(captured).toBeInstanceOf(AuthError);
    expect(captured?.code).toBe("AUTH_FAILED");
  });
});
