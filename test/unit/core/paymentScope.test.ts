import { describe, expect, it } from "vitest";
import { samePaymentScope } from "../../../src/core/provider.js";
import { InMemoryPaymentStore } from "../../../src/payment/paymentStore.js";
import type { Payment, PaymentScope } from "../../../src/core/types.js";

const SCOPE: PaymentScope = {
  provider: "shopee",
  accountId: "merchant-1",
  merchantId: "store-1",
};

function pending(id: string, scope?: PaymentScope): Payment {
  return {
    id,
    scope,
    baseAmount: 10_000,
    uniqueOffset: 1,
    uniqueAmount: 10_001,
    status: "pending",
    createdAt: 1,
    expiresAt: 2,
  };
}

describe("samePaymentScope", () => {
  it("requires provider, account, and merchant/store to match", () => {
    expect(samePaymentScope(SCOPE, { ...SCOPE })).toBe(true);
    expect(samePaymentScope(SCOPE, { ...SCOPE, provider: "gopay" })).toBe(
      false,
    );
    expect(samePaymentScope(SCOPE, { ...SCOPE, accountId: "merchant-2" })).toBe(
      false,
    );
    expect(samePaymentScope(SCOPE, { ...SCOPE, merchantId: "store-2" })).toBe(
      false,
    );
  });

  it("distinguishes an absent account from a present account", () => {
    expect(
      samePaymentScope(
        { provider: "gopay", merchantId: "outlet-1" },
        { provider: "gopay", accountId: "account-1", merchantId: "outlet-1" },
      ),
    ).toBe(false);
  });
});

describe("InMemoryPaymentStore scope filtering", () => {
  it("returns only pending payments owned by the requested scope", () => {
    const store = new InMemoryPaymentStore();
    store.create(pending("owned", SCOPE));
    store.create(pending("other-store", { ...SCOPE, merchantId: "store-2" }));
    store.create(pending("other-provider", { ...SCOPE, provider: "gopay" }));
    store.create(pending("unscoped"));

    expect(store.listActive(SCOPE).map((payment) => payment.id)).toEqual([
      "owned",
    ]);
  });

  it("clones scope values at the storage boundary", () => {
    const store = new InMemoryPaymentStore();
    const scope = { ...SCOPE };
    store.create(pending("payment", scope));
    scope.merchantId = "mutated-outside";

    const stored = store.get("payment")!;
    expect(stored.scope).toEqual(SCOPE);
    stored.scope!.merchantId = "mutated-read";
    expect(store.get("payment")?.scope).toEqual(SCOPE);
  });
});
