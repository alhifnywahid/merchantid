import { samePaymentScope } from "../../core/provider.js";
import type { MerchantProvider } from "../../core/provider.js";
import type { Payment, PaymentScope, PaymentStore } from "../../core/types.js";
import { AuthError, ConfigError } from "../../core/errors.js";
import type { FetchLike } from "../../http/httpClient.js";
import { AmountAllocator } from "../../payment/amountAllocator.js";
import { InMemoryPaymentStore } from "../../payment/paymentStore.js";
import { PaymentService } from "../../payment/paymentService.js";
import type {
  CreatePaymentInput,
  PaymentServiceOptions,
} from "../../payment/paymentService.js";
import { isValidQrisChecksum, staticToDynamicQris } from "../../qris/qris.js";
import type { Logger } from "../../utils/logger.js";
import { noopLogger } from "../../utils/logger.js";
import type { ShopeeApiLocale } from "./api.js";
import { ShopeeAuthClient, resolveSingleMerchant } from "./authClient.js";
import { SHOPEE_PROVIDER_ID } from "./constants.js";
import { ShopeeCookieJar } from "./cookieJar.js";
import { ShopeeHttpClient } from "./httpClient.js";
import { ShopeeMerchantClient } from "./merchantClient.js";
import { readShopeeMerchantCredential } from "./token.js";
import { ShopeeTransactionFeed } from "./transactionFeed.js";
import type {
  ShopeeCompleteLoginInput,
  ShopeeLoginOutcome,
  ShopeeLoginWithOtpInput,
  ShopeeMerchantProfile,
  ShopeeMerchantSummary,
  ShopeeOtpChallenge,
  ShopeeOtpRequestOptions,
  ShopeeOtpVerification,
  ShopeeSession,
  ShopeeStaticQrisScope,
  ShopeeStore,
  ShopeeVerifyOtpInput,
} from "./types.js";

export interface ShopeeProviderConfig {
  /** Preferred business merchant id when the account can access several. */
  merchantId?: string;
  /** Store/outlet id whose QRIS and transaction rows own payments. */
  storeId?: string;
  /** Restore a previously exported Shopee session. */
  session?: ShopeeSession;
  /** Shopee does not expose this in the dashboard API; paste it manually. */
  staticQris?: string;
  /** Required owner when staticQris cannot be inferred from a restored session. */
  staticQrisScope?: ShopeeStaticQrisScope;
  store?: PaymentStore;
  payment?: Partial<
    Pick<
      PaymentServiceOptions,
      | "pollIntervalMs"
      | "defaultExpiryMs"
      | "clockSkewMs"
      | "transactionPageSize"
    >
  > & { maxUniqueOffset?: number };
  language?: string;
  timezone?: string;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
  logger?: Logger;
  /**
   * Device-risk report body used for every OTP request. Without it the risk
   * service issues a degraded token whose OTP delivery Shopee suppresses.
   */
  deviceReport?: string;
  /** Persist replacements because Shopee has no verified refresh flow. */
  onSessionUpdated?: (session: ShopeeSession) => Promise<void> | void;
}

interface PaymentComposition {
  service: PaymentService;
  resumePolling: boolean;
}

interface PaymentCompositionSnapshot {
  composition: PaymentComposition;
  active: boolean;
  running: boolean;
  resumePolling: boolean;
}

interface PaymentTransitionSnapshot {
  session?: ShopeeSession;
  cookies: ShopeeSession["cookies"];
  compositions: PaymentCompositionSnapshot[];
}

/** High-level Shopee Merchant provider with fetch-only OTP authentication. */
export class ShopeeProvider implements MerchantProvider<ShopeeSession> {
  readonly providerId = SHOPEE_PROVIDER_ID;
  readonly auth: ShopeeAuthClient;

