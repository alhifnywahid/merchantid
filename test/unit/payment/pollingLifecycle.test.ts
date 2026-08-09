import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentService } from "../../../src/payment/paymentService.js";
import { InMemoryPaymentStore } from "../../../src/payment/paymentStore.js";
import { AmountAllocator } from "../../../src/payment/amountAllocator.js";
import type {
  MerchantTransaction,
  TransactionLister,
} from "../../../src/core/types.js";

/**
 * The background poll is what actually settles payments in production, yet the
 * rest of the suite only ever calls `tick()` by hand. These tests drive the
 * real timer path: that starting schedules ticks, that starting twice does not
 * double-poll, that stopping ends it, and that the interval cannot keep a Node
 * process alive.
 */

/** Feed that records how many times the service polled it. */
function countingFeed(): TransactionLister & { calls: number } {
  const feed = {
    calls: 0,
    async list(): Promise<MerchantTransaction[]> {
      feed.calls++;
      return [];
    },
  };
  return feed;
}

function makeService(transactions: TransactionLister): PaymentService {
  return new PaymentService({
    merchantId: "G1",
    store: new InMemoryPaymentStore(),
    transactions,
    allocator: new AmountAllocator(999),
    pollIntervalMs: 1_000,
  });
}

/**
 * A tick with nothing pending short-circuits before touching the feed — that is
 * intentional (no work, no provider call), so every polling assertion needs a
 * live payment for the poll to be observable.
 */
async function serviceWithPendingPayment(
  transactions: TransactionLister,
): Promise<PaymentService> {
  const service = makeService(transactions);
  await service.createPayment({ amount: 10_000, reference: "poll-me" });
  return service;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PaymentService polling lifecycle", () => {
  it("polls on the configured interval once started", async () => {
    const feed = countingFeed();
    const service = await serviceWithPendingPayment(feed);
    vi.useFakeTimers();

    expect(feed.calls).toBe(0);
    service.start();
    // Starting must not poll synchronously; the first pass is one interval in.
    expect(feed.calls).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(feed.calls).toBe(3);

    service.stop();
  });

  it("ignores a second start instead of double-polling", async () => {
    const feed = countingFeed();
    const service = await serviceWithPendingPayment(feed);
    vi.useFakeTimers();

    service.start();
    service.start();
    service.start();

    await vi.advanceTimersByTimeAsync(1_000);
    // Three starts, one interval: a duplicated timer would have polled 3 times
    // per interval and silently tripled the load on the provider's feed.
    expect(feed.calls).toBe(1);

    service.stop();
  });

  it("stops polling and tolerates a redundant stop", async () => {
    const feed = countingFeed();
    const service = await serviceWithPendingPayment(feed);
    vi.useFakeTimers();

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.calls).toBe(1);

    service.stop();
    service.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(feed.calls).toBe(1);
  });

  it("does not poll after the service is deactivated", async () => {
    const feed = countingFeed();
    const service = await serviceWithPendingPayment(feed);
    vi.useFakeTimers();
    const lifecycleToken = {};
    service.activate(lifecycleToken);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.calls).toBe(1);

    await service.deactivate(lifecycleToken);
    await vi.advanceTimersByTimeAsync(5_000);
    // The interval callback is guarded by `active`, so a deactivated scope
    // must not keep hitting the provider with a stale token.
    expect(feed.calls).toBe(1);
  });

  it("unrefs the interval so polling cannot keep the process alive", () => {
    vi.useFakeTimers();
    const service = makeService(countingFeed());
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    service.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  it("refuses to start once the service is no longer the active scope", async () => {
    const service = makeService(countingFeed());
    const lifecycleToken = {};
    service.activate(lifecycleToken);
    await service.deactivate(lifecycleToken);

    expect(() => service.start()).toThrow();
  });
});
