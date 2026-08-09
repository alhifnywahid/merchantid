import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../../../src/core/errors.js";
import { SHOPEE_LIVE_TOKEN_COOKIE } from "../../../../src/providers/shopee/constants.js";
import {
  ShopeeProvider,
  type ShopeeProviderConfig,
} from "../../../../src/providers/shopee/shopeeProvider.js";
import type { FetchLike } from "../../../../src/http/httpClient.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";
import { syntheticStaticQris } from "../../../fixtures/qris.js";
import {
  SHOPEE_MERCHANT_ID,
  SHOPEE_MERCHANT_TWO_ID,
  SHOPEE_STORE_ONE_ID,
  SHOPEE_STORE_TWO_ID,
  syntheticShopeeSession,
} from "../../../fixtures/shopee.js";

const noNetwork = (async () => {
  throw new Error("network must not be called by this test");
}) as unknown as FetchLike;

function makeProvider(
  options: {
    onSessionUpdated?: ShopeeProviderConfig["onSessionUpdated"];
    withQris?: boolean;
  } = {},
): ShopeeProvider {
  return new ShopeeProvider({
    fetch: noNetwork,
    session: syntheticShopeeSession(),
    staticQris: options.withQris ? syntheticStaticQris() : undefined,
    staticQrisScope: options.withQris
      ? { merchantId: SHOPEE_MERCHANT_ID, storeId: SHOPEE_STORE_ONE_ID }
      : undefined,
    onSessionUpdated: options.onSessionUpdated,
  });
}

describe("ShopeeProvider scope lifecycle", () => {
  it("restores an authenticated session with business merchant + store scope", () => {
    const provider = makeProvider({ withQris: true });

    expect(provider.authenticated).toBe(true);
    expect(provider.getPaymentScope()).toEqual({
      provider: "shopee",
      accountId: SHOPEE_MERCHANT_ID,
      merchantId: SHOPEE_STORE_ONE_ID,
    });
    expect(provider.staticQris).toBe(syntheticStaticQris());
  });

  it("binds each payment and dynamic QRIS to the selected store", async () => {
    const provider = makeProvider({ withQris: true });

    const payment = await provider.createPayment({
      amount: 10_000,
      reference: "scope-check",
    });

    expect(payment.scope).toEqual(provider.getPaymentScope());
    expect(payment.qrString).toBeDefined();
  });

  it("deactivates the old service and hides a QRIS owned by another store", async () => {
    const persisted: string[] = [];
    const provider = makeProvider({
      withQris: true,
      onSessionUpdated: (session) => {
        persisted.push(session.storeId ?? "none");
      },
    });
    const oldService = provider.payments();

    await provider.selectStore(SHOPEE_STORE_TWO_ID);

    expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_TWO_ID);
    expect(provider.staticQris).toBeUndefined();
    expect(oldService.isActive).toBe(false);
    expect(provider.payments()).not.toBe(oldService);
    expect(persisted).toEqual([SHOPEE_STORE_TWO_ID]);
  });

  it("refuses to switch stores while the old scope has a pending payment", async () => {
    const provider = makeProvider();
    await provider.createPayment({ amount: 10_000 });

    await expect(provider.selectStore(SHOPEE_STORE_TWO_ID)).rejects.toThrow(
      /payments are still active/,
    );
    expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_ONE_ID);
  });

  it("rolls back session, active service, and QRIS when persistence fails", async () => {
    const provider = makeProvider({
      withQris: true,
      onSessionUpdated: (session) => {
        if (session.storeId === SHOPEE_STORE_TWO_ID) {
          throw new Error("persistence unavailable");
        }
      },
    });
    const originalService = provider.payments();

    await expect(provider.selectStore(SHOPEE_STORE_TWO_ID)).rejects.toThrow(
      "persistence unavailable",
    );

    expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_ONE_ID);
    expect(provider.staticQris).toBe(syntheticStaticQris());
    expect(originalService.isActive).toBe(true);
    expect(provider.payments()).toBe(originalService);
  });

  it("reuses the original service when returning to a previous scope", async () => {
    const provider = makeProvider();
    const firstScopeService = provider.payments();

    await provider.selectStore(SHOPEE_STORE_TWO_ID);
    await provider.selectStore(SHOPEE_STORE_ONE_ID);

    expect(provider.payments()).toBe(firstScopeService);
    expect(firstScopeService.isActive).toBe(true);
  });

  it("fails a transition started reentrantly from onSessionUpdated", async () => {
    const reentrantError = vi.fn();
    // The callback closes over `provider` but only runs after construction
    // returns, so the reference is resolved by the time it fires.
    const provider: ShopeeProvider = makeProvider({
      onSessionUpdated: async () => {
        await provider.selectStore(SHOPEE_STORE_ONE_ID).catch(reentrantError);
      },
    });

    await provider.selectStore(SHOPEE_STORE_TWO_ID);

    expect(reentrantError).toHaveBeenCalledTimes(1);
    expect(reentrantError.mock.calls[0]?.[0]).toBeInstanceOf(ConfigError);
    expect(reentrantError.mock.calls[0]?.[0]).toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});

