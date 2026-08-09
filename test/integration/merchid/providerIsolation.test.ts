import { describe, expect, it } from "vitest";
import { PaymentService } from "../../../src/payment/paymentService.js";
import { InMemoryPaymentStore } from "../../../src/payment/paymentStore.js";
import { MerchIDError } from "../../../src/core/errors.js";
import type {
  TransactionFeed,
  TransactionFeedQuery,
  TransactionFeedResult,
} from "../../../src/core/provider.js";
import type {
  MerchantTransaction,
  Payment,
  PaymentScope,
} from "../../../src/core/types.js";

class MutableFeed implements TransactionFeed {
  transactions: MerchantTransaction[] = [];
  queries: TransactionFeedQuery[] = [];

  async listRecent(
    query: TransactionFeedQuery,
  ): Promise<TransactionFeedResult> {
    this.queries.push(query);
    return {
      transactions: this.transactions,
      pagesFetched: 1,
      truncated: false,
    };
  }
}

function transaction(options: {
  id: string;
  merchantId: string;
  amount: number;
}): MerchantTransaction {
  return {
    id: options.id,
    orderId: options.id,
    merchantId: options.merchantId,
    status: "completed",
    paymentType: "qris",
    grossAmount: options.amount,
    currency: "IDR",
    transactionTime: new Date().toISOString(),
    raw: {},
  };
}

function service(
  store: InMemoryPaymentStore,
  scope: PaymentScope,
  feed: MutableFeed,
): PaymentService {
  return new PaymentService({
    merchantId: scope.merchantId,
    scope,
    store,
    transactionFeed: feed,
  });
}

describe("provider and store isolation", () => {
  it("allows the same nominal in different scopes and settles only its owner", async () => {
    const store = new InMemoryPaymentStore();
    const gopayFeed = new MutableFeed();
    const shopeeFeed = new MutableFeed();
    const gopayScope = {
      provider: "gopay",
      accountId: "go-account",
      merchantId: "go-outlet",
    };
    const shopeeScope = {
      provider: "shopee",
      accountId: "shopee-merchant",
      merchantId: "shopee-store",
    };
    const gopay = service(store, gopayScope, gopayFeed);
    const shopee = service(store, shopeeScope, shopeeFeed);

    const goPayment = await gopay.createPayment({ amount: 10_000 });
    const shopeePayment = await shopee.createPayment({ amount: 10_000 });
    expect(goPayment.uniqueAmount).toBe(10_001);
    expect(shopeePayment.uniqueAmount).toBe(10_001);

    shopeeFeed.transactions = [
      transaction({
        id: "shopee-transaction",
        merchantId: shopeeScope.merchantId,
        amount: shopeePayment.uniqueAmount,
      }),
    ];

    await expect(shopee.tick()).resolves.toMatchObject({
      paid: [{ id: shopeePayment.id }],
    });
    expect(store.get(shopeePayment.id)?.status).toBe("paid");
    expect(store.get(goPayment.id)?.status).toBe("pending");
    expect(shopeeFeed.queries[0]?.scope).toEqual(shopeeScope);
  });

  it("does not let a transaction from store A settle store B", async () => {
    const store = new InMemoryPaymentStore();
    const feedA = new MutableFeed();
    const feedB = new MutableFeed();
    const scopeA = {
      provider: "shopee",
      accountId: "merchant",
      merchantId: "store-a",
    };
    const scopeB = { ...scopeA, merchantId: "store-b" };
    const serviceA = service(store, scopeA, feedA);
    const serviceB = service(store, scopeB, feedB);
    const paymentB = await serviceB.createPayment({ amount: 20_000 });

    feedA.transactions = [
      transaction({
        id: "store-a-transaction",
        merchantId: scopeA.merchantId,
        amount: paymentB.uniqueAmount,
      }),
    ];

    expect((await serviceA.tick()).paid).toEqual([]);
    expect(store.get(paymentB.id)?.status).toBe("pending");
  });

  it("fails fast when a scoped service sees an active unscoped record", async () => {
    const store = new InMemoryPaymentStore();
    const now = Date.now();
    const ambiguous: Payment = {
      id: "unscoped",
      baseAmount: 10_000,
      uniqueOffset: 1,
      uniqueAmount: 10_001,
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
    };
    store.create(ambiguous);
    const feed = new MutableFeed();
    const scoped = service(
      store,
      { provider: "shopee", accountId: "merchant", merchantId: "store" },
      feed,
    );
    const errors: Error[] = [];
    scoped.on("error", (error) => errors.push(error));

    await expect(scoped.tick()).resolves.toEqual({ paid: [], expired: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MerchIDError);
    expect(errors[0]).toMatchObject({ code: "CONFIG_INVALID" });
    expect(feed.queries).toHaveLength(0);
  });
});
