import type {
  MerchantTransaction,
  Payment,
  PaymentScope,
  PaymentStore,
  TransactionLister,
} from "../core/types.js";
import type { TransactionFeed } from "../core/provider.js";
import { samePaymentScope } from "../core/provider.js";
import {
  DEFAULT_PAYMENT_EXPIRY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TRANSACTION_LOOKBACK_MS,
  DEFAULT_TRANSACTION_PAGE_SIZE,
  MAX_TRANSACTION_PAGES_PER_TICK,
  MAX_TRANSACTION_PAGE_SIZE,
} from "../core/constants.js";
import { MerchantIdError } from "../core/errors.js";
import { AmountAllocator } from "./amountAllocator.js";
import { reconcile } from "./paymentMatcher.js";
import { staticToDynamicQris } from "../qris/qris.js";
import { paymentId as generatePaymentId } from "../utils/id.js";
import { now } from "../utils/time.js";
import type { Logger } from "../utils/logger.js";
import { noopLogger } from "../utils/logger.js";

export interface CreatePaymentInput {
  /** Base amount in whole rupiah. */
  amount: number;
  /** Optional caller reference (internal order id, etc.). */
  reference?: string;
  /** Override the default expiry for this payment, in milliseconds. */
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
}

export interface PaymentServiceOptions {
  merchantId: string;
  /**
   * Provider ownership for isolating records in a shared store. Omit only for
   * direct, unscoped PaymentService usage.
   */
  scope?: PaymentScope;
  store: PaymentStore;
  /** Offset-paginated transaction port used by the GoPay provider. */
  transactions?: TransactionLister;
  /** Provider-normalized feed whose adapter owns pagination and conversion. */
  transactionFeed?: TransactionFeed;
  /** Static QRIS payload used to derive per-order dynamic QRIS strings. */
  staticQris?: string;
  allocator?: AmountAllocator;
  pollIntervalMs?: number;
  defaultExpiryMs?: number;
  clockSkewMs?: number;
  /**
   * How many transactions each feed page holds, capped at the feed's hard
   * limit of 100. Overflow is handled by pagination (up to
   * {@link MAX_TRANSACTION_PAGES_PER_TICK} pages per poll), not by this knob.
   */
  transactionPageSize?: number;
  logger?: Logger;
  /** Capability used by provider facades that retain services across scopes. */
  lifecycleToken?: object;
}

export interface PaymentServiceEvents {
  paid: [Payment];
  expired: [Payment];
  error: [Error];
}

function clonePayment(payment: Payment): Payment {
  return {
    ...payment,
    scope: payment.scope ? { ...payment.scope } : undefined,
  };
}

/**
 * `any[]` is deliberate: it keeps the parameter list bivariant so narrowly
 * typed listeners (e.g. `(p: Payment) => void`) stay assignable through the
 * typed `on` overloads below. `unknown[]` would reject them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmitterListener = (...args: any[]) => void;

/** Back-reference from a once() wrapper to the listener it wraps. */
const ONCE_ORIGINAL = Symbol("merchantid.onceOriginal");

type MaybeOnceWrapper = EmitterListener & {
  [ONCE_ORIGINAL]?: EmitterListener;
};

/**
 * Minimal, runtime-agnostic event emitter used in place of Node's `node:events`
 * so PaymentService runs on any JavaScript runtime (Workers, Edge, Deno,
 * browsers) without a Node compatibility layer. Implements the small subset of
 * the EventEmitter surface this library uses.
 */
class TinyEmitter {
  private readonly handlers = new Map<string, Set<EmitterListener>>();

  /**
   * Invoked when a listener throws, instead of letting the exception unwind
   * into the emitting code path. Installed by the subclass. Without this
   * isolation a throwing `paid` listener would abort `tick()` mid-loop: the
   * settlement is already committed to the store, but the caller's returned
   * accounting (and every listener registered after the throwing one) would
   * silently miss it.
   */
  protected onListenerError?: (event: string, error: unknown) => void;

  on(event: string, listener: EmitterListener): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: EmitterListener): this {
    const wrapped: MaybeOnceWrapper = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    // Node's EventEmitter allows removing a once() listener with the original
    // function; keep that contract by back-referencing it on the wrapper.
    wrapped[ONCE_ORIGINAL] = listener;
    return this.on(event, wrapped);
  }

  off(event: string, listener: EmitterListener): this {
    const set = this.handlers.get(event);
    if (!set) return this;
    set.delete(listener);
    for (const registered of set) {
      if ((registered as MaybeOnceWrapper)[ONCE_ORIGINAL] === listener) {
        set.delete(registered);
      }
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        this.onListenerError?.(event, error);
      }
    }
    return true;
  }
}

