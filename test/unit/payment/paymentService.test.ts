import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "../../../src/payment/paymentService.js";
import { InMemoryPaymentStore } from "../../../src/payment/paymentStore.js";
import { AmountAllocator } from "../../../src/payment/amountAllocator.js";
import { crc16ccitt } from "../../../src/utils/crc16.js";
import {
  isValidQrisChecksum,
  parseEmv,
  QRIS_TAGS,
} from "../../../src/qris/qris.js";
import type {
  MerchantTransaction,
  Payment,
  PaymentStore,
  TransactionLister,
} from "../../../src/core/types.js";

function staticQris(): string {
  const body = "000201" + "010211" + "5905ATMOS";
  const withCrcHeader = `${body}6304`;
  return `${withCrcHeader}${crc16ccitt(withCrcHeader)}`;
}

function makeTx(partial: Partial<MerchantTransaction>): MerchantTransaction {
  return {
    id: "tx",
    orderId: "order",
    merchantId: "G1",
    status: "settlement",
    paymentType: "qris",
    grossAmount: 0,
    currency: "IDR",
    transactionTime: new Date().toISOString(),
    raw: {},
    ...partial,
  };
}

/** Transaction feed stub returning a fixed list. */
function feed(transactions: MerchantTransaction[]): TransactionLister {
  return {
    async list() {
      return transactions;
    },
  };
}

/** Transaction feed stub that always fails, to exercise the error path. */
function failingFeed(message: string): TransactionLister {
  return {
    async list(): Promise<MerchantTransaction[]> {
      throw new Error(message);
    },
  };
}

function makeService(options: {
  transactions: TransactionLister;
  store?: InMemoryPaymentStore;
  withQris?: boolean;
  defaultExpiryMs?: number;
  clockSkewMs?: number;
}): { service: PaymentService; store: InMemoryPaymentStore } {
  const store = options.store ?? new InMemoryPaymentStore();
  const service = new PaymentService({
    merchantId: "G1",
    store,
    transactions: options.transactions,
    staticQris: options.withQris ? staticQris() : undefined,
    allocator: new AmountAllocator(999),
    defaultExpiryMs: options.defaultExpiryMs,
    clockSkewMs: options.clockSkewMs,
  });
  return { service, store };
}