  private readonly config: ShopeeProviderConfig;
  private readonly locale: ShopeeApiLocale;
  private readonly logger: Logger;
  private readonly http: ShopeeHttpClient;
  private readonly store: PaymentStore;
  private readonly paymentLifecycleToken = {};
  private readonly paymentCompositions = new Map<string, PaymentComposition>();
  private paymentTransitionQueue: Promise<void> = Promise.resolve();
  private paymentTransitionReservations = 0;
  private sessionUpdateInProgress = false;
  private session?: ShopeeSession;
  private staticQrisValue?: string;
  private staticQrisOwner?: ShopeeStaticQrisScope;

  constructor(config: ShopeeProviderConfig = {}) {
    this.config = config;
    this.locale = { language: config.language, timezone: config.timezone };
    this.logger = config.logger ?? noopLogger;
    this.store = config.store ?? new InMemoryPaymentStore();

    if (
      config.session &&
      config.merchantId &&
      config.session.merchant.id !== config.merchantId
    ) {
      throw new ConfigError(
        "Configured Shopee merchantId does not match the restored session",
      );
    }

    this.session = config.session ? cloneSession(config.session) : undefined;
    if (this.session && config.storeId) {
      assertKnownStore(this.session.stores, config.storeId);
      this.session.storeId = config.storeId;
    }

    if (config.staticQrisScope && !config.staticQris) {
      throw new ConfigError("staticQrisScope requires staticQris");
    }
    if (config.staticQris) {
      assertValidStaticQris(config.staticQris);
      const owner =
        config.staticQrisScope ??
        inferStaticQrisScope(this.session, config.merchantId, config.storeId);
      if (!owner) {
        throw new ConfigError(
          "staticQrisScope is required when no restored Shopee merchant/store is selected",
        );
      }
      assertStaticQrisScope(owner);
      this.staticQrisValue = config.staticQris;
      this.staticQrisOwner = { ...owner };
    }

    const cookieJar = new ShopeeCookieJar(this.session?.cookies ?? []);
    this.http = new ShopeeHttpClient({
      cookieJar,
      fetch: config.fetch,
      logger: this.logger,
      timeoutMs: config.requestTimeoutMs,
    });
    this.auth = new ShopeeAuthClient(this.http, {
      locale: this.locale,
      logger: this.logger,
    });
  }

  get authenticated(): boolean {
    if (!this.session) return false;
    try {
      const credential = readShopeeMerchantCredential(this.http.cookieJar);
      // The token's `accountId` (its `userid`) is the staff ToB user the cookie
      // was minted for. Selecting a merchant re-mints the cookie for the target
      // merchant's staff user and updates `session.accountId` in the same step,
      // so the two move together and comparing them stays a valid ownership
      // check. `businessId` is the SSO business_client_id (a constant `1`),
      // never the Shopee merchant id, so it proves nothing here.
      //
      // This is a structural check only: the cookie's `exp` is ~1000 days and
      // says nothing about the server-side session. `refreshSession()` is the
      // authority on liveness.
      return (
        (credential.expiresAt === undefined ||
          credential.expiresAt > Date.now()) &&
        (credential.accountId === undefined ||
          credential.accountId === this.session.accountId)
      );
    } catch {
      // An unreadable or missing token cookie means there is no usable session.
      // Reporting `false` (rather than throwing from a getter) lets callers
      // branch on it; the reason surfaces from the next authenticated call.
      return false;
    }
  }

  /** Static QRIS only when its recorded owner matches the selected store. */
  get staticQris(): string | undefined {
    const session = this.session;
    const owner = this.staticQrisOwner;
    if (!this.staticQrisValue || !owner || !session?.storeId) return undefined;
    return owner.merchantId === session.merchant.id &&
      owner.storeId === session.storeId
      ? this.staticQrisValue
      : undefined;
  }

  get staticQrisScope(): ShopeeStaticQrisScope | undefined {
    return this.staticQrisOwner ? { ...this.staticQrisOwner } : undefined;
  }