/**
 * Core orchestration: creates dynamic payments with unique amounts, and polls
 * the transaction feed to settle or expire them. Emits `paid`, `expired`, and
 * `error` events.
 */
// Merged with the `PaymentService` interface at the bottom of this file, which
// only narrows `on`/`emit` to the event map. No phantom members are introduced.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PaymentService extends TinyEmitter {
  private readonly merchantId: string;
  private readonly scope: PaymentScope;
  private readonly usesExplicitScope: boolean;
  private readonly store: PaymentStore;
  private readonly transactions?: TransactionLister;
  private transactionFeed?: TransactionFeed;
  private staticQris?: string;
  private readonly allocator: AmountAllocator;
  private readonly pollIntervalMs: number;
  private readonly defaultExpiryMs: number;
  private readonly clockSkewMs: number;
  private readonly transactionPageSize: number;
  private readonly logger: Logger;
  private readonly lifecycleToken?: object;

  private timer?: ReturnType<typeof setInterval>;
  private active = true;
  private activationEpoch = 0;
  private polling = false;
  private pollingDone: Promise<void> = Promise.resolve();
  /** Tail of the write queue; see {@link runExclusive}. */
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Unique amounts that recently left the active set, mapped to the moment
   * they were freed. While quarantined (see {@link amountQuarantineMs}) an
   * amount counts as taken: its old transaction is still inside the window a
   * brand-new payment would accept, and the smallest-free-slot policy would
   * otherwise hand the amount straight to the next same-priced order,
   * letting one transfer settle two orders.
   */
  private readonly recentlyFreedAmounts = new Map<number, number>();
  /**
   * Ids of feed transactions that already settled a payment, mapped to when
   * they were consumed. `reconcile` guarantees at-most-one settlement per
   * transaction within a tick; this set extends that guarantee across ticks
   * for the lifetime of the process. Entries are dropped once the rolling
   * feed window can no longer return them.
   */
  private readonly consumedTransactionIds = new Map<string, number>();

  constructor(options: PaymentServiceOptions) {
    super();
    if (!options.transactions && !options.transactionFeed) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "transactions or transactionFeed is required",
      );
    }
    if (options.scope && options.scope.merchantId !== options.merchantId) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "scope.merchantId must match merchantId",
      );
    }

    this.merchantId = options.merchantId;
    this.scope = options.scope
      ? { ...options.scope }
      : {
          provider: "gopay",
          merchantId: options.merchantId,
        };
    this.usesExplicitScope = options.scope !== undefined;
    this.store = options.store;
    this.transactions = options.transactions;
    this.transactionFeed = options.transactionFeed;
    this.staticQris = options.staticQris;
    this.allocator = options.allocator ?? new AmountAllocator();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.defaultExpiryMs = options.defaultExpiryMs ?? DEFAULT_PAYMENT_EXPIRY_MS;
    this.clockSkewMs = options.clockSkewMs ?? 60_000;
    // Clamped here as well as in the transaction client: pagination steps
    // `from` by this value, so if the client silently shrank an oversized page
    // the second page would skip the rows between the two sizes.
    this.transactionPageSize = Math.min(
      Math.max(1, options.transactionPageSize ?? DEFAULT_TRANSACTION_PAGE_SIZE),
      MAX_TRANSACTION_PAGE_SIZE,
    );
    this.logger = options.logger ?? noopLogger;
    this.lifecycleToken = options.lifecycleToken;

    this.onListenerError = (event, error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error("event listener threw", {
        event,
        message: err.message,
      });
      // Surface through the error channel consumers already watch. Never
      // re-emit when the failing listener is itself an error listener, or a
      // throwing error handler would recurse forever.
      if (event !== "error") this.emit("error", err);
    };
  }

  /**
   * Set (or clear) the static QRIS used to derive per-order dynamic QRIS
   * strings. Typically called once after resolving the merchant's outlet QR.
   */
  setStaticQris(staticQris: string | undefined): void {
    this.staticQris = staticQris;
  }

  /** Replace provider transport credentials without discarding replay guards. */
  setTransactionFeed(transactionFeed: TransactionFeed): void {
    this.transactionFeed = transactionFeed;
  }

  /** Whether a static QRIS is configured for dynamic QR generation. */
  get hasStaticQris(): boolean {
    return Boolean(this.staticQris);
  }

  /** Whether background reconciliation is currently scheduled. */
  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Whether this service currently owns its scope's write lifecycle. */
  get isActive(): boolean {
    return this.active;
  }

  /** Re-enable a retained service after its scope becomes current again. */
  activate(lifecycleToken?: object): void {
    this.assertLifecycleAccess(lifecycleToken);
    if (this.active) return;
    this.active = true;
    this.activationEpoch += 1;
  }

  /**
   * Prevent new allocations and reconciliation, then wait for work that
   * already entered this service's queues to finish. The return value records
   * whether background polling should be resumed if the scope is restored.
   */
  async deactivate(lifecycleToken?: object): Promise<boolean> {
    this.assertLifecycleAccess(lifecycleToken);
    const wasRunning = this.isRunning;
    if (this.active) {
      this.active = false;
      this.activationEpoch += 1;
    }
    this.stop();
    const pollingDone = this.pollingDone;
    await pollingDone;
    await this.writeQueue;
    return wasRunning;
  }

  private assertLifecycleAccess(lifecycleToken?: object): void {
    if (
      this.lifecycleToken === undefined ||
      lifecycleToken === this.lifecycleToken
    ) {
      return;
    }
    throw new MerchantIdError(
      "CONFIG_INVALID",
      "This PaymentService lifecycle is controlled by its provider",
    );
  }

  private assertActive(operation: string): void {
    if (this.active) return;
    throw new MerchantIdError(
      "CONFIG_INVALID",
      `Cannot ${operation} with an inactive PaymentService`,
    );
  }

  private isCurrentActivation(epoch: number): boolean {
    return this.active && this.activationEpoch === epoch;
  }

  private ownsPayment(payment: Payment): boolean {
    if (!this.usesExplicitScope) return payment.scope === undefined;
    return (
      payment.scope !== undefined && samePaymentScope(payment.scope, this.scope)
    );
  }

  /**
   * How long a freed unique amount stays unavailable for re-allocation.
   *
   * A transaction settles a payment created up to `clockSkewMs` BEFORE the
   * transaction time, and a transaction's timestamp can itself sit up to
   * `clockSkewMs` past the moment its payment left the active set. Two skews
   * after the slot is freed, no transaction belonging to the old payment can
   * still fall inside a new payment's window, so the amount is safe to hand
   * out again.
   */
  private get amountQuarantineMs(): number {
    return 2 * this.clockSkewMs;
  }

  private async listActivePayments(): Promise<Payment[]> {
    // A no-scope query is the only portable way to discover ambiguous
    // unscoped records because a strict store hides them from scoped reads.
    const active = await this.store.listActive();
    if (!this.usesExplicitScope) {
      return active
        .filter((payment) => this.ownsPayment(payment))
        .map(clonePayment);
    }

    const unscopedActiveCount = active.filter(
      (payment) => payment.scope === undefined,
    ).length;
    if (unscopedActiveCount > 0) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "Active payments without PaymentScope cannot be reconciled by a scoped service",
        { details: { unscopedActiveCount } },
      );
    }

    // Filter again even when a store supports scoped reads. This keeps
    // permissive custom stores from crossing provider/account/store ownership.
    return active
      .filter((payment) => this.ownsPayment(payment))
      .map(clonePayment);
  }

  /**
   * Create a new pending payment with a unique amount and (optional) QRIS.
   *
   * Concurrent calls are serialized. Reading the active set and writing the new
   * payment are two awaits, and without serialization every caller in a burst
   * observes the same "before" state and picks the same offset, handing out
   * duplicate amounts.
   */
  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    this.assertActive("create payments");
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "amount must be a positive integer (whole rupiah)",
      );
    }
    // NaN or Infinity would produce a payment that can never expire, leaking
    // its amount slot forever and pinning the feed scan window open.
    if (
      input.expiresInMs !== undefined &&
      !Number.isFinite(input.expiresInMs)
    ) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "expiresInMs must be a finite number of milliseconds",
      );
    }

    return this.runExclusive(async () => {
      this.assertActive("create payments");
      const active = await this.listActivePayments();
      this.assertActive("create payments");

      const current = now();
      for (const [amount, freedAt] of this.recentlyFreedAmounts) {
        if (freedAt + this.amountQuarantineMs <= current) {
          this.recentlyFreedAmounts.delete(amount);
        }
      }

      // Compare against the amounts themselves: two different base amounts
      // can otherwise land on the same total. Quarantined amounts count as
      // taken; see {@link recentlyFreedAmounts}.
      const takenAmounts = [
        ...active.map((payment) => payment.uniqueAmount),
        ...this.recentlyFreedAmounts.keys(),
      ];

      const uniqueOffset = this.allocator.allocate(input.amount, takenAmounts);
      const uniqueAmount = input.amount + uniqueOffset;
      const createdAt = now();
      const expiresAt = createdAt + (input.expiresInMs ?? this.defaultExpiryMs);

      const payment: Payment = {
        id: generatePaymentId(),
        ...(this.usesExplicitScope ? { scope: { ...this.scope } } : {}),
        baseAmount: input.amount,
        uniqueOffset,
        uniqueAmount,
        status: "pending",
        createdAt,
        expiresAt,
        reference: input.reference,
        metadata: input.metadata,
        qrString: this.staticQris
          ? staticToDynamicQris(this.staticQris, uniqueAmount)
          : undefined,
      };

      await this.store.create(clonePayment(payment));
      this.logger.info("payment created", {
        id: payment.id,
        uniqueAmount,
      });

      return clonePayment(payment);
    });
  }

  /**
   * Run amount allocations and status transitions one at a time, in call
   * order. Sharing one queue is what makes a transition atomic against a
   * concurrent allocation *and* against other transitions: `cancelPayment`
   * racing the poller's settle could otherwise overwrite a `paid` payment
   * with `cancelled` after the buyer's money already arrived.
   *
   * Only guards this process. A multi-process deployment must additionally
   * enforce uniqueness in the {@link PaymentStore} (for example a unique index
   * on the amount of active rows), because separate processes cannot see each
   * other's in-flight allocations.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task);
    // Detach failures so one rejected task cannot stall the queue.
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Move a payment to a terminal status if and only if it is still pending,
   * re-reading it inside the write queue so concurrent transitions (the
   * poller settling vs. `cancelPayment`) can never overwrite each other's
   * terminal state. Returns the updated payment, or `undefined` when the
   * payment was missing or had already left `pending`.
   */
  private transitionIfPending(
    id: string,
    status: "paid" | "expired" | "cancelled",
    transaction?: MerchantTransaction,
    expectedActivationEpoch?: number,
  ): Promise<Payment | undefined> {
    return this.runExclusive(async () => {
      if (
        expectedActivationEpoch !== undefined &&
        !this.isCurrentActivation(expectedActivationEpoch)
      ) {
        return undefined;
      }

      const stored = await this.store.get(id);
      if (
        !stored ||
        !this.ownsPayment(stored) ||
        stored.status !== "pending" ||
        (expectedActivationEpoch !== undefined &&
          !this.isCurrentActivation(expectedActivationEpoch))
      ) {
        return undefined;
      }

      const current = clonePayment(stored);
      const updated: Payment = transaction
        ? { ...current, status, transaction }
        : { ...current, status };
      await this.store.update(clonePayment(updated));
      // The freed amount enters quarantine, and a settling transaction is
      // remembered as consumed so it can never settle a second payment.
      this.recentlyFreedAmounts.set(current.uniqueAmount, now());
      if (transaction) {
        this.consumedTransactionIds.set(transaction.id, now());
      }
      return clonePayment(updated);
    });
  }

  /** Cancel a pending payment, releasing its unique amount slot. */
  async cancelPayment(id: string): Promise<Payment | undefined> {
    this.assertActive("cancel payments");
    const activationEpoch = this.activationEpoch;
    const cancelled = await this.transitionIfPending(
      id,
      "cancelled",
      undefined,
      activationEpoch,
    );
    // Already terminal (paid/expired/cancelled) or unknown: report the
    // owned stored state untouched so a race with the poller cannot un-pay it.
    return (
      cancelled ??
      (this.isCurrentActivation(activationEpoch)
        ? this.getPayment(id)
        : undefined)
    );
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    const payment = await this.store.get(id);
    return payment && this.ownsPayment(payment)
      ? clonePayment(payment)
      : undefined;
  }

  /** Begin background polling. Safe to call once; repeated calls are ignored. */
  start(): void {
    this.assertActive("start payment polling");
    if (this.timer) return;
    this.logger.info("payment polling started", {
      intervalMs: this.pollIntervalMs,
    });
    this.timer = setInterval(() => {
      if (this.active) void this.tick();
    }, this.pollIntervalMs);
    // Do not keep the event loop alive solely for polling.
    this.timer.unref?.();
  }

  /** Stop background polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.info("payment polling stopped");
    }
  }

  /**
   * Run a single reconciliation pass: fetch recent transactions, settle
   * matches, then expire what remains stale. Exposed for manual invocation.
   *
   * Matching runs BEFORE expiry on purpose. The feed indexes transactions
   * with a delay, so a buyer who paid inside the window can surface in the
   * feed after `expiresAt` has passed. Expiring first would remove that
   * payment from the active set one await earlier and the money would arrive
   * to a payment nobody can settle anymore. For the same reason a payment is
   * only marked expired once `expiresAt + clockSkewMs` has passed: that is
   * the exact moment the matcher itself stops accepting transactions for it,
   * so expiry never gives up on a payment the matcher would still settle.
   */
  async tick(): Promise<{ paid: Payment[]; expired: Payment[] }> {
    this.assertActive("run payment reconciliation");
    if (this.polling) return { paid: [], expired: [] };

    const activationEpoch = this.activationEpoch;
    let finishPolling!: () => void;
    this.polling = true;
    this.pollingDone = new Promise<void>((resolve) => {
      finishPolling = resolve;
    });
    // Accumulated outside the try so a later failure still reports the work
    // already written to the store and emitted to listeners.
    const paid: Payment[] = [];
    const expired: Payment[] = [];
    try {
      const pending = await this.listActivePayments();
      if (!this.isCurrentActivation(activationEpoch) || pending.length === 0) {
        return { paid, expired };
      }

      // Forget consumed transaction ids the rolling feed window can no
      // longer return; the map stays bounded by actual settlement volume.
      const nowMs = now();
      for (const [id, seenAt] of this.consumedTransactionIds) {
        if (seenAt + DEFAULT_TRANSACTION_LOOKBACK_MS <= nowMs) {
          this.consumedTransactionIds.delete(id);
        }
      }

      // A feed failure must not stop stale payments from expiring, so the
      // fetch error is parked and re-thrown after the expiry sweep.
      let transactions: MerchantTransaction[] = [];
      let feedError: Error | undefined;
      try {
        transactions = await this.fetchRecentTransactions(pending);
      } catch (error) {
        feedError = error instanceof Error ? error : new Error(String(error));
      }
      if (!this.isCurrentActivation(activationEpoch)) {
        return { paid, expired };
      }

      // Exclude transactions that already settled a payment in an earlier
      // tick: reconcile's own consumed set only spans a single call, and a
      // re-fetched old row must never settle a second order.
      const matches = reconcile(
        pending,
        transactions.filter(
          (transaction) => !this.consumedTransactionIds.has(transaction.id),
        ),
        this.clockSkewMs,
      );
      const settledIds = new Set<string>();
      for (const { payment, transaction } of matches) {
        const settled = await this.settle(
          payment,
          transaction,
          activationEpoch,
        );
        if (settled) {
          paid.push(settled);
          settledIds.add(settled.id);
        }
      }

      expired.push(
        ...(await this.expireStale(
          pending.filter((payment) => !settledIds.has(payment.id)),
          activationEpoch,
        )),
      );

      if (!this.isCurrentActivation(activationEpoch)) {
        return { paid, expired };
      }
      if (feedError) throw feedError;
      return { paid, expired };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error("poll tick failed", { message: err.message });
      this.emit("error", err);
      return { paid, expired };
    } finally {
      this.polling = false;
      finishPolling();
    }
  }

  /**
   * Settle a matched payment. Returns `undefined` when the payment left
   * `pending` between the reconcile snapshot and this write (for example a
   * concurrent `cancelPayment`), in which case nothing is emitted.
   */
  private async settle(
    payment: Payment,
    transaction: MerchantTransaction,
    activationEpoch: number,
  ): Promise<Payment | undefined> {
    const paid = await this.transitionIfPending(
      payment.id,
      "paid",
      transaction,
      activationEpoch,
    );
    if (!paid) return undefined;
    this.logger.info("payment settled", {
      id: paid.id,
      transactionId: transaction.id,
    });
    this.emit("paid", paid);
    return paid;
  }

  /**
   * Expire every candidate whose grace window (`expiresAt + clockSkewMs`) has
   * fully passed. Within the grace window a payment stays pending: the
   * matcher still accepts its transaction there, and the feed's indexing
   * delay means that transaction may not have surfaced yet.
   */
  private async expireStale(
    candidates: readonly Payment[],
    activationEpoch: number,
  ): Promise<Payment[]> {
    const current = now();
    const expired: Payment[] = [];
    for (const payment of candidates) {
      if (payment.expiresAt + this.clockSkewMs <= current) {
        const stale = await this.transitionIfPending(
          payment.id,
          "expired",
          undefined,
          activationEpoch,
        );
        if (!stale) continue;
        this.logger.info("payment expired", { id: stale.id });
        this.emit("expired", stale);
        expired.push(stale);
      }
    }
    return expired;
  }

  /**
   * Fetch every transaction that could possibly settle one of the given
   * pending payments.
   *
   * The window starts at the oldest active payment (minus clock skew) rather
   * than a fixed 24 hours back: only transactions inside an active payment's
   * validity window can match, and a narrow window keeps them on the first
   * pages of a feed that hard-caps each page at 100 rows. The rolling 24h
   * lookback remains as an upper bound. Pages are walked newest-first until
   * one comes back partial, so a burst of unrelated transactions cannot push
   * a match out of reach; {@link MAX_TRANSACTION_PAGES_PER_TICK} bounds the
   * crawl and hitting it is logged rather than silently truncated.
   */
  private async fetchRecentTransactions(
    pending: readonly Payment[],
  ): Promise<MerchantTransaction[]> {
    const endMs = now();
    const oldestCreatedAt = Math.min(
      ...pending.map((payment) => payment.createdAt),
    );
    const startMs = Math.max(
      endMs - DEFAULT_TRANSACTION_LOOKBACK_MS,
      oldestCreatedAt - this.clockSkewMs,
    );
    const startTime = new Date(startMs);
    const endTime = new Date(endMs);

    if (this.transactionFeed) {
      const result = await this.transactionFeed.listRecent({
        scope: { ...this.scope },
        startTime,
        endTime,
        pageSize: this.transactionPageSize,
        maxPages: MAX_TRANSACTION_PAGES_PER_TICK,
      });
      if (result.truncated) {
        this.logger.warn(
          "transaction page cap reached; oldest transactions in the window were not scanned this tick",
          {
            provider: this.scope.provider,
            pages: result.pagesFetched ?? MAX_TRANSACTION_PAGES_PER_TICK,
            pageSize: this.transactionPageSize,
          },
        );
      }
      return result.transactions;
    }

    const transactionLister = this.transactions;
    if (!transactionLister) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "No transaction source is configured",
      );
    }

    // Fetch unfiltered (empty status/type) and match client-side, so
    // variations in the feed's status/payment_type labels never hide a real
    // payment.
    const transactions: MerchantTransaction[] = [];
    for (let page = 0; page < MAX_TRANSACTION_PAGES_PER_TICK; page++) {
      const batch = await transactionLister.list(this.merchantId, {
        from: page * this.transactionPageSize,
        size: this.transactionPageSize,
        startTime,
        endTime,
        statuses: [],
        paymentTypes: [],
      });
      transactions.push(...batch);
      if (batch.length < this.transactionPageSize) {
        return transactions;
      }
    }

    this.logger.warn(
      "transaction page cap reached; oldest transactions in the window were not scanned this tick",
      {
        pages: MAX_TRANSACTION_PAGES_PER_TICK,
        pageSize: this.transactionPageSize,
      },
    );
    return transactions;
  }
}

/**
 * Narrows the inherited emitter surface to {@link PaymentServiceEvents} so
 * event names and listener payloads are checked at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PaymentService {
  on<K extends keyof PaymentServiceEvents>(
    event: K,
    listener: (...args: PaymentServiceEvents[K]) => void,
  ): this;
  emit<K extends keyof PaymentServiceEvents>(
    event: K,
    ...args: PaymentServiceEvents[K]
  ): boolean;
}
