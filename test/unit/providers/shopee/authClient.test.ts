import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../../src/core/errors.js";
import { SHOPEE_DEVICE_RISK_BLOB } from "../../../../src/providers/shopee/deviceRisk.js";
import { ShopeeProvider } from "../../../../src/providers/shopee/shopeeProvider.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";
import type { RecordedRequest } from "../../../helpers/http.js";

const TEST_RISK_TOKEN = "risk.token.test|abc|def|08|3";
const TEST_PASSWORD_HASH =
  "b7e28d2e40044c34b6f074d65c954f17489ed8666e6ceae1dba6d1ff5cb88504";

/**
 * Replies for the full requestOtp sequence of a password-protected account:
 * passport bootstrap page, the device-risk report, the migration check, the
 * existence check, the password step (48401102 = password accepted, OTP
 * required), the OTP settings, and the send itself.
 */
function otpReplies(
  overrides: Partial<{
    passwordError: number;
    passwordData: Record<string, unknown>;
  }> = {},
) {
  return [
    new Response("<html></html>", { status: 200 }),
    jsonResponse(200, {
      code: 0,
      msg: "success",
      data: { riskToken: TEST_RISK_TOKEN },
    }),
    jsonResponse(200, { error: 0, data: { need_migrate: false } }),
    jsonResponse(200, {
      error: 0,
      data: {
        has_password: true,
        otp_channel: [3, 1, 2],
        otp_default_channel: 3,
      },
    }),
    jsonResponse(200, {
      error: overrides.passwordError ?? 0,
      data: overrides.passwordData ?? {
        toc_account: { has_password: false },
      },
    }),
    jsonResponse(200, {
      error: 0,
      data: { available_channel_list: [3], default_channel: 3 },
    }),
    jsonResponse(200, { error: 0, data: { seed: "seed" } }),
  ];
}

function phoneOf(body: unknown): string | undefined {
  return (body as { phone?: string } | undefined)?.phone;
}

/** The account POSTs after the bootstrap GET and the df report. */
function accountCalls(requests: RecordedRequest[]) {
  return requests.slice(2);
}

describe("ShopeeProvider.requestOtp phone normalization", () => {
  it("rewrites a local 0-prefixed number to Shopee's required 62 form", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("0812-3456-7890");

    expect(challenge.phoneNumber).toBe("6281234567890");
    expect(requests[2]?.url).toContain("/check_password_migrate");
    // Every account call in the sequence must carry the normalized number.
    for (const request of accountCalls(requests)) {
      expect(phoneOf(request.body)).toBe("6281234567890");
    }
  });

  it("prefixes a bare subscriber number with the country code", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("81234567890");

    expect(challenge.phoneNumber).toBe("6281234567890");
    expect(phoneOf(requests[2]?.body)).toBe("6281234567890");
  });

  it("keeps an already-international number and strips separators", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("+62 812-3456-7890");

    expect(challenge.phoneNumber).toBe("6281234567890");
    expect(phoneOf(requests[2]?.body)).toBe("6281234567890");
  });

  it("rejects a number that has no digits", async () => {
    const { fetch } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    await expect(provider.requestOtp("----")).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("ShopeeProvider.requestOtp device-risk token", () => {
  it("acquires a signed risk token and echoes it on every account call", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("0812-3456-7890");

    expect(requests[0]?.url).toContain("/login");
    expect(requests[1]?.url).toContain("df.infra.sz.shopee.co.id");
    expect(challenge.deviceFingerprint).toBe(TEST_RISK_TOKEN);
    // The fraud-header echo accompanies every authenticated account call.
    for (const request of accountCalls(requests)) {
      expect(request.headers["af-ac-enc-sz-token"]).toBe(TEST_RISK_TOKEN);
      expect(request.headers["x-sz-sdk-version"]).toBe("1.12.26-user.1");
    }
    // The risk token is also carried in the body of every account call that
    // carries more than the bare phone number (check_password_migrate sends
    // only the phone, mirroring the reference capture).
    for (const request of requests.slice(4)) {
      const body = request.body as Record<string, unknown>;
      expect(body.security_device_fingerprint).toBe(TEST_RISK_TOKEN);
    }
  });

  it("fails loudly when the risk service returns no token", async () => {
    const { fetch } = scriptedFetch([
      new Response("<html></html>", { status: 200 }),
      jsonResponse(200, { code: 0, msg: "success", data: {} }),
    ]);
    const provider = new ShopeeProvider({ fetch });

    await expect(provider.requestOtp("0812-3456-7890")).rejects.toThrow();
  });

  it("follows the exact browser order and mimics the desktop client identity", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    await provider.requestOtp("0812-3456-7890");

    const paths = requests.map((request) => new URL(request.url).pathname);
    expect(paths).toEqual([
      "/login",
      "/v2/shpsec/web/report",
      "/api/v4/account/business/check_password_migrate",
      "/api/v4/account/business/check_account_exist_by_password",
      "/api/v4/account/business/authenticate_toc_by_password",
      "/api/v4/account/business/get_otp_settings",
      "/api/v4/account/business/send_otp",
    ]);
    // The reference capture sends only the phone number on the migration check.
    const migrateBody = requests[2]?.body as Record<string, unknown>;
    expect(migrateBody).toEqual({ phone: "6281234567890" });
    // Every account call presents the passport SPA referrer, byte-identical to
    // the reference capture. The fraud gateway uses request context to decide
    // whether an OTP is really delivered.
    const expectedReferer =
      "https://partner.business.accounts.shopee.co.id/authenticate/login/?lang=id&should_hide_back=true&state=https%3A%2F%2Fpartner.shopee.co.id%2F%3Fbusiness_next%3Dhttps%253A%252F%252Fpartner.shopee.co.id%252Flogin%252Fauth%26business_state%3Dhttps%253A%252F%252Fpartner.shopee.co.id%26business_client_id%3D1&client_id=5&next=https%3A%2F%2Fpartner.shopee.co.id%2Faccount%2Flogin%2Fauth";
    for (const request of accountCalls(requests)) {
      expect(request.headers.referer).toBe(expectedReferer);
      expect(request.headers["sec-fetch-site"]).toBe("same-origin");
      expect(request.headers.priority).toBe("u=0");
    }
    // The existence check mirrors the browser body: phone plus the password
    // hash (empty when the account has none). It does not carry the device
    // fingerprint, and its non-zero envelope is a lookup result, not a failure.
    const existBody = requests[3]?.body as Record<string, unknown>;
    expect(existBody).toEqual({
      phone: "6281234567890",
      password: "",
    });
    // Every call uses the observed desktop Firefox identity.
    for (const request of requests) {
      expect(request.headers["user-agent"]).toContain("Firefox/153.0");
    }
  });
});

