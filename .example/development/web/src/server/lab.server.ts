import { createHash, randomUUID } from "node:crypto";
import {
  AuthError,
  GopayProvider,
  MerchantIdError,
  SHOPEE_DEVICE_RISK_BLOB,
  ShopeeProvider,
  isValidQrisChecksum,
  staticToDynamicQris,
  type GopayProviderConfig,
  type Logger,
  type Payment,
  type ShopeeOtpChallenge,
  type ShopeeOtpVerification,
  type ShopeeProviderConfig,
} from "merchantid";
import { renderSVG } from "uqr";
import type {
  ActionResult,
  ActivityTone,
  ActivityView,
  LabSnapshot,
  PaymentView,
  ProviderId,
  ProviderSnapshot,
  ScopeView,
} from "../lib/lab-types";
import {
  JsonPaymentStore,
  loadLabState,
  saveLabState,
  storageLabel,
  type StoredGopayMerchant,
  type StoredLabState,
} from "./storage.server";

type ProviderInstance = GopayProvider | ShopeeProvider;

type PendingAuth =
  | {
      providerId: "gopay";
      provider: GopayProvider;
      otpToken: string;
    }
  | {
      providerId: "shopee";
      provider: ShopeeProvider;
      challenge: ShopeeOtpChallenge;
      verification?: ShopeeOtpVerification;
    };

/**
 * Scrub anything credential-shaped before an error message reaches the browser.
 *
 * Keyword rules alone were not enough: the GoPay refresh token is a five-segment
 * JWE whose second segment is empty and third is only 16 chars, so a
 * three-segment JWT pattern missed it entirely, and a `Cookie:` header lost only
 * its first pair because the value rule stopped at `;`. The final pass is
 * therefore value-shaped — any long opaque run, dotted or not, is replaced
 * whole. Over-redacting an error message costs nothing; under-redacting it
 * ships a live credential into the DOM.
 */
export function redactSensitiveText(value: string): string {
  return (
    value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(
        /(authorization|access[_ -]?token|refresh[_ -]?token|set[_ -]?cookie|cookie|token|nonce|fingerprint|secret|api[_ -]?key|otp(?:[_ -]?token)?|challenge(?:[_ -]?token)?|qris(?:[_ -]?(?:payload|string))?|password|phone(?:[_ -]?(?:number|no))?)['"]?\s*[:=]\s*['"]?[^'",\s}]+['"]?/gi,
        "$1=[redacted]",
      )
      // Opaque blobs of any segment count: JWT (3), JWE (5), bare base64.
      .replace(
        /[A-Za-z0-9_\-+/=]{24,}(?:\.[A-Za-z0-9_\-+/=]*){0,4}/g,
        "[redacted-blob]",
      )
      // Bare OTP codes and Indonesian mobile numbers.
      .replace(/\b\d{4,8}\b(?=\s*(?:otp|kode|code)?)/gi, (match, offset, all) =>
        /otp|kode|code/i.test(String(all).slice(Math.max(0, offset - 20), offset))
          ? "[redacted]"
          : match,
      )
      .replace(/\b(?:\+?62|0)8\d{7,12}\b/g, "[redacted-phone]")
      .slice(0, 480)
  );
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof MerchantIdError) {
    return `${error.code}: ${redactSensitiveText(error.message)}`;
  }
  if (error instanceof Error) return redactSensitiveText(error.message);
  return "Unknown development lab error";
}

function fingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function maskIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function maskScope(
  scope:
    { provider: string; accountId?: string; merchantId: string } | undefined,
): ScopeView | undefined {
  if (!scope) return undefined;
  return {
    provider: scope.provider,
    accountId: maskIdentifier(scope.accountId),
    merchantId: maskIdentifier(scope.merchantId) ?? "unknown",
  };
}

function providerLabel(providerId: ProviderId): string {
  return providerId === "gopay" ? "GoPay Merchant" : "ShopeePay Merchant";
}