  /** Every business merchant the current session can switch between. */
  get merchants(): ShopeeMerchantSummary[] {
    if (!this.session) return [];
    return this.session.merchants.map((merchant) => ({ ...merchant }));
  }

  /** The currently active business merchant, when authenticated. */
  get activeMerchant(): ShopeeMerchantSummary | undefined {
    return this.session ? { ...this.session.merchant } : undefined;
  }

  /** Bind a manually supplied QRIS to the currently authenticated store. */
  setStaticQris(staticQris: string | undefined): void {
    this.assertNoPaymentTransition("change Shopee QRIS");
    if (staticQris === undefined) {
      this.staticQrisValue = undefined;
      this.staticQrisOwner = undefined;
      for (const composition of this.paymentCompositions.values()) {
        composition.service.setStaticQris(undefined);
      }
      return;
    }

    const scope = this.getPaymentScope();
    if (!scope?.accountId) {
      throw new ConfigError(
        "Select an authenticated Shopee merchant/store before setting QRIS",
      );
    }
    assertValidStaticQris(staticQris);
    this.staticQrisValue = staticQris;
    this.staticQrisOwner = {
      merchantId: scope.accountId,
      storeId: scope.merchantId,
    };
    const ownerKey = paymentScopeKey(scope);
    for (const [key, composition] of this.paymentCompositions) {
      composition.service.setStaticQris(
        key === ownerKey ? staticQris : undefined,
      );
    }
  }