describe("ShopeeProvider.selectMerchant", () => {
  const SWITCH_TOKEN = "B:switched-merchant-token";

  /** Dashboard token cookie the SSO exchange sets for a merchant's staff user. */
  function tokenLiveCookie(userid: string, businessId: string): string {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        token: SWITCH_TOKEN,
        userid,
        businessId,
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      }),
    ).toString("base64url");
    return `${header}.${payload}.sig`;
  }

  /**
   * Replies for switching via the login SSO token exchange, NOT SwitchMerchant:
   * GET /authenticate/login/token/ → POST login_toc → GET /account/login/tob/auth
   * (mints the target's dashboard token cookie) → GetUserInfo → get-store-list.
   */
  function ssoSwitchReplies(): ReturnType<typeof jsonResponse>[] {
    return [
      // followGet(token page) — a 200 ends the redirect chain.
      jsonResponse(200, {}),
      // login_toc — account envelope returning the one-time authorization code.
      jsonResponse(200, { error: 0, data: { nonce: "switch-auth-code" } }),
      // followGet(tob/auth) — mints the target merchant's dashboard token cookie.
      jsonResponse(
        200,
        {},
        {
          "set-cookie": `${SHOPEE_LIVE_TOKEN_COOKIE}=${tokenLiveCookie("90002", SHOPEE_MERCHANT_TWO_ID)}; Path=/`,
        },
      ),
      // GetUserInfo for the target merchant — partner envelope.
      jsonResponse(200, {
        errorCode: 0,
        data: {
          merchantId: Number(SHOPEE_MERCHANT_TWO_ID),
          merchantName: "MerchID Dev Merchant North",
          store_id: Number(SHOPEE_STORE_TWO_ID),
          tobUserId: 90002,
          tocUid: 90002,
          userName: "Owner",
          language: "id",
          shopeepay_service_status: 1,
        },
      }),
      // get-store-list for the target merchant — payment envelope.
      jsonResponse(200, {
        code: 0,
        data: {
          list: [
            {
              storeId: Number(SHOPEE_STORE_TWO_ID),
              storeName: "North Outlet",
              status: 1,
            },
          ],
          storeCount: 1,
        },
      }),
    ];
  }

  it("switches merchants by replaying the login token exchange, not SwitchMerchant", async () => {
    const { fetch, requests } = scriptedFetch(ssoSwitchReplies());
    const provider = new ShopeeProvider({
      fetch,
      session: syntheticShopeeSession(),
    });

    const session = await provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID);

    expect(session.merchant.id).toBe(SHOPEE_MERCHANT_TWO_ID);
    expect(session.stores.map((store) => store.id)).toEqual([
      SHOPEE_STORE_TWO_ID,
    ]);
    expect(session.storeId).toBe(SHOPEE_STORE_TWO_ID);
    expect(provider.getPaymentScope()).toEqual({
      provider: "shopee",
      accountId: SHOPEE_MERCHANT_TWO_ID,
      merchantId: SHOPEE_STORE_TWO_ID,
    });

    // The broken SwitchMerchant endpoint must never be called.
    expect(
      requests.some((request) => request.url.includes("/SwitchMerchant")),
    ).toBe(false);
    // It re-runs the login SSO exchange keyed by the target's staff user id.
    expect(requests[0]?.url).toContain("/authenticate/login/token");
    expect(requests[1]?.url).toContain("/login_toc");
    expect(requests[1]?.body).toMatchObject({ tob_userid: 90002 });
    expect(requests[2]?.url).toContain("/account/login/tob/auth");
    // Discovery then runs with the freshly minted token.
    expect(requests[3]?.url).toContain("/GetUserInfo");
    expect(requests[3]?.headers["x-merchant-token"]).toBe(SWITCH_TOKEN);
    expect(requests[4]?.url).toContain("get-store-list");
  });

  it("persists the switched session through onSessionUpdated", async () => {
    const { fetch } = scriptedFetch(ssoSwitchReplies());
    const persisted: string[] = [];
    const provider = new ShopeeProvider({
      fetch,
      session: syntheticShopeeSession(),
      onSessionUpdated: (session) => {
        persisted.push(`${session.merchant.id}:${session.storeId ?? ""}`);
      },
    });

    await provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID);

    expect(persisted).toEqual([
      `${SHOPEE_MERCHANT_TWO_ID}:${SHOPEE_STORE_TWO_ID}`,
    ]);
  });

  it("returns the current session when the merchant is already active", async () => {
    const provider = new ShopeeProvider({
      fetch: noNetwork,
      session: syntheticShopeeSession(),
    });

    const session = await provider.selectMerchant(SHOPEE_MERCHANT_ID);

    expect(session.merchant.id).toBe(SHOPEE_MERCHANT_ID);
  });

  it("rejects a merchant the account cannot access", async () => {
    const provider = new ShopeeProvider({
      fetch: noNetwork,
      session: syntheticShopeeSession(),
    });

    await expect(provider.selectMerchant("99999")).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("requires a fresh login when the session lacks switch credentials", async () => {
    const session = syntheticShopeeSession();
    delete session.switchCredential;
    const provider = new ShopeeProvider({ fetch: noNetwork, session });

    await expect(
      provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID),
    ).rejects.toThrow(/log in again/);
    expect(provider.activeMerchant?.id).toBe(SHOPEE_MERCHANT_ID);
  });

  it("refuses to switch merchants while a payment is still active", async () => {
    const provider = new ShopeeProvider({
      fetch: noNetwork,
      session: syntheticShopeeSession(),
    });
    await provider.createPayment({ amount: 10_000 });

    await expect(
      provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID),
    ).rejects.toThrow(/payments are still active/);
    expect(provider.getPaymentScope()?.accountId).toBe(SHOPEE_MERCHANT_ID);
  });

  it("rolls back the active merchant when discovery fails after the exchange", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(200, {}), // token page
      jsonResponse(200, { error: 0, data: { nonce: "switch-auth-code" } }), // login_toc
      jsonResponse(
        200,
        {},
        {
          "set-cookie": `${SHOPEE_LIVE_TOKEN_COOKIE}=${tokenLiveCookie("90002", SHOPEE_MERCHANT_TWO_ID)}; Path=/`,
        },
      ), // tob/auth mints the token cookie
      // GetUserInfo fails: the switch must not leave a half-applied session.
      jsonResponse(200, { errorCode: 500, errorMsg: "discovery down" }),
      // get-store-list races in Promise.all; a benign reply avoids queue noise.
      jsonResponse(200, { code: 0, data: { list: [], storeCount: 0 } }),
    ]);
    const provider = new ShopeeProvider({
      fetch,
      session: syntheticShopeeSession(),
    });

    await expect(
      provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID),
    ).rejects.toThrow();

    expect(provider.activeMerchant?.id).toBe(SHOPEE_MERCHANT_ID);
    expect(provider.getPaymentScope()).toEqual({
      provider: "shopee",
      accountId: SHOPEE_MERCHANT_ID,
      merchantId: SHOPEE_STORE_ONE_ID,
    });
  });

  it("exposes every accessible merchant and stays authenticated across a switch", async () => {
    const { fetch } = scriptedFetch(ssoSwitchReplies());
    const provider = new ShopeeProvider({
      fetch,
      session: syntheticShopeeSession(),
    });

    expect(provider.merchants.map((merchant) => merchant.id)).toEqual([
      SHOPEE_MERCHANT_ID,
      SHOPEE_MERCHANT_TWO_ID,
    ]);

    await provider.selectMerchant(SHOPEE_MERCHANT_TWO_ID);

    expect(provider.authenticated).toBe(true);
    expect(provider.activeMerchant?.id).toBe(SHOPEE_MERCHANT_TWO_ID);
  });

  describe("refreshSession", () => {
    it("re-mints the active merchant token while the account session lives", async () => {
      const { fetch, requests } = scriptedFetch([
        // login_status — the account session is still valid.
        jsonResponse(200, { error: 0, data: { userid: 90001 } }),
        // The SSO exchange re-runs for the *current* merchant.
        jsonResponse(200, {}), // token page
        jsonResponse(200, { error: 0, data: { nonce: "renew-auth-code" } }),
        jsonResponse(
          200,
          {},
          {
            "set-cookie": `${SHOPEE_LIVE_TOKEN_COOKIE}=${tokenLiveCookie("90001", SHOPEE_MERCHANT_ID)}; Path=/`,
          },
        ),
      ]);
      const persisted: string[] = [];
      const provider = new ShopeeProvider({
        fetch,
        session: syntheticShopeeSession(),
        onSessionUpdated: (session) => {
          persisted.push(session.merchant.id);
        },
      });

      const session = await provider.refreshSession();

      expect(requests[0]?.url).toContain("/login_status");
      // Renewal targets the merchant already active, not another one.
      expect(requests[2]?.body).toMatchObject({ tob_userid: 90001 });
      expect(session.merchant.id).toBe(SHOPEE_MERCHANT_ID);
      // Scope and stores survive a renewal untouched.
      expect(session.storeId).toBe(SHOPEE_STORE_ONE_ID);
      expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_ONE_ID);
      // The renewed session is persisted so callers cannot keep a stale token.
      expect(persisted).toEqual([SHOPEE_MERCHANT_ID]);
    });

    it("demands a new OTP once the account session is gone", async () => {
      const { fetch } = scriptedFetch([
        // login_status — Shopee no longer recognises the account session.
        jsonResponse(200, { error: 48500102, error_msg: "not login" }),
      ]);
      const provider = new ShopeeProvider({
        fetch,
        session: syntheticShopeeSession(),
      });

      await expect(provider.refreshSession()).rejects.toThrow(
        /log in again with an OTP/,
      );
      // Nothing was mutated by the failed renewal.
      expect(provider.activeMerchant?.id).toBe(SHOPEE_MERCHANT_ID);
      expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_ONE_ID);
    });

    it("refuses to renew a session captured before renewal support", async () => {
      const session = syntheticShopeeSession();
      delete session.switchCredential;
      const provider = new ShopeeProvider({ fetch: noNetwork, session });

      await expect(provider.refreshSession()).rejects.toThrow(
        /log in again with an OTP/,
      );
    });
  });
});