export class LabRuntime {
  private state: StoredLabState;
  private readonly store = new JsonPaymentStore();
  private readonly providers = new Map<ProviderId, ProviderInstance>();
  private readonly gopayProviders = new Map<string, GopayProvider>();
  private shopeeProvider?: ShopeeProvider;
  private pendingAuth?: PendingAuth;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(state: StoredLabState) {
    this.state = state;
  }

  static async create(): Promise<LabRuntime> {
    const runtime = new LabRuntime(await loadLabState());
    runtime.restoreProviders();
    if (runtime.state.activity.length === 0) {
      await runtime.record(
        "warning",
        "Local package active",
        "Package lokal file:../.. aktif. Tindakan lab berikutnya dapat mengirim request nyata ke provider.",
      );
    }
    return runtime;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      const previousState = structuredClone(this.state);
      const previousPendingAuth = this.pendingAuth;
      const previousSerialized = JSON.stringify(previousState);
      try {
        return await operation();
      } catch (error) {
        const durableState = await loadLabState().catch(() => previousState);
        this.state = durableState;
        if (JSON.stringify(durableState) === previousSerialized) {
          this.pendingAuth = previousPendingAuth;
        }
        this.restoreProviders();
        throw error;
      }
    };
    const result = this.operationQueue.then(execute);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueActivity(
    tone: ActivityTone,
    title: string,
    message: string,
    providerId: ProviderId,
  ): void {
    const result = this.operationQueue.then(() =>
      this.record(tone, title, message, providerId),
    );
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
  }

  private createLogger(providerId: ProviderId): Logger {
    return {
      debug: () => {},
      info: (message) => {
        this.enqueueActivity(
          "info",
          `${providerLabel(providerId)} event`,
          message,
          providerId,
        );
      },
      warn: (message) => {
        this.enqueueActivity(
          "warning",
          `${providerLabel(providerId)} warning`,
          message,
          providerId,
        );
      },
      error: (message) => {
        this.enqueueActivity(
          "danger",
          `${providerLabel(providerId)} error`,
          message,
          providerId,
        );
      },
    };
  }

  private gopayOptions(): GopayProviderConfig | undefined {
    const stored = this.state.gopay;
    if (!stored.session) return undefined;
    return {
      session: stored.session,
      merchantId: stored.selectedMerchantId,
      staticQris: stored.staticQris,
      store: this.store,
      logger: this.createLogger("gopay"),
      onTokenRefreshed: async (session) => {
        const nextState = structuredClone(this.state);
        nextState.gopay.session = session;
        await this.commitState(nextState);
      },
    };
  }

  private shopeeOptions(): ShopeeProviderConfig | undefined {
    const stored = this.state.shopee;
    if (!stored.session) return undefined;
    return {
      session: stored.session,
      staticQris: stored.staticQris,
      staticQrisScope: stored.staticQrisScope,
      store: this.store,
      logger: this.createLogger("shopee"),
      onSessionUpdated: async (session) => {
        const nextState = structuredClone(this.state);
        nextState.shopee.session = session;
        await this.commitState(nextState);
      },
    };
  }

  private restoreProviders(): void {
    this.providers.clear();
    const gopayOptions = this.gopayOptions();
    if (gopayOptions) {
      const scopeKey = gopayOptions.merchantId ?? "unscoped";
      let gopay = this.gopayProviders.get(scopeKey);
      if (!gopay) {
        gopay = new GopayProvider(gopayOptions);
        this.gopayProviders.set(scopeKey, gopay);
      } else if (gopayOptions.merchantId) {
        gopay.payments().setStaticQris(gopayOptions.staticQris);
      }
      this.providers.set("gopay", gopay);
    }

    const shopeeOptions = this.shopeeOptions();
    if (shopeeOptions) {
      this.shopeeProvider ??= new ShopeeProvider(shopeeOptions);
      this.providers.set("shopee", this.shopeeProvider);
    } else {
      this.shopeeProvider = undefined;
    }
  }