describe("ShopeeProvider.requestOtp device-risk report body", () => {
  it("posts the telemetry blob verbatim to obtain the full-strength token", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    await provider.requestOtp("0812-3456-7890", {
      deviceReport: "TELEMETRY_BLOB",
    });

    const report = requests[1];
    expect(report?.url).toContain("df.infra.sz.shopee.co.id");
    expect(report?.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(report?.body).toBe("TELEMETRY_BLOB");
    expect(report?.headers.szdet).toMatch(/^\d+$/);
  });

  it("uses the provider-level deviceReport when the request omits it", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({
      fetch,
      deviceReport: "CONFIG_BLOB",
    });

    await provider.requestOtp("0812-3456-7890");

    expect(requests[1]?.body).toBe("CONFIG_BLOB");
  });

  it("falls back to an empty JSON report when no telemetry is configured", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    await provider.requestOtp("0812-3456-7890");

    const report = requests[1];
    expect(report?.headers["content-type"]).toBe("application/json");
    expect(report?.body).toEqual({});
    expect(report?.headers.szdet).toBeUndefined();
  });

  it("ships a telemetry blob in the reference capture's shape", () => {
    expect(SHOPEE_DEVICE_RISK_BLOB.length).toBeGreaterThan(10_000);
    expect(/[\r\n\t]/.test(SHOPEE_DEVICE_RISK_BLOB)).toBe(false);
  });
});

describe("ShopeeProvider.requestOtp password second factor", () => {
  it("hashes the password and runs the password step before the OTP settings", async () => {
    const { fetch, requests } = scriptedFetch(
      otpReplies({
        passwordError: 48401102,
        passwordData: { toc_account: { has_password: true, userid: 42 } },
      }),
    );
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("0812-3456-7890", {
      password: "hunter2",
    });

    const passwordCall = requests[4];
    expect(passwordCall?.url).toContain("authenticate_toc_by_password");
    expect((passwordCall?.body as Record<string, unknown>).password).toBe(
      TEST_PASSWORD_HASH,
    );
    expect(challenge.hasPassword).toBe(true);
  });

  it("sends an empty password hash for passwordless accounts", async () => {
    const { fetch, requests } = scriptedFetch(otpReplies());
    const provider = new ShopeeProvider({ fetch });

    const challenge = await provider.requestOtp("0812-3456-7890");

    expect((requests[4]?.body as Record<string, unknown>).password).toBe("");
    expect(challenge.hasPassword).toBe(false);
  });

  it("asks for the password when the account is password-protected", async () => {
    const { fetch } = scriptedFetch(
      otpReplies({
        passwordError: 48401102,
        passwordData: { toc_account: { has_password: true } },
      }),
    );
    const provider = new ShopeeProvider({ fetch });

    await expect(provider.requestOtp("0812-3456-7890")).rejects.toThrow(
      /password/i,
    );
  });

  it("fails when Shopee rejects the password", async () => {
    const { fetch } = scriptedFetch(
      otpReplies({
        passwordError: 48401004,
        passwordData: undefined,
      }),
    );
    const provider = new ShopeeProvider({ fetch });

    await expect(
      provider.requestOtp("0812-3456-7890", { password: "wrong" }),
    ).rejects.toThrow(/password/i);
  });
});
