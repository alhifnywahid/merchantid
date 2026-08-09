import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../../src/core/errors.js";
import { ShopeeProvider } from "../../../../src/providers/shopee/shopeeProvider.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";
import {
  SHOPEE_MERCHANT_ID,
  SHOPEE_STORE_ONE_ID,
  SHOPEE_STORE_TWO_ID,
  syntheticShopeeSession,
} from "../../../fixtures/shopee.js";

/** The dashboard token cookie a merchant copies after logging in officially. */
function importToken(): string {
  const cookie = syntheticShopeeSession().cookies[0];
  if (!cookie) throw new Error("fixture is missing the token cookie");
  return cookie.value;
}

function discoveryReplies() {
  return [
    // GetUserInfo (merchant profile) — partner envelope.
    jsonResponse(200, {
      errorCode: 0,
      data: {
        merchantId: Number(SHOPEE_MERCHANT_ID),
        merchantName: "Dev Lab Merchant",
        store_id: Number(SHOPEE_STORE_ONE_ID),
        tobUserId: 90001,
        tocUid: 90001,
        userName: "Owner",
        language: "id",
        shopeepay_service_status: 1,
      },
    }),
    // get-store-list — payment envelope.
    jsonResponse(200, {
      code: 0,
      data: {
        list: [
          {
            storeId: Number(SHOPEE_STORE_ONE_ID),
            storeName: "Store One",
            status: 1,
          },
          {
            storeId: Number(SHOPEE_STORE_TWO_ID),
            storeName: "Store Two",
            status: 1,
          },
        ],
        storeCount: 2,
      },
    }),
  ];
}

describe("ShopeeProvider.importSession", () => {
  it("adopts a session from the official-login token without any OTP call", async () => {
    const { fetch } = scriptedFetch(discoveryReplies());
    const provider = new ShopeeProvider({ fetch });

    const session = await provider.importSession(importToken());

    expect(provider.authenticated).toBe(true);
    expect(session.merchant.id).toBe(SHOPEE_MERCHANT_ID);
    expect(session.stores.map((store) => store.id)).toEqual([
      SHOPEE_STORE_ONE_ID,
      SHOPEE_STORE_TWO_ID,
    ]);
    // A single store from the profile is auto-selected, giving a usable scope.
    expect(provider.getPaymentScope()).toEqual({
      provider: "shopee",
      accountId: SHOPEE_MERCHANT_ID,
      merchantId: SHOPEE_STORE_ONE_ID,
    });
  });

  it("retries store discovery unfiltered when the service filter hides every store", async () => {
    // Some merchants own stores carrying neither service in the dashboard's
    // `serviceList` filter, so the filtered query returns an empty list and the
    // merchant looks store-less. Discovery must fall back to the unfiltered
    // query rather than leaving the merchant without any selectable scope.
    const { fetch, requests } = scriptedFetch([
      jsonResponse(200, {
        errorCode: 0,
        data: {
          merchantId: Number(SHOPEE_MERCHANT_ID),
          merchantName: "Dev Lab Merchant",
          store_id: Number(SHOPEE_STORE_TWO_ID),
          tobUserId: 90001,
          tocUid: 90001,
          userName: "Owner",
          language: "id",
          shopeepay_service_status: 1,
        },
      }),
      // Filtered query: the merchant's stores match no listed service.
      jsonResponse(200, { code: 0, data: { list: [] } }),
      // Unfiltered retry: the stores are really there.
      jsonResponse(200, {
        code: 0,
        data: {
          list: [
            {
              storeId: Number(SHOPEE_STORE_TWO_ID),
              storeName: "Hidden Store",
              status: 1,
            },
          ],
          storeCount: 1,
        },
      }),
    ]);
    const provider = new ShopeeProvider({ fetch });

    const session = await provider.importSession(importToken());

    expect(session.stores.map((store) => store.id)).toEqual([
      SHOPEE_STORE_TWO_ID,
    ]);
    // The profile's store is auto-selected, so the merchant is usable again.
    expect(provider.getPaymentScope()?.merchantId).toBe(SHOPEE_STORE_TWO_ID);

    const storeCalls = requests.filter((request) =>
      request.url.includes("get-store-list"),
    );
    expect(storeCalls).toHaveLength(2);
    // First attempt mirrors the browser's filter; the retry omits it entirely.
    const first = storeCalls[0]?.body as { data?: Record<string, unknown> };
    const second = storeCalls[1]?.body as { data?: Record<string, unknown> };
    expect(first?.data?.serviceList).toBeDefined();
    expect(second?.data && "serviceList" in second.data).toBe(false);
  });

  it("keeps the filtered result when the service filter already finds stores", async () => {
    // The unfiltered retry must not run for merchants the filter serves, so
    // their store list stays exactly what the dashboard shows.
    const { fetch, requests } = scriptedFetch(discoveryReplies());
    const provider = new ShopeeProvider({ fetch });

    await provider.importSession(importToken());

    expect(
      requests.filter((request) => request.url.includes("get-store-list")),
    ).toHaveLength(1);
  });

  it("persists the imported session through onSessionUpdated", async () => {
    const { fetch } = scriptedFetch(discoveryReplies());
    const persisted: string[] = [];
    const provider = new ShopeeProvider({
      fetch,
      onSessionUpdated: (session) => {
        persisted.push(session.merchant.id);
      },
    });

    await provider.importSession(importToken());

    expect(persisted).toEqual([SHOPEE_MERCHANT_ID]);
  });

  it("rejects an empty token before any request", async () => {
    const { fetch, requests } = scriptedFetch(discoveryReplies());
    const provider = new ShopeeProvider({ fetch });

    await expect(provider.importSession("   ")).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(requests).toHaveLength(0);
  });
});