  private getProvider(providerId: ProviderId): ProviderInstance {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AuthError(
        "AUTH_REQUIRED",
        `Login ${providerLabel(providerId)} terlebih dahulu`,
      );
    }
    return provider;
  }

  private getGopay(): GopayProvider {
    const provider = this.getProvider("gopay");
    if (!(provider instanceof GopayProvider))
      throw new Error("GoPay runtime mismatch");
    return provider;
  }

  private getShopee(): ShopeeProvider {
    const provider = this.getProvider("shopee");
    if (!(provider instanceof ShopeeProvider))
      throw new Error("Shopee runtime mismatch");
    return provider;
  }

  private async commitState(nextState: StoredLabState): Promise<void> {
    await saveLabState(nextState);
    this.state = nextState;
  }

  private async record(
    tone: ActivityTone,
    title: string,
    message: string,
    providerId?: ProviderId,
  ): Promise<void> {
    const activity: ActivityView = {
      id: randomUUID(),
      at: Date.now(),
      tone,
      title: redactSensitiveText(title),
      message: redactSensitiveText(message),
      providerId,
    };
    const nextState = structuredClone(this.state);
    nextState.activity = [...nextState.activity, activity].slice(-60);
    await this.commitState(nextState);
  }

  private result(snapshot: LabSnapshot, notice?: string): ActionResult {
    return notice ? { snapshot, notice } : { snapshot };
  }

  async snapshot(): Promise<LabSnapshot> {
    const allPayments = await this.store.all();
    const pendingPayments = allPayments.filter(
      (payment) => payment.status === "pending",
    );
    const recentTerminalPayments = allPayments
      .filter((payment) => payment.status !== "pending")
      .slice(0, Math.max(0, 60 - pendingPayments.length));
    const payments = [...pendingPayments, ...recentTerminalPayments].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
    return {
      activeProviderId: this.state.activeProviderId,
      providers: {
        gopay: this.providerSnapshot("gopay"),
        shopee: this.providerSnapshot("shopee"),
      },
      payments: payments.map((payment) => this.paymentView(payment)),
      activity: [...this.state.activity].reverse(),
      packageSource: "file:../..",
      storageLabel,
      startedAt: this.state.startedAt,
    };
  }

  private providerSnapshot(providerId: ProviderId): ProviderSnapshot {
    const provider = this.providers.get(providerId);
    const pending =
      this.pendingAuth?.providerId === providerId
        ? this.pendingAuth
        : undefined;
    const authenticated = provider?.authenticated ?? false;
    let authStage: ProviderSnapshot["authStage"] = authenticated
      ? "ready"
      : "signed-out";
    if (pending?.providerId === "shopee" && pending.verification)
      authStage = "merchant";
    else if (pending) authStage = "otp";
    else if (
      providerId === "shopee" &&
      authenticated &&
      !provider?.getPaymentScope()
    ) {
      authStage = "store";
    }

    if (providerId === "gopay") {
      const stored = this.state.gopay;
      return {
        id: providerId,
        label: providerLabel(providerId),
        description:
          "GoID session, merchant discovery, dynamic QRIS, dan feed offset.",
        authenticated,
        authStage,
        sessionFingerprint: fingerprint(stored.session?.tokens.accessToken),
        sessionExpiresAt: stored.session?.tokens.expiresAt,
        selectedMerchantId: stored.selectedMerchantId,
        merchants: stored.merchants.map(({ id, label, detail }) => ({
          id,
          label,
          detail,
        })),
        stores: [],
        scope: maskScope(provider?.getPaymentScope()),
        hasStaticQris: Boolean(stored.staticQris),
      };
    }

    const session = this.state.shopee.session;
    const pendingMerchants =
      pending?.providerId === "shopee"
        ? pending.verification?.merchants.map((merchant) => ({
            id: merchant.id,
            label: merchant.name || `Merchant ${merchant.id}`,
            detail: merchant.isActive ? "Active business" : "Unavailable",
          }))
        : undefined;
    return {
      id: providerId,
      label: providerLabel(providerId),
      description:
        "Cookie session, business merchant, store scope, dan cursor feed.",
      authenticated,
      authStage,
      sessionFingerprint: fingerprint(
        session?.cookies.map((cookie) => cookie.value).join("|"),
      ),
      sessionExpiresAt: session?.expiresAt,
      selectedMerchantId: session?.merchant.id,
      selectedStoreId: session?.storeId,
      merchants:
        pendingMerchants ??
        (session
          ? (session.merchants ?? [session.merchant]).map((merchant) => ({
              id: merchant.id,
              label: merchant.name || `Merchant ${merchant.id}`,
              detail:
                merchant.id === session.merchant.id
                  ? "Active business merchant"
                  : merchant.isActive
                    ? "Business merchant"
                    : "Unavailable",
            }))
          : []),
      stores:
        session?.stores.map((store) => ({
          id: store.id,
          label: store.name,
          detail:
            store.status === 1 ? "Active store" : `Status ${store.status}`,
        })) ?? [],
      scope: maskScope(provider?.getPaymentScope()),
      hasStaticQris: Boolean(provider?.staticQris),
    };
  }

  private paymentView(payment: Payment): PaymentView {
    return {
      id: payment.id,
      provider: payment.scope?.provider ?? "unscoped",
      merchantId: maskIdentifier(payment.scope?.merchantId) ?? "unknown",
      reference: payment.reference,
      baseAmount: payment.baseAmount,
      uniqueAmount: payment.uniqueAmount,
      uniqueOffset: payment.uniqueOffset,
      status: payment.status,
      createdAt: payment.createdAt,
      expiresAt: payment.expiresAt,
      qrSvg:
        payment.status === "pending" && payment.qrString
          ? renderSVG(payment.qrString, { ecc: "M", border: 2 })
          : undefined,
      transactionId: maskIdentifier(payment.transaction?.id),
    };
  }

  async setActiveProvider(providerId: ProviderId): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const nextState = structuredClone(this.state);
      nextState.activeProviderId = providerId;
      await this.commitState(nextState);
      return this.result(await this.snapshot());
    });
  }

  async requestOtp(input: {
    providerId: ProviderId;
    phoneNumber: string;
    countryCode?: string;
    channel?: number;
    password?: string;
  }): Promise<ActionResult> {
    return this.runExclusive(async () => {
      if (input.providerId === "gopay") {
        const provider = new GopayProvider({
          store: this.store,
          logger: this.createLogger("gopay"),
          onTokenRefreshed: async (session) => {
            const nextState = structuredClone(this.state);
            nextState.gopay.session = session;
            await this.commitState(nextState);
          },
        });
        const challenge = await provider.requestOtp(
          input.phoneNumber,
          input.countryCode ?? "62",
        );
        if (!challenge.otpToken)
          throw new Error("GoPay did not return an OTP token");
        this.pendingAuth = {
          providerId: "gopay",
          provider,
          otpToken: challenge.otpToken,
        };
      } else {
        const provider = new ShopeeProvider({
          store: this.store,
          logger: this.createLogger("shopee"),
          deviceReport: SHOPEE_DEVICE_RISK_BLOB,
          onSessionUpdated: async (session) => {
            const nextState = structuredClone(this.state);
            nextState.shopee = { session };
            await this.commitState(nextState);
            this.shopeeProvider = provider;
          },
        });
        const challenge = await provider.requestOtp(input.phoneNumber, {
          channel: input.channel,
          password: input.password,
        });
        this.pendingAuth = {
          providerId: "shopee",
          provider,
          challenge,
        };
        const channelNames: Record<number, string> = {
          1: "SMS",
          2: "telepon",
          3: "WhatsApp",
          4: "email",
          5: "Zalo",
        };
        const channelName =
          channelNames[challenge.channel] ?? `kanal ${challenge.channel}`;
        const passwordNote = challenge.hasPassword
          ? "password diterima (2FA aktif)"
          : "tanpa langkah password";
        await this.record(
          "warning",
          "OTP requested",
          `Shopee menerima permintaan lewat ${channelName}; ${passwordNote}. Tunggu OTP nyata di HP.`,
          input.providerId,
        );
        return this.result(await this.snapshot(), "OTP telah dikirim");
      }

      await this.record(
        "warning",
        "OTP requested",
        "Permintaan OTP nyata dikirim melalui provider yang dipilih.",
        input.providerId,
      );
      return this.result(await this.snapshot(), "OTP telah dikirim");
    });
  }

  async verifyOtp(input: {
    providerId: ProviderId;
    otp: string;
  }): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const pending = this.pendingAuth;
      if (!pending || pending.providerId !== input.providerId) {
        throw new Error("Request an OTP for this provider first");
      }

      if (pending.providerId === "gopay") {
        if (!pending.provider || !pending.otpToken)
          throw new Error("GoPay OTP state expired");
        await pending.provider.verifyOtp({
          otp: input.otp,
          otpToken: pending.otpToken,
        });
        const merchants = await pending.provider
          .listMerchants()
          .catch(() => []);
        const records: StoredGopayMerchant[] = merchants.map((merchant) => ({
          id: merchant.id,
          label: merchant.merchantName || `Merchant ${merchant.id}`,
          detail: merchant.outletName,
          staticQris: merchant.qrString,
        }));
        const selectedMerchantId =
          pending.provider.getPaymentScope()?.merchantId ?? records[0]?.id;
        const selected = records.find(
          (merchant) => merchant.id === selectedMerchantId,
        );
        const nextState = structuredClone(this.state);
        nextState.gopay = {
          session: pending.provider.exportSession(),
          merchants: records,
          selectedMerchantId,
          staticQris: pending.provider.staticQris ?? selected?.staticQris,
        };
        await this.commitState(nextState);
        if (selectedMerchantId) {
          this.gopayProviders.set(selectedMerchantId, pending.provider);
        }
        this.pendingAuth = undefined;
        this.restoreProviders();
      } else {
        if (!pending.provider || !pending.challenge)
          throw new Error("Shopee OTP state expired");
        const verification = await pending.provider.verifyOtp({
          challenge: pending.challenge,
          otp: input.otp,
        });
        this.pendingAuth = { ...pending, verification };
      }

      await this.record(
        "success",
        input.providerId === "shopee" && this.pendingAuth
          ? "OTP verified"
          : "Session connected",
        input.providerId === "shopee" && this.pendingAuth
          ? "Choose the business merchant to finish Shopee login."
          : "The provider session was persisted in the gitignored data directory.",
        input.providerId,
      );
      return this.result(await this.snapshot(), "OTP berhasil diverifikasi");
    });
  }

  async completeShopeeLogin(input: {
    merchantId: string;
    storeId?: string;
  }): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const pending = this.pendingAuth;
      if (
        !pending ||
        pending.providerId !== "shopee" ||
        !pending.provider ||
        !pending.verification
      ) {
        throw new Error("Verify a Shopee OTP before selecting a merchant");
      }
      const session = await pending.provider.completeLogin({
        verification: pending.verification,
        merchantId: input.merchantId,
        storeId: input.storeId,
      });
      const nextState = structuredClone(this.state);
      nextState.shopee = { session };
      await this.commitState(nextState);
      this.shopeeProvider = pending.provider;
      this.pendingAuth = undefined;
      this.restoreProviders();
      await this.record(
        "success",
        "Shopee session connected",
        session.storeId
          ? "Business merchant and store scope are ready."
          : "Select a store before creating payments.",
        "shopee",
      );
      return this.result(await this.snapshot(), "Shopee login selesai");
    });
  }

  async refreshDiscovery(providerId: ProviderId): Promise<ActionResult> {
    return this.runExclusive(async () => {
      if (providerId === "gopay") {
        const merchants = await this.getGopay().listMerchants();
        const nextState = structuredClone(this.state);
        nextState.gopay.merchants = merchants.map((merchant) => ({
          id: merchant.id,
          label: merchant.merchantName || `Merchant ${merchant.id}`,
          detail: merchant.outletName,
          staticQris: merchant.qrString,
        }));
        await this.commitState(nextState);
      } else {
        const provider = this.getShopee();
        await provider.listStores();
        const nextState = structuredClone(this.state);
        nextState.shopee.session = provider.exportSession();
        await this.commitState(nextState);
      }
      await this.record(
        "success",
        "Discovery refreshed",
        `${providerLabel(providerId)} merchant/store metadata updated.`,
        providerId,
      );
      return this.result(await this.snapshot());
    });
  }

  async selectMerchant(merchantId: string): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const merchant = this.state.gopay.merchants.find(
        (entry) => entry.id === merchantId,
      );
      if (!merchant || !this.state.gopay.session)
        throw new Error("Unknown GoPay merchant");
      const nextState = structuredClone(this.state);
      nextState.gopay.selectedMerchantId = merchant.id;
      nextState.gopay.staticQris = merchant.staticQris;
      await this.commitState(nextState);
      this.restoreProviders();
      await this.record(
        "success",
        "GoPay merchant selected",
        "Payment scope and QRIS now follow the selected merchant.",
        "gopay",
      );
      return this.result(await this.snapshot());
    });
  }

  async selectStore(storeId: string): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const provider = this.getShopee();
      const session = await provider.selectStore(storeId);
      const nextState = structuredClone(this.state);
      nextState.shopee.session = session;
      await this.commitState(nextState);
      await this.record(
        "success",
        "Shopee store selected",
        "Payment scope moved after the old scope passed the active-payment guard.",
        "shopee",
      );
      return this.result(await this.snapshot());
    });
  }

  async switchShopeeMerchant(merchantId: string): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const provider = this.getShopee();
      const session = await provider.selectMerchant(merchantId);
      const nextState = structuredClone(this.state);
      nextState.shopee.session = session;
      await this.commitState(nextState);
      await this.record(
        "success",
        "Shopee merchant switched",
        session.storeId
          ? "Active merchant and store scope moved to the selected business."
          : "Active merchant switched; select a store before creating payments.",
        "shopee",
      );
      return this.result(await this.snapshot(), "Merchant Shopee diganti");
    });
  }

  async setStaticQris(
    providerId: ProviderId,
    payload: string,
  ): Promise<ActionResult> {
    return this.runExclusive(async () => {
      if (!isValidQrisChecksum(payload))
        throw new Error("QRIS checksum is invalid");
      staticToDynamicQris(payload, 1);

      if (providerId === "gopay") {
        if (!this.state.gopay.session || !this.state.gopay.selectedMerchantId) {
          throw new Error("Connect and select a GoPay merchant first");
        }
        const nextState = structuredClone(this.state);
        nextState.gopay.staticQris = payload;
        const selected = nextState.gopay.merchants.find(
          (merchant) => merchant.id === nextState.gopay.selectedMerchantId,
        );
        if (selected) selected.staticQris = payload;
        await this.commitState(nextState);
        this.getGopay().payments().setStaticQris(payload);
      } else {
        const provider = this.getShopee();
        const scope = provider.getPaymentScope();
        if (!scope?.accountId) {
          throw new Error("Connect and select a Shopee store first");
        }
        const nextState = structuredClone(this.state);
        nextState.shopee.staticQris = payload;
        nextState.shopee.staticQrisScope = {
          merchantId: scope.accountId,
          storeId: scope.merchantId,
        };
        await this.commitState(nextState);
        provider.setStaticQris(payload);
      }

      await this.record(
        "success",
        "Static QRIS bound",
        "The payload was validated and stored server-side for the active scope.",
        providerId,
      );
      return this.result(await this.snapshot(), "QRIS tersimpan");
    });
  }

  async createPayment(input: {
    providerId: ProviderId;
    amount: number;
    reference?: string;
    expiresInMinutes?: number;
  }): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const provider = this.getProvider(input.providerId);
      const payment = await provider.createPayment({
        amount: input.amount,
        reference: input.reference,
        expiresInMs:
          input.expiresInMinutes === undefined
            ? undefined
            : input.expiresInMinutes * 60_000,
      });
      await this.record(
        "success",
        "Payment created",
        `Unique amount Rp ${payment.uniqueAmount.toLocaleString("id-ID")} is pending.`,
        input.providerId,
      );
      return this.result(await this.snapshot(), "Payment berhasil dibuat");
    });
  }

  async cancelPayment(paymentId: string): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const payment = await this.store.get(paymentId);
      if (!payment?.scope) throw new Error("Payment was not found");
      const providerId = payment.scope.provider as ProviderId;
      const cancelled = await this.getProvider(providerId)
        .payments()
        .cancelPayment(paymentId);
      await this.record(
        "warning",
        "Payment cancellation requested",
        cancelled?.status === "cancelled"
          ? "The payment is cancelled and its amount enters quarantine."
          : "The payment was already terminal and remained unchanged.",
        providerId,
      );
      return this.result(await this.snapshot());
    });
  }

  private async tickProvider(providerId: ProviderId) {
    const service = this.getProvider(providerId).payments();
    let failure: Error | undefined;
    const captureFailure = (error: Error) => {
      failure ??= error;
    };
    service.on("error", captureFailure);
    try {
      const result = await service.tick();
      if (failure) throw failure;
      return result;
    } finally {
      service.off("error", captureFailure);
    }
  }

  async reconcile(providerId: ProviderId): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const result = await this.tickProvider(providerId);
      await this.record(
        result.paid.length > 0 ? "success" : "info",
        "Reconciliation tick complete",
        `${result.paid.length} paid · ${result.expired.length} expired.`,
        providerId,
      );
      return this.result(await this.snapshot());
    });
  }

  async refreshSession(providerId: ProviderId): Promise<ActionResult> {
    return this.runExclusive(async () => {
      if (providerId === "shopee") {
        const provider = this.getShopee();
        const session = await provider.refreshSession();
        const nextState = structuredClone(this.state);
        nextState.shopee.session = session;
        await this.commitState(nextState);
        await this.record(
          "success",
          "Shopee session renewed",
          "Merchant token was re-minted from the live account session; no OTP needed.",
          "shopee",
        );
        return this.result(await this.snapshot(), "Sesi Shopee diperbarui");
      }
      const provider = this.getGopay();
      await provider.refreshSession();
      const nextState = structuredClone(this.state);
      nextState.gopay.session = provider.exportSession();
      await this.commitState(nextState);
      await this.record(
        "success",
        "GoPay session checked",
        "Token validity was evaluated and any required rotation was persisted.",
        "gopay",
      );
      return this.result(await this.snapshot());
    });
  }

  async logout(providerId: ProviderId): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const nextState = structuredClone(this.state);
      if (providerId === "gopay") nextState.gopay = { merchants: [] };
      else nextState.shopee = {};
      await this.commitState(nextState);

      this.providers.delete(providerId);
      this.pendingAuth = undefined;
      if (providerId === "gopay") this.gopayProviders.clear();
      else this.shopeeProvider = undefined;
      await this.store.removeProvider(providerId);
      await this.record(
        "warning",
        `${providerLabel(providerId)} disconnected`,
        "Persisted session and provider-owned development payments were removed.",
        providerId,
      );
      return this.result(await this.snapshot(), "Session dihapus");
    });
  }

  async clearActivity(): Promise<ActionResult> {
    return this.runExclusive(async () => {
      const nextState = structuredClone(this.state);
      nextState.activity = [];
      await this.commitState(nextState);
      return this.result(await this.snapshot());
    });
  }
}

let runtimePromise: Promise<LabRuntime> | undefined;

export function getLabRuntime(): Promise<LabRuntime> {
  runtimePromise ??= LabRuntime.create();
  return runtimePromise;
}

export async function runLabAction(
  action: (runtime: LabRuntime) => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await action(await getLabRuntime());
  } catch (error) {
    throw new Error(safeErrorMessage(error));
  }
}