describe("PaymentService.createPayment", () => {
  it("assigns the smallest free offset per base amount", async () => {
    const { service } = makeService({ transactions: feed([]) });

    const first = await service.createPayment({ amount: 10_000 });
    const second = await service.createPayment({ amount: 10_000 });
    const other = await service.createPayment({ amount: 25_000 });

    expect(first.uniqueAmount).toBe(10_001);
    expect(second.uniqueAmount).toBe(10_002);
    // Offsets are tracked per base amount, so a different nominal restarts at 1.
    expect(other.uniqueAmount).toBe(25_001);
  });

  it("reuses an offset once the occupying payment leaves the active set", async () => {
    // clockSkewMs 0 disables the amount quarantine so this test can focus on
    // the release itself; quarantine behavior is locked separately below.
    const { service } = makeService({ transactions: feed([]), clockSkewMs: 0 });

    const first = await service.createPayment({ amount: 10_000 });
    await service.createPayment({ amount: 10_000 });
    await service.cancelPayment(first.id);

    const replacement = await service.createPayment({ amount: 10_000 });
    expect(replacement.uniqueAmount).toBe(10_001);
  });

  it("embeds the unique amount into a dynamic QRIS with a valid checksum", async () => {
    const { service } = makeService({ transactions: feed([]), withQris: true });

    const payment = await service.createPayment({ amount: 10_000 });
    expect(payment.qrString).toBeDefined();

    const tags = parseEmv(payment.qrString!);
    expect(tags.get(QRIS_TAGS.transactionAmount)).toBe("10001");
    expect(tags.get(QRIS_TAGS.pointOfInitiation)).toBe(QRIS_TAGS.poiDynamic);
    expect(isValidQrisChecksum(payment.qrString!)).toBe(true);
  });

  it("omits the QRIS when no static payload is configured", async () => {
    const { service } = makeService({ transactions: feed([]) });
    const payment = await service.createPayment({ amount: 10_000 });
    expect(payment.qrString).toBeUndefined();
  });

  it.each([0, -1, 1.5])("rejects an invalid amount (%s)", async (amount) => {
    const { service } = makeService({ transactions: feed([]) });
    await expect(service.createPayment({ amount })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  // Regression guard: a NaN expiry (easy to produce from a bad date
  // subtraction) created a payment that could never expire nor match,
  // leaking its amount slot forever and pinning the feed window open.
  it.each([Number.NaN, Infinity, -Infinity])(
    "rejects a non-finite expiresInMs (%s)",
    async (expiresInMs) => {
      const { service } = makeService({ transactions: feed([]) });
      await expect(
        service.createPayment({ amount: 10_000, expiresInMs }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    },
  );
});

describe("PaymentService cross-tick settlement integrity", () => {
  // Regression guards for the double-settle hole: a transaction that already
  // settled a payment could settle a SECOND one after its amount slot was
  // freed and re-allocated while the transaction was still inside the new
  // payment's matching window.

  it("never settles a second payment with an already-consumed transaction", async () => {
    // clockSkewMs 0 disables the amount quarantine, so the freed amount is
    // re-allocated immediately - the hostile setup. The unparseable timestamp
    // routes matching through the fail-open path, which skips the window
    // check and would re-match the old transaction on every subsequent tick.
    const tx = makeTx({
      id: "tx-consumed",
      grossAmount: 3_501,
      transactionTime: "not-a-date",
    });
    const { service, store } = makeService({
      transactions: feed([tx]),
      clockSkewMs: 0,
    });

    const first = await service.createPayment({ amount: 3_500 });
    const tick1 = await service.tick();
    expect(tick1.paid).toHaveLength(1);
    expect((await store.get(first.id))?.status).toBe("paid");

    const second = await service.createPayment({ amount: 3_500 });
    expect(second.uniqueAmount).toBe(first.uniqueAmount); // slot reused

    const tick2 = await service.tick();
    expect(tick2.paid).toHaveLength(0);
    expect((await store.get(second.id))?.status).toBe("pending");
  });

  it("quarantines a settled amount while its transaction could still match", async () => {
    // Default skew (60s): the quarantine is two skews, far longer than this
    // test, so the freed 3501 must be skipped by the very next allocation.
    const { service } = makeService({
      transactions: feed([makeTx({ id: "tx-1", grossAmount: 3_501 })]),
    });

    const first = await service.createPayment({ amount: 3_500 });
    expect(first.uniqueAmount).toBe(3_501);
    const result = await service.tick();
    expect(result.paid).toHaveLength(1);

    const second = await service.createPayment({ amount: 3_500 });
    expect(second.uniqueAmount).toBe(3_502);
  });

  it("quarantines the amount of a cancelled payment (cancel-after-pay)", async () => {
    // The buyer may have transferred just before the merchant cancelled, so
    // the amount must not be handed straight to the next same-priced order.
    const { service } = makeService({ transactions: feed([]) });

    const first = await service.createPayment({ amount: 3_500 });
    await service.cancelPayment(first.id);

    const second = await service.createPayment({ amount: 3_500 });
    expect(second.uniqueAmount).toBe(3_502);
  });

  it("releases a quarantined amount once the window has passed", async () => {
    // Tiny skew -> 10ms quarantine; the wait is comfortably past it while the
    // "still quarantined" assertions above use margins of minutes.
    const { service } = makeService({ transactions: feed([]), clockSkewMs: 5 });

    const first = await service.createPayment({ amount: 3_500 });
    await service.cancelPayment(first.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await service.createPayment({ amount: 3_500 });
    expect(second.uniqueAmount).toBe(first.uniqueAmount);
  });
});

describe("PaymentService.tick", () => {
  it("settles a matching transaction and emits paid", async () => {
    const { service, store } = makeService({ transactions: feed([]) });
    const payment = await service.createPayment({ amount: 10_000 });

    const settled = makeService({
      transactions: feed([makeTx({ id: "tx-1", grossAmount: 10_001 })]),
      store,
    }).service;

    const paidEvents: Payment[] = [];
    settled.on("paid", (p) => paidEvents.push(p));

    const result = await settled.tick();

    expect(result.paid).toHaveLength(1);
    expect(paidEvents[0]?.id).toBe(payment.id);
    expect(paidEvents[0]?.transaction?.id).toBe("tx-1");
    expect((await store.get(payment.id))?.status).toBe("paid");
  });

  it("expires payments past their window and emits expired", async () => {
    const { service, store } = makeService({
      transactions: feed([]),
      defaultExpiryMs: -1,
      clockSkewMs: 0,
    });
    const payment = await service.createPayment({ amount: 10_000 });

    const expiredEvents: Payment[] = [];
    service.on("expired", (p) => expiredEvents.push(p));

    const result = await service.tick();

    expect(result.expired).toHaveLength(1);
    expect(expiredEvents[0]?.id).toBe(payment.id);
    expect((await store.get(payment.id))?.status).toBe("expired");
  });

  it("does not settle a transaction whose amount does not match", async () => {
    const { service, store } = makeService({ transactions: feed([]) });
    const payment = await service.createPayment({ amount: 10_000 });

    const other = makeService({
      transactions: feed([makeTx({ id: "tx-x", grossAmount: 99_999 })]),
      store,
    }).service;

    const result = await other.tick();
    expect(result.paid).toHaveLength(0);
    expect((await store.get(payment.id))?.status).toBe("pending");
  });

  // Regression guard: the catch branch used to return `expired: []`, hiding
  // expirations that had already been written to the store and emitted.
  it("still reports expirations when the transaction fetch fails", async () => {
    const store = new InMemoryPaymentStore();
    const { service } = makeService({
      transactions: feed([]),
      store,
      defaultExpiryMs: -1,
      clockSkewMs: 0,
    });
    await service.createPayment({ amount: 10_000 });
    await service.createPayment({ amount: 20_000 });

    const failing = new PaymentService({
      merchantId: "G1",
      store,
      transactions: failingFeed("feed unavailable"),
      defaultExpiryMs: -1,
      clockSkewMs: 0,
    });

    const errors: Error[] = [];
    failing.on("error", (e) => errors.push(e));

    // A still-valid payment keeps the poller from short-circuiting on an empty
    // active list, so the feed really is consulted and throws.
    await failing.createPayment({ amount: 30_000, expiresInMs: 60_000 });

    const result = await failing.tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("feed unavailable");
    // The two stale payments were expired before the feed blew up, and must
    // still be reported rather than silently dropped by the catch branch.
    expect(result.expired).toHaveLength(2);
    expect(result.paid).toHaveLength(0);
  });

  // Regression guard for the expire-before-match defect: the feed indexes
  // transactions with a delay, so a buyer who paid in time can surface in the
  // feed only after expiresAt. Expiring first removed the payment from the
  // active set and the money arrived to a payment nobody could settle.
  it("settles a late-indexed transaction instead of expiring the payment", async () => {
    const { service, store } = makeService({ transactions: feed([]) });
    // Already 1s past expiry, but still inside the default 60s skew grace.
    const payment = await service.createPayment({
      amount: 10_000,
      expiresInMs: -1_000,
    });

    const late = makeService({
      transactions: feed([makeTx({ id: "tx-late", grossAmount: 10_001 })]),
      store,
    }).service;

    const result = await late.tick();

    expect(result.paid).toHaveLength(1);
    expect(result.expired).toHaveLength(0);
    expect((await store.get(payment.id))?.status).toBe("paid");
  });

  // The matcher accepts transactions up to expiresAt + clockSkewMs, so expiry
  // must not give up before that same moment: within the grace window the
  // payment stays pending, waiting for the feed to catch up.
  it("keeps a payment pending during the clock-skew grace window", async () => {
    const { service, store } = makeService({ transactions: feed([]) });
    const payment = await service.createPayment({
      amount: 10_000,
      expiresInMs: -1_000,
    });

    const result = await service.tick();

    expect(result.expired).toHaveLength(0);
    expect((await store.get(payment.id))?.status).toBe("pending");
  });

  it("expires a payment once the grace window has fully passed", async () => {
    const { service, store } = makeService({
      transactions: feed([]),
      clockSkewMs: 1_000,
    });
    const payment = await service.createPayment({
      amount: 10_000,
      expiresInMs: -2_000,
    });

    const result = await service.tick();

    expect(result.expired).toHaveLength(1);
    expect((await store.get(payment.id))?.status).toBe("expired");
  });

  it("skips work while a previous tick is still running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const store = new InMemoryPaymentStore();
    const service = new PaymentService({
      merchantId: "G1",
      store,
      transactions: {
        async list() {
          await gate;
          return [];
        },
      },
    });
    await service.createPayment({ amount: 10_000 });

    const first = service.tick();
    const second = await service.tick();

    expect(second).toEqual({ paid: [], expired: [] });
    release?.();
    await first;
  });
});

describe("PaymentService feed window and pagination", () => {
  it("narrows the feed window to the oldest active payment minus skew", async () => {
    const queries: Array<{ start: number; end: number }> = [];
    const lister: TransactionLister = {
      async list(_merchantId, query) {
        queries.push({
          start: query.startTime.getTime(),
          end: query.endTime.getTime(),
        });
        return [];
      },
    };
    const service = new PaymentService({
      merchantId: "G1",
      store: new InMemoryPaymentStore(),
      transactions: lister,
      clockSkewMs: 60_000,
    });

    const payment = await service.createPayment({ amount: 10_000 });
    await service.tick();

    // Only transactions inside an active payment's window can match, so the
    // scan starts at the oldest pending payment, not a fixed 24h back.
    expect(queries[0]?.start).toBe(payment.createdAt - 60_000);
    expect(queries[0]?.end).toBeGreaterThanOrEqual(payment.createdAt);
  });

  // Regression guard: a single page caps at 100 rows (feed limit), so a burst
  // of unrelated transactions used to push a real match out of reach.
  it("walks further pages until a partial page and matches beyond page one", async () => {
    const calls: Array<{ from?: number; size?: number }> = [];
    const decoys = Array.from({ length: 100 }, (_, i) =>
      makeTx({ id: `decoy-${i}`, grossAmount: 1 }),
    );
    const lister: TransactionLister = {
      async list(_merchantId, query) {
        calls.push({ from: query.from, size: query.size });
        if (query.from === 0) return decoys;
        if (query.from === 100) {
          return [makeTx({ id: "tx-deep", grossAmount: 10_001 })];
        }
        return [];
      },
    };
    const store = new InMemoryPaymentStore();
    const service = new PaymentService({
      merchantId: "G1",
      store,
      transactions: lister,
    });

    const payment = await service.createPayment({ amount: 10_000 });
    const result = await service.tick();

    expect(calls).toEqual([
      { from: 0, size: 100 },
      { from: 100, size: 100 },
    ]);
    expect(result.paid).toHaveLength(1);
    expect((await store.get(payment.id))?.transaction?.id).toBe("tx-deep");
  });

  it("stops at the page cap and warns instead of crawling forever", async () => {
    let pages = 0;
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeTx({ id: `noise-${i}`, grossAmount: 1 }),
    );
    const warnings: string[] = [];
    const service = new PaymentService({
      merchantId: "G1",
      store: new InMemoryPaymentStore(),
      transactions: {
        async list() {
          pages += 1;
          return fullPage;
        },
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
    });

    await service.createPayment({ amount: 10_000 });
    await service.tick();

    expect(pages).toBe(10);
    expect(warnings.some((w) => w.includes("page cap"))).toBe(true);
  });
});

describe("PaymentService cancellation race", () => {
  // Regression guard: cancelPayment read the status and wrote the update
  // without serialization, so a tick settling the same payment in between
  // was overwritten with "cancelled" - buyer paid, record said cancelled.
  it("never overwrites a concurrent cancellation with paid", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const store = new InMemoryPaymentStore();
    let transactions: MerchantTransaction[] = [];
    const service = new PaymentService({
      merchantId: "G1",
      store,
      transactions: {
        async list() {
          await gate;
          return transactions;
        },
      },
    });

    const payment = await service.createPayment({ amount: 10_000 });
    transactions = [makeTx({ id: "tx-race", grossAmount: 10_001 })];

    // Let the tick snapshot the pending set, then block it on the feed while
    // the payment is cancelled underneath it.
    const ticking = service.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await service.cancelPayment(payment.id);
    expect(cancelled?.status).toBe("cancelled");

    release?.();
    const result = await ticking;

    expect(result.paid).toHaveLength(0);
    expect((await store.get(payment.id))?.status).toBe("cancelled");
  });

  it("returns the stored payment untouched when already terminal", async () => {
    const { service, store } = makeService({
      transactions: feed([makeTx({ id: "tx-1", grossAmount: 10_001 })]),
    });
    const payment = await service.createPayment({ amount: 10_000 });
    await service.tick();

    const afterSettle = await service.cancelPayment(payment.id);

    expect(afterSettle?.status).toBe("paid");
    expect((await store.get(payment.id))?.status).toBe("paid");
  });
});

describe("PaymentService listeners", () => {
  // Regression guard: a throwing paid listener used to unwind into tick(),
  // which then under-reported a settlement that was already in the store.
  it("keeps settling and reporting when a paid listener throws", async () => {
    const { service, store } = makeService({
      transactions: feed([makeTx({ id: "tx-1", grossAmount: 10_001 })]),
    });
    const payment = await service.createPayment({ amount: 10_000 });

    const errors: Error[] = [];
    const second = vi.fn();
    service.on("paid", () => {
      throw new Error("listener boom");
    });
    service.on("paid", second);
    service.on("error", (e) => errors.push(e));

    const result = await service.tick();

    expect(result.paid).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(errors.map((e) => e.message)).toContain("listener boom");
    expect((await store.get(payment.id))?.status).toBe("paid");
  });

  it("does not recurse when an error listener itself throws", async () => {
    const { service } = makeService({
      transactions: failingFeed("feed down"),
    });
    await service.createPayment({ amount: 10_000, expiresInMs: 60_000 });

    service.on("error", () => {
      throw new Error("error listener boom");
    });

    await expect(service.tick()).resolves.toEqual({ paid: [], expired: [] });
  });

  // Regression guard: once() registers a private wrapper, so off() with the
  // original function used to be a silent no-op and the listener still fired.
  it("removes a once() listener via off() with the original function", async () => {
    const { service } = makeService({
      transactions: feed([]),
      defaultExpiryMs: -1,
      clockSkewMs: 0,
    });
    await service.createPayment({ amount: 10_000 });

    const listener = vi.fn();
    service.once("expired", listener);
    service.off("expired", listener);

    await service.tick();

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after off()", async () => {
    const { service, store } = makeService({
      transactions: feed([]),
      defaultExpiryMs: -1,
      clockSkewMs: 0,
    });
    await service.createPayment({ amount: 10_000 });

    const listener = vi.fn();
    service.on("expired", listener);
    service.off("expired", listener);

    await service.tick();

    expect(listener).not.toHaveBeenCalled();
    expect(store).toBeDefined();
  });
});

/** Wrap a store so every operation yields, widening any race window. */
function asyncStore(inner: InMemoryPaymentStore): PaymentStore {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    async create(payment) {
      await tick();
      inner.create(payment);
    },
    async update(payment) {
      await tick();
      inner.update(payment);
    },
    async get(id) {
      await tick();
      return inner.get(id);
    },
    async listActive() {
      await tick();
      return inner.listActive();
    },
  };
}

function duplicateAmounts(payments: Payment[]): number[] {
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const payment of payments) {
    if (seen.has(payment.uniqueAmount)) duplicated.add(payment.uniqueAmount);
    seen.add(payment.uniqueAmount);
  }
  return [...duplicated];
}

describe("PaymentService unique amount integrity", () => {
  // Regression guard: createPayment reads the active set and writes the new
  // payment across two awaits. Unserialized, every caller in a burst saw the
  // same "before" state and picked the same offset, so all of them received an
  // identical amount and became indistinguishable to the poller.
  it("hands out distinct amounts to a concurrent burst", async () => {
    const inner = new InMemoryPaymentStore();
    const { service } = makeService({ transactions: feed([]), store: inner });

    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        service.createPayment({ amount: 10_000, reference: `R${i}` }),
      ),
    );

    const amounts = created.map((p) => p.uniqueAmount);
    expect(new Set(amounts).size).toBe(25);
    expect(duplicateAmounts(inner.listActive())).toEqual([]);
    // Smallest-first allocation means the burst fills 10_001..10_025.
    expect(Math.min(...amounts)).toBe(10_001);
    expect(Math.max(...amounts)).toBe(10_025);
  });

  it("stays correct when the store is asynchronous", async () => {
    const inner = new InMemoryPaymentStore();
    const service = new PaymentService({
      merchantId: "G1",
      store: asyncStore(inner),
      transactions: feed([]),
    });

    const created = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.createPayment({ amount: 20_000 }),
      ),
    );

    expect(new Set(created.map((p) => p.uniqueAmount)).size).toBe(10);
    expect(duplicateAmounts(inner.listActive())).toEqual([]);
  });

  // Regression guard for cross-base collisions: 3500+1 and 3499+2 both reach
  // 3501, which the amount-only matcher cannot tell apart.
  it("never reuses an amount already held by a different base amount", async () => {
    const inner = new InMemoryPaymentStore();
    const { service } = makeService({ transactions: feed([]), store: inner });

    const a = await service.createPayment({ amount: 3500, reference: "A" });
    const b = await service.createPayment({ amount: 3499, reference: "B" });
    const c = await service.createPayment({ amount: 3499, reference: "C" });

    expect(a.uniqueAmount).toBe(3501);
    expect(b.uniqueAmount).toBe(3500);
    // 3501 is taken by A, so C must skip past it.
    expect(c.uniqueAmount).toBe(3502);
    expect(duplicateAmounts(inner.listActive())).toEqual([]);
  });

  it("keeps amounts distinct across many interleaved base amounts", async () => {
    const inner = new InMemoryPaymentStore();
    const { service } = makeService({ transactions: feed([]), store: inner });

    // Base amounts one rupiah apart are the worst case for collisions.
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        service.createPayment({ amount: 5_000 + i }),
      ),
    );

    const active = inner.listActive();
    expect(active).toHaveLength(60);
    expect(duplicateAmounts(active)).toEqual([]);
  });

  it("releases an amount for reuse once the payment leaves the active set", async () => {
    const inner = new InMemoryPaymentStore();
    // Quarantine off (clockSkewMs 0); its delaying effect is locked below.
    const { service } = makeService({
      transactions: feed([]),
      store: inner,
      clockSkewMs: 0,
    });

    const first = await service.createPayment({ amount: 8_000 });
    await service.createPayment({ amount: 8_000 });
    await service.cancelPayment(first.id);

    const replacement = await service.createPayment({ amount: 8_000 });
    expect(replacement.uniqueAmount).toBe(first.uniqueAmount);
    expect(duplicateAmounts(inner.listActive())).toEqual([]);
  });

  it("rejects a new payment once the offset window is exhausted", async () => {
    const inner = new InMemoryPaymentStore();
    const service = new PaymentService({
      merchantId: "G1",
      store: inner,
      transactions: feed([]),
      allocator: new AmountAllocator(3),
    });

    await Promise.all(
      Array.from({ length: 3 }, () => service.createPayment({ amount: 5_000 })),
    );

    await expect(
      service.createPayment({ amount: 5_000 }),
    ).rejects.toMatchObject({ code: "AMOUNT_POOL_EXHAUSTED" });

    // A rejected allocation must not stall the queue for later callers.
    await expect(
      service.createPayment({ amount: 9_000 }),
    ).resolves.toMatchObject({ uniqueAmount: 9_001 });
  });
});