  async requestOtp(
    phoneNumber: string,
    options: ShopeeOtpRequestOptions = {},
  ): Promise<ShopeeOtpChallenge> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async () => {
        const challenge = await this.auth.requestOtp(phoneNumber, {
          ...options,
          deviceReport: options.deviceReport ?? this.config.deviceReport,
        });
        this.session = undefined;
        return challenge;
      }),
    );
  }

  async verifyOtp(input: ShopeeVerifyOtpInput): Promise<ShopeeOtpVerification> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async () => {
        const verification = await this.auth.verifyOtp(input);
        this.session = undefined;
        return verification;
      }),
    );
  }

  async completeLogin(input: ShopeeCompleteLoginInput): Promise<ShopeeSession> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(() =>
        this.completeLoginWithinTransition(input),
      ),
    );
  }

  /**
   * Verify the OTP and, when the target merchant is unambiguous, finish the
   * login in one call. When the account can reach more than one usable business
   * merchant and no `merchantId` was supplied, this does NOT throw: it returns
   * `status: "merchant-selection-required"` with the sensitive `verification`
   * and the usable `merchants`, so a caller can present a picker and finish with
   * {@link completeLogin} - reusing the verification, no second OTP. Supplying a
   * `merchantId` always drives straight to a completed session.
   */
  async loginWithOtp(
    input: ShopeeLoginWithOtpInput,
  ): Promise<ShopeeLoginOutcome> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async () => {
        const verification = await this.auth.verifyOtp({
          challenge: input.challenge,
          otp: input.otp,
        });
        this.session = undefined;
        if (
          !input.merchantId &&
          !resolveSingleMerchant(verification.merchants)
        ) {
          return {
            status: "merchant-selection-required",
            verification,
            merchants: verification.merchants.map((merchant) => ({
              ...merchant,
            })),
          };
        }
        const session = await this.completeLoginWithinTransition({
          verification,
          merchantId: input.merchantId,
          storeId: input.storeId,
        });
        return { status: "complete", session };
      }),
    );
  }

  getPaymentScope(): PaymentScope | undefined {
    if (!this.authenticated || !this.session?.storeId) return undefined;
    return {
      provider: this.providerId,
      accountId: this.session.merchant.id,
      merchantId: this.session.storeId,
    };
  }

  exportSession(): ShopeeSession {
    const session = this.requireSession();
    const credential = readShopeeMerchantCredential(this.http.cookieJar);
    return cloneSession({
      ...session,
      cookies: this.http.cookieJar.snapshot(),
      expiresAt: credential.expiresAt ?? session.expiresAt,
    });
  }

  async getMerchantProfile(): Promise<ShopeeMerchantProfile> {
    return this.runPaymentTransition(() =>
      this.createMerchantClient().getProfile(),
    );
  }

  async listStores(): Promise<ShopeeStore[]> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async (snapshot) => {
        const stores = await this.createMerchantClient().listStores();
        const session = this.requireSession();
        const previousStoreId = session.storeId;
        session.stores = stores.map((store) => ({ ...store }));
        if (!session.storeId) {
          session.storeId = chooseStoreId(stores, undefined, undefined);
        } else {
          assertKnownStore(stores, session.storeId);
        }

        await this.persistSession();
        if (session.storeId !== previousStoreId) {
          this.activateCurrentComposition();
        } else {
          await this.restorePaymentCompositions(snapshot.compositions);
        }
        return stores.map((store) => ({ ...store }));
      }),
    );
  }

  async selectStore(storeId: string): Promise<ShopeeSession> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async (snapshot) => {
        const session = this.requireSession();
        if (session.stores.length === 0) {
          session.stores = await this.createMerchantClient().listStores();
        }
        assertKnownStore(session.stores, storeId);
        if (session.storeId === storeId) {
          await this.restorePaymentCompositions(snapshot.compositions);
          return this.exportSession();
        }

        const previousScope = this.getPaymentScope();
        if (previousScope) await this.assertNoActivePayments(previousScope);

        session.storeId = storeId;
        await this.persistSession();
        this.activateCurrentComposition();
        return this.exportSession();
      }),
    );
  }

  /**
   * Switch the active business merchant without logging in again.
   *
   * `SwitchMerchant` mints a `target_tob_token` the dashboard API rejects with
   * 200020 outside a real browser (the browser performs a client-side session
   * hand-off that is not reproducible headless), so switching instead **replays
   * the login token exchange** for the target merchant: `login_toc` →
   * `/account/login/tob/auth` keyed by the target's `staffUserId`, reusing the
   * account-session `switchCredential` captured at login. That is the exact
   * chain a fresh login runs, and it mints a dashboard token the API accepts.
   * The target's stores are then rediscovered. Switching is blocked while the
   * current store still has active payments, mirroring `selectStore`.
   */
  async selectMerchant(merchantId: string): Promise<ShopeeSession> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async (snapshot) => {
        const session = this.requireSession();
        const target = session.merchants.find(
          (merchant) => merchant.id === merchantId,
        );
        if (!target) {
          throw new ConfigError("Shopee merchant is not accessible", {
            merchantId,
            availableMerchants: session.merchants.map((merchant) => ({
              id: merchant.id,
              name: merchant.name,
            })),
          });
        }
        if (session.merchant.id === merchantId) {
          await this.restorePaymentCompositions(snapshot.compositions);
          return this.exportSession();
        }
        if (!target.isActive || target.isBanned) {
          throw new ConfigError(
            "The selected Shopee merchant is inactive or banned",
            { merchantId },
          );
        }

        if (!session.switchCredential) {
          throw new AuthError(
            "AUTH_REQUIRED",
            "This Shopee session cannot switch merchants; log in again to enable switching",
          );
        }

        const previousScope = this.getPaymentScope();
        if (previousScope) await this.assertNoActivePayments(previousScope);

        const baseSession = await this.mintMerchantToken(session, merchantId);

        // The exchange left the target merchant's token in the dashboard
        // cookie; discovery runs with it, exactly as after a fresh login.
        const minted = readShopeeMerchantCredential(this.http.cookieJar);
        const merchantClient = new ShopeeMerchantClient(this.http, {
          token: minted.token,
          merchantId: baseSession.merchant.id,
          locale: this.locale,
        });
        const [profile, stores] = await Promise.all([
          merchantClient.getProfile(),
          merchantClient.listStores(),
        ]);

        this.session = {
          ...session,
          cookies: this.http.cookieJar.snapshot(),
          accountId: baseSession.accountId,
          merchant: {
            ...target,
            name: target.name || profile.merchantName,
          },
          stores: stores.map((store) => ({ ...store })),
          storeId: chooseStoreId(stores, undefined, profile.storeId),
          expiresAt: minted.expiresAt ?? session.expiresAt,
        };

        await this.persistSession();
        this.activateCurrentComposition();
        return this.exportSession();
      }),
    );
  }

  /**
   * Renew the merchant token without a new OTP, for as long as Shopee still
   * honours the passport account session captured at login.
   *
   * The dashboard token cookie advertises a ~1000-day expiry that has nothing
   * to do with the real server-side session, so callers cannot tell a live
   * session from a dead one by inspection. This asks Shopee directly
   * (`login_status`) and, while the account session holds, re-mints the active
   * merchant's token through the same SSO exchange a fresh login uses. Once the
   * account session is gone it throws `AUTH_REQUIRED`: only a new OTP recovers
   * from that, and no silent retry can change it.
   *
   * The renewed session is persisted through `onSessionUpdated`, so a caller
   * that stores sessions stays consistent even if the previous token is
   * invalidated by the exchange.
   */
  async refreshSession(): Promise<ShopeeSession> {
    return this.runPaymentTransition(() =>
      this.withPaymentTransitionRollback(async () => {
        const session = this.requireSession();
        if (!session.switchCredential) {
          throw new AuthError(
            "AUTH_REQUIRED",
            "This Shopee session predates silent renewal; log in again with an OTP",
          );
        }
        if (!(await this.auth.accountSessionAlive())) {
          throw new AuthError(
            "AUTH_REQUIRED",
            "The Shopee account session has expired; log in again with an OTP",
          );
        }

        await this.mintMerchantToken(session, session.merchant.id);
        const minted = readShopeeMerchantCredential(this.http.cookieJar);
        this.session = {
          ...session,
          cookies: this.http.cookieJar.snapshot(),
          expiresAt: minted.expiresAt ?? session.expiresAt,
        };

        await this.persistSession();
        this.activateCurrentComposition();
        return this.exportSession();
      }),
    );
  }

  /**
   * Re-run the login SSO exchange (`login_toc` → `/account/login/tob/auth`) for
   * one of the account's merchants, leaving that merchant's freshly minted
   * token in the dashboard cookie. Shared by merchant switching and session
   * renewal, which differ only in which merchant they target.
   */
  private async mintMerchantToken(
    session: ShopeeSession,
    merchantId: string,
  ): Promise<ShopeeSession> {
    const credential = session.switchCredential;
    if (!credential) {
      throw new AuthError(
        "AUTH_REQUIRED",
        "This Shopee session has no renewal credential; log in again",
      );
    }
    // The account-session cookies (SPC_*) the exchange authenticates with live
    // in the current session cookies, so reuse them as the verification input.
    const verification: ShopeeOtpVerification = {
      version: 1,
      tocNonce: credential.tocNonce,
      // `completeLogin` authenticates with the account cookies, nonce, and
      // device fingerprint below; the toc user id is not read.
      tocUserId: Number(session.accountId) || 0,
      spcClientId: credential.spcClientId,
      deviceFingerprint: credential.deviceFingerprint,
      cookies: session.cookies.map((cookie) => ({ ...cookie })),
      merchants: session.merchants.map((merchant) => ({ ...merchant })),
      verifiedAt: session.createdAt,
    };
    return this.auth.completeLogin({ verification, merchantId });
  }

  getTransactionFeed(): ShopeeTransactionFeed {
    this.assertNoPaymentTransition("access the Shopee transaction feed");
    const session = this.requireSession();
    const storeId = this.requireStoreId(session);
    const feed = this.createTransactionFeed(session, storeId);
    const scope = this.getPaymentScope();
    if (scope) {
      this.paymentCompositions
        .get(paymentScopeKey(scope))
        ?.service.setTransactionFeed(feed);
    }
    return feed;
  }

  payments(): PaymentService {
    this.assertNoPaymentTransition("access Shopee payments");
    const session = this.requireSession();
    const scope = this.getPaymentScope();
    if (!scope) {
      throw new ConfigError(
        "Select a Shopee store before creating or monitoring payments",
      );
    }

    const key = paymentScopeKey(scope);
    const feed = this.createTransactionFeed(session, scope.merchantId);
    let composition = this.paymentCompositions.get(key);
    if (!composition) {
      composition = {
        service: new PaymentService({
          merchantId: scope.merchantId,
          scope,
          store: this.store,
          transactionFeed: feed,
          staticQris: this.staticQris,
          allocator: new AmountAllocator(this.config.payment?.maxUniqueOffset),
          pollIntervalMs: this.config.payment?.pollIntervalMs,
          defaultExpiryMs: this.config.payment?.defaultExpiryMs,
          clockSkewMs: this.config.payment?.clockSkewMs,
          transactionPageSize: this.config.payment?.transactionPageSize,
          logger: this.logger,
          lifecycleToken: this.paymentLifecycleToken,
        }),
        resumePolling: false,
      };
      this.paymentCompositions.set(key, composition);
    } else {
      composition.service.setTransactionFeed(feed);
      composition.service.setStaticQris(this.staticQris);
    }

    composition.service.activate(this.paymentLifecycleToken);
    if (composition.resumePolling) {
      composition.resumePolling = false;
      composition.service.start();
    }
    return composition.service;
  }

  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    return this.payments().createPayment(input);
  }

  private async completeLoginWithinTransition(
    input: ShopeeCompleteLoginInput,
  ): Promise<ShopeeSession> {
    const baseSession = await this.auth.completeLogin({
      ...input,
      merchantId: input.merchantId ?? this.config.merchantId,
      storeId: input.storeId ?? this.config.storeId,
    });
    const credential = readShopeeMerchantCredential(this.http.cookieJar);
    const merchantClient = new ShopeeMerchantClient(this.http, {
      token: credential.token,
      merchantId: baseSession.merchant.id,
      locale: this.locale,
    });
    const [profile, stores] = await Promise.all([
      merchantClient.getProfile(),
      merchantClient.listStores(),
    ]);
    const requestedStoreId =
      input.storeId ?? this.config.storeId ?? baseSession.storeId;
    const storeId = chooseStoreId(stores, requestedStoreId, profile.storeId);

    this.session = {
      ...baseSession,
      merchant: {
        ...baseSession.merchant,
        name: baseSession.merchant.name || profile.merchantName,
      },
      merchants: input.verification.merchants.map((merchant) => ({
        ...merchant,
      })),
      // Retain the account-session material so the active merchant can later be
      // switched by replaying the login token exchange (see selectMerchant).
      switchCredential: {
        tocNonce: input.verification.tocNonce,
        spcClientId: input.verification.spcClientId,
        deviceFingerprint: input.verification.deviceFingerprint,
      },
      cookies: this.http.cookieJar.snapshot(),
      stores,
      storeId,
      expiresAt: credential.expiresAt,
    };
    await this.persistSession();
    this.activateCurrentComposition();
    return this.exportSession();
  }

  private createMerchantClient(): ShopeeMerchantClient {
    const session = this.requireSession();
    return new ShopeeMerchantClient(this.http, {
      token: this.activeMerchantToken(),
      merchantId: session.merchant.id,
      locale: this.locale,
    });
  }

  private createTransactionFeed(
    session: ShopeeSession,
    storeId: string,
  ): ShopeeTransactionFeed {
    return new ShopeeTransactionFeed(this.http, {
      token: this.activeMerchantToken(),
      merchantId: session.merchant.id,
      storeId,
      locale: this.locale,
      logger: this.logger,
    });
  }

  /**
   * The token that authenticates merchant/store/payment calls for the active
   * merchant. Selecting a merchant re-runs the login SSO exchange, which leaves
   * that merchant's token in the dashboard cookie - so the cookie is always the
   * single source of truth, both after a switch and after a plain login.
   */
  private activeMerchantToken(): string {
    return readShopeeMerchantCredential(this.http.cookieJar).token;
  }

  private requireSession(): ShopeeSession {
    if (!this.session || !this.authenticated) {
      throw new AuthError(
        "AUTH_REQUIRED",
        "Shopee session is missing or expired; login again",
      );
    }
    return this.session;
  }

  private requireStoreId(session: ShopeeSession): string {
    if (!session.storeId) {
      throw new ConfigError(
        "Shopee storeId is required for transaction polling",
      );
    }
    return session.storeId;
  }

  private async assertNoActivePayments(scope: PaymentScope): Promise<void> {
    const active = await this.store.listActive(scope);
    const activePaymentCount = active.filter(
      (payment) =>
        payment.scope !== undefined && samePaymentScope(payment.scope, scope),
    ).length;
    if (activePaymentCount > 0) {
      throw new ConfigError(
        "Cannot switch Shopee store while its payments are still active",
        { activePaymentCount },
      );
    }
  }

  private runPaymentTransition<T>(task: () => Promise<T>): Promise<T> {
    if (this.sessionUpdateInProgress) {
      throw new ConfigError(
        "Shopee session update callbacks cannot start another provider transition",
      );
    }
    this.paymentTransitionReservations += 1;
    const result = this.paymentTransitionQueue.then(task);
    this.paymentTransitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.paymentTransitionReservations -= 1;
    });
  }

  private assertNoPaymentTransition(operation: string): void {
    if (this.paymentTransitionReservations === 0) return;
    throw new ConfigError(
      `Cannot ${operation} while a Shopee session or store transition is in progress`,
    );
  }

  private async withPaymentTransitionRollback<T>(
    task: (snapshot: PaymentTransitionSnapshot) => Promise<T>,
  ): Promise<T> {
    const snapshot = await this.capturePaymentTransition();
    try {
      return await task(snapshot);
    } catch (error) {
      await this.restorePaymentTransition(snapshot);
      throw error;
    }
  }

  private async capturePaymentTransition(): Promise<PaymentTransitionSnapshot> {
    const compositions = await this.suspendPaymentCompositions();
    const cookies = this.http.cookieJar.snapshot();
    const session = this.session
      ? cloneSession({ ...this.session, cookies })
      : undefined;
    return { session, cookies, compositions };
  }

  private async restorePaymentTransition(
    snapshot: PaymentTransitionSnapshot,
  ): Promise<void> {
    this.http.cookieJar.restore(snapshot.cookies);
    this.session = snapshot.session
      ? cloneSession(snapshot.session)
      : undefined;
    await this.restorePaymentCompositions(snapshot.compositions);
  }

  private async persistSession(): Promise<void> {
    const onSessionUpdated = this.config.onSessionUpdated;
    if (!onSessionUpdated) return;

    this.sessionUpdateInProgress = true;
    try {
      await onSessionUpdated(this.exportSession());
    } finally {
      this.sessionUpdateInProgress = false;
    }
  }

  private async suspendPaymentCompositions(): Promise<
    PaymentCompositionSnapshot[]
  > {
    const snapshots = [...this.paymentCompositions.values()].map(
      (composition): PaymentCompositionSnapshot => ({
        composition,
        active: composition.service.isActive,
        running: composition.service.isRunning,
        resumePolling: composition.resumePolling,
      }),
    );

    await Promise.all(
      snapshots.map(async ({ composition }) => {
        const wasRunning = await composition.service.deactivate(
          this.paymentLifecycleToken,
        );
        if (wasRunning) composition.resumePolling = true;
      }),
    );
    return snapshots;
  }

  private async restorePaymentCompositions(
    snapshots: readonly PaymentCompositionSnapshot[],
  ): Promise<void> {
    await Promise.all(
      [...this.paymentCompositions.values()].map(({ service }) =>
        service.deactivate(this.paymentLifecycleToken),
      ),
    );

    for (const snapshot of snapshots) {
      snapshot.composition.resumePolling = snapshot.resumePolling;
      if (!snapshot.active) continue;
      snapshot.composition.service.activate(this.paymentLifecycleToken);
      if (snapshot.running) snapshot.composition.service.start();
    }
  }

  private activateCurrentComposition(): void {
    const session = this.session;
    const scope = this.getPaymentScope();
    if (!session || !scope) return;
    const composition = this.paymentCompositions.get(paymentScopeKey(scope));
    if (!composition) return;
    composition.service.setTransactionFeed(
      this.createTransactionFeed(session, scope.merchantId),
    );
    composition.service.setStaticQris(this.staticQris);
    composition.service.activate(this.paymentLifecycleToken);
    if (composition.resumePolling) {
      composition.resumePolling = false;
      composition.service.start();
    }
  }
}

