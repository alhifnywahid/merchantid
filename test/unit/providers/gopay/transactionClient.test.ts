import { describe, expect, it } from "vitest";
import { TransactionClient } from "../../../../src/api/transactionClient.js";
import {
  DEFAULT_TRANSACTION_PAGE_SIZE,
  MAX_TRANSACTION_PAGE_SIZE,
} from "../../../../src/core/constants.js";
import { HttpClient, type FetchLike } from "../../../../src/http/httpClient.js";
import { matchesPayment } from "../../../../src/payment/paymentMatcher.js";
import type { Payment } from "../../../../src/core/types.js";

const MERCHANT_ID = "G000000001";

/**
 * Shaped after a real `merchant-analytics/v2` response for a Rp 3.001 QRIS
 * payment, with identifiers replaced by placeholders.
 *
 * The amounts are the point of this fixture and are reproduced exactly as the
 * feed sends them: money arrives in ISO 4217 minor units, so Rp 3.001 is
 * reported as 300100.
 */
const FEED_TRANSACTION = {
  id: "00000000-0000-7000-8000-000000000001",
  order_id: "QRIS-0000000000000000000000000000",
  merchant_id: MERCHANT_ID,
  transaction_status: "SETTLEMENT",
  payment_type: "QRIS",
  transaction_time: "2026-07-25T19:09:07+07:00",
  settlement_time: "2026-07-25T19:09:07.657584+07:00",
  gross_amount: 300100,
  real_gross_amount: 300100,
  currency: "IDR",
  transaction_source: "GOPAY_INSTORE",
};

function clientReturning(transactions: unknown[]): {
  client: TransactionClient;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    urls.push(String(input));
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          from: 0,
          size: 20,
          total: transactions.length,
          transactions,
        }),
    } as unknown as Response;
  }) as unknown as FetchLike;

  const http = new HttpClient({
    baseUrl: "https://api.test",
    fetch: fetchImpl,
  });
  return { client: new TransactionClient(http), urls };
}

const QUERY = {
  startTime: new Date("2026-07-25T00:00:00Z"),
  endTime: new Date("2026-07-26T00:00:00Z"),
};

describe("TransactionClient amount normalization", () => {
  // Regression guard for a defect that made settlement detection impossible:
  // the feed's minor units were compared directly against whole-rupiah payment
  // intents, so 300100 was tested against 3001 and never matched.
  it("converts minor units in the feed to whole rupiah", async () => {
    const { client } = clientReturning([FEED_TRANSACTION]);

    const [tx] = await client.list(MERCHANT_ID, QUERY);

    expect(tx?.grossAmount).toBe(3001);
    expect(tx?.realGrossAmount).toBe(3001);
  });

  it("keeps the untouched minor-unit values on raw", async () => {
    const { client } = clientReturning([FEED_TRANSACTION]);

    const [tx] = await client.list(MERCHANT_ID, QUERY);

    expect((tx?.raw as { gross_amount: number }).gross_amount).toBe(300100);
  });

  it("leaves a sub-rupiah amount fractional rather than rounding it", async () => {
    const { client } = clientReturning([
      { ...FEED_TRANSACTION, gross_amount: 300150, real_gross_amount: 300150 },
    ]);

    const [tx] = await client.list(MERCHANT_ID, QUERY);

    // Rounding here could manufacture a false match against a Rp 3.001 order.
    expect(tx?.grossAmount).toBe(3001.5);
  });

  it("omits realGrossAmount when the feed does not send it", async () => {
    const { client } = clientReturning([
      { ...FEED_TRANSACTION, real_gross_amount: undefined },
    ]);

    const [tx] = await client.list(MERCHANT_ID, QUERY);

    expect(tx?.grossAmount).toBe(3001);
    expect(tx?.realGrossAmount).toBeUndefined();
  });

  it("returns an empty list when the feed has no transactions", async () => {
    const { client } = clientReturning([]);
    await expect(client.list(MERCHANT_ID, QUERY)).resolves.toEqual([]);
  });
});

describe("TransactionClient query construction", () => {
  it("sends the default status and payment-type filters", async () => {
    const { client, urls } = clientReturning([]);
    await client.list(MERCHANT_ID, QUERY);

    const url = new URL(urls[0]!);
    expect(url.searchParams.get("merchant_ids")).toBe(MERCHANT_ID);
    expect(url.searchParams.get("statuses")).toBe("settlement,capture");
    expect(url.searchParams.get("payment_types")).toBe("qris,gopay");
  });

  it("omits a filter when an explicit empty array is passed", async () => {
    const { client, urls } = clientReturning([]);
    await client.list(MERCHANT_ID, {
      ...QUERY,
      statuses: [],
      paymentTypes: [],
    });

    const url = new URL(urls[0]!);
    expect(url.searchParams.has("statuses")).toBe(false);
    expect(url.searchParams.has("payment_types")).toBe(false);
  });

  // Regression guard: the feed validates `size` with max=100 and answers 422 for
  // anything larger, which failed every poll instead of returning fewer rows.
  it("clamps the page size to the maximum the feed accepts", async () => {
    const { client, urls } = clientReturning([]);
    await client.list(MERCHANT_ID, { ...QUERY, size: 500 });

    expect(new URL(urls[0]!).searchParams.get("size")).toBe(
      String(MAX_TRANSACTION_PAGE_SIZE),
    );
  });

  it("never requests more than the maximum by default", async () => {
    const { client, urls } = clientReturning([]);
    await client.list(MERCHANT_ID, {
      ...QUERY,
      size: DEFAULT_TRANSACTION_PAGE_SIZE,
    });

    const size = Number(new URL(urls[0]!).searchParams.get("size"));
    expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_PAGE_SIZE);
  });

  it("passes a smaller page size through untouched", async () => {
    const { client, urls } = clientReturning([]);
    await client.list(MERCHANT_ID, { ...QUERY, size: 25 });

    expect(new URL(urls[0]!).searchParams.get("size")).toBe("25");
  });
});

describe("end-to-end settlement of a real payment", () => {
  // The exact scenario that stayed pending forever in the playground.
  it("settles the Rp 3.001 intent once amounts share a scale", async () => {
    const createdAt = Date.parse("2026-07-25T19:08:42+07:00");
    const payment: Payment = {
      id: "pay_ms0bsjefxu2avj",
      baseAmount: 3000,
      uniqueOffset: 1,
      uniqueAmount: 3001,
      status: "pending",
      createdAt,
      expiresAt: createdAt + 5 * 60 * 1000,
    };

    const { client } = clientReturning([FEED_TRANSACTION]);
    const [tx] = await client.list(MERCHANT_ID, QUERY);

    expect(tx).toBeDefined();
    expect(matchesPayment(payment, tx!)).toBe(true);
  });
});
