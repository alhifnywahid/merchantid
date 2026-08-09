import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../../../src/core/errors.js";
import { ShopeeHttpClient } from "../../../../src/providers/shopee/httpClient.js";
import {
  parseShopeeAmount,
  ShopeeTransactionFeed,
} from "../../../../src/providers/shopee/transactionFeed.js";
import {
  SHOPEE_MERCHANT_ID,
  SHOPEE_STORE_ONE_ID,
  syntheticShopeeTransaction,
} from "../../../fixtures/shopee.js";
import { jsonResponse, scriptedFetch } from "../../../helpers/http.js";

const QUERY = {
  scope: {
    provider: "shopee",
    accountId: SHOPEE_MERCHANT_ID,
    merchantId: SHOPEE_STORE_ONE_ID,
  },
  startTime: new Date("2026-07-20T00:00:00.000Z"),
  endTime: new Date("2026-07-21T00:00:00.000Z"),
  pageSize: 50,
  maxPages: 10,
};

function page(list: unknown[], nextPosition = ""): Response {
  return jsonResponse(200, {
    code: 0,
    data: { list, next_position: nextPosition },
  });
}

function feedFrom(replies: Response[], warn = vi.fn()) {
  const script = scriptedFetch(replies);
  const http = new ShopeeHttpClient({ fetch: script.fetch });
  const feed = new ShopeeTransactionFeed(http, {
    token: "synthetic-token",
    merchantId: SHOPEE_MERCHANT_ID,
    storeId: SHOPEE_STORE_ONE_ID,
    logger: {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
    },
  });
  return { feed, requests: script.requests, warn };
}

describe("parseShopeeAmount", () => {
  it.each([
    ["0", 0],
    ["30000", 30_000],
    ["30.000", 30_000],
    ["1.250.000", 1_250_000],
    [" 30.000 ", 30_000],
  ])("parses %j as %i whole rupiah", (input, expected) => {
    expect(parseShopeeAmount(input)).toBe(expected);
  });

  it.each([
    "30.00",
    "30,000",
    "Rp30.000",
    "-30000",
    "30 000",
    "1.2.000",
    "90071992547409920",
    "",
  ])("rejects ambiguous or unsafe value %j", (input) => {
    expect(parseShopeeAmount(input)).toBeUndefined();
  });
});

describe("ShopeeTransactionFeed", () => {
  it("normalizes whole rupiah and only maps status 3 to completed", async () => {
    const { feed } = feedFrom([
      page([
        syntheticShopeeTransaction(),
        syntheticShopeeTransaction({
          transactionId: "tx-shopee-pending",
          amount: "25.000",
          status: 2,
        }),
      ]),
    ]);

    const result = await feed.listRecent(QUERY);

    expect(result).toMatchObject({ pagesFetched: 1, truncated: false });
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      id: "tx-shopee-1",
      grossAmount: 10_001,
      status: "completed",
      currency: "IDR",
      merchantId: SHOPEE_MERCHANT_ID,
    });
    expect(result.transactions[1]).toMatchObject({
      grossAmount: 25_000,
      status: "shopee:2",
      settlementTime: undefined,
    });
  });

  it("owns cursor pagination, deduplicates ids, and sends the verified page cap", async () => {
    const duplicate = syntheticShopeeTransaction();
    const second = syntheticShopeeTransaction({ transactionId: "tx-2" });
    const { feed, requests } = feedFrom([
      page([duplicate], "cursor-1"),
      page([duplicate, second]),
    ]);

    const result = await feed.listRecent(QUERY);

    expect(result.transactions.map((transaction) => transaction.id)).toEqual([
      "tx-shopee-1",
      "tx-2",
    ]);
    expect(result.pagesFetched).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toMatchObject({
      data: { pageSize: 10, next_position: "" },
    });
    expect(requests[1]?.body).toMatchObject({
      data: { next_position: "cursor-1" },
    });
  });

  it("rejects merchant/store/provider scope mismatches before network access", async () => {
    const { feed, requests } = feedFrom([]);

    await expect(
      feed.listRecent({
        ...QUERY,
        scope: { ...QUERY.scope, merchantId: "other-store" },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(requests).toHaveLength(0);
  });

  it("rejects invalid time ranges before network access", async () => {
    const { feed, requests } = feedFrom([]);

    await expect(
      feed.listRecent({
        ...QUERY,
        startTime: new Date("2026-07-22T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/time range/);
    expect(requests).toHaveLength(0);
  });

  it("drops malformed and out-of-scope rows without logging their payload", async () => {
    const warn = vi.fn();
    const { feed } = feedFrom(
      [
        page([
          syntheticShopeeTransaction({ transactionId: "" }),
          syntheticShopeeTransaction({ storeId: 99999 }),
          syntheticShopeeTransaction({ amount: "30.00" }),
        ]),
      ],
      warn,
    );

    const result = await feed.listRecent(QUERY);

    expect(result.transactions).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "ignored malformed or out-of-scope Shopee transactions",
      { count: 3, provider: "shopee" },
    );
  });

  it("fails when a cursor repeats instead of looping forever", async () => {
    const { feed } = feedFrom([page([], "cursor-1"), page([], "cursor-1")]);

    await expect(feed.listRecent(QUERY)).rejects.toThrow(/did not advance/);
  });

  it("marks a result truncated when maxPages is reached", async () => {
    const { feed } = feedFrom([page([syntheticShopeeTransaction()], "more")]);

    await expect(
      feed.listRecent({ ...QUERY, maxPages: 1 }),
    ).resolves.toMatchObject({
      pagesFetched: 1,
      truncated: true,
    });
  });
});