function cloneSession(session: ShopeeSession): ShopeeSession {
  return {
    ...session,
    cookies: session.cookies.map((cookie) => ({ ...cookie })),
    merchant: { ...session.merchant },
    // Sessions persisted before multi-merchant support lack `merchants`; fall
    // back to the active merchant so the switch list is never empty.
    merchants: (session.merchants ?? [session.merchant]).map((merchant) => ({
      ...merchant,
    })),
    switchCredential: session.switchCredential
      ? { ...session.switchCredential }
      : undefined,
    stores: session.stores.map((store) => ({ ...store })),
  };
}

function assertKnownStore(
  stores: readonly ShopeeStore[],
  storeId: string,
): void {
  if (!stores.some((store) => store.id === storeId)) {
    throw new ConfigError("Configured Shopee storeId is not accessible", {
      storeId,
      availableStoreIds: stores.map((store) => store.id),
    });
  }
}

function assertValidStaticQris(staticQris: string): void {
  if (!isValidQrisChecksum(staticQris)) {
    throw new ConfigError("Shopee static QRIS checksum is invalid");
  }
  try {
    staticToDynamicQris(staticQris, 1);
  } catch {
    throw new ConfigError("Shopee static QRIS payload is invalid");
  }
}

function assertStaticQrisScope(scope: ShopeeStaticQrisScope): void {
  if (!scope.merchantId.trim() || !scope.storeId.trim()) {
    throw new ConfigError(
      "Shopee staticQrisScope requires merchantId and storeId",
    );
  }
}

function inferStaticQrisScope(
  session?: ShopeeSession,
  merchantId?: string,
  storeId?: string,
): ShopeeStaticQrisScope | undefined {
  const resolvedMerchantId = session?.merchant.id ?? merchantId;
  const resolvedStoreId = session?.storeId ?? storeId;
  return resolvedMerchantId && resolvedStoreId
    ? { merchantId: resolvedMerchantId, storeId: resolvedStoreId }
    : undefined;
}

function paymentScopeKey(scope: PaymentScope): string {
  return JSON.stringify([
    scope.provider,
    scope.accountId ?? "",
    scope.merchantId,
  ]);
}

function chooseStoreId(
  stores: readonly ShopeeStore[],
  requestedId?: string,
  profileStoreId?: string,
): string | undefined {
  if (requestedId) {
    assertKnownStore(stores, requestedId);
    return requestedId;
  }
  if (profileStoreId && stores.some((store) => store.id === profileStoreId)) {
    return profileStoreId;
  }
  if (stores.length === 1) return stores[0]?.id;
  return undefined;
}
