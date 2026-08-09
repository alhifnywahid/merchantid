import { ConfigError } from "./core/errors.js";
import type { MerchantProvider } from "./core/provider.js";
import type { PaymentScope } from "./core/types.js";

export type RegisteredMerchantProvider = MerchantProvider<unknown>;

export interface MerchantIdConfig {
  providers?: readonly RegisteredMerchantProvider[];
  defaultProviderId?: string;
}

export interface MerchantIdProviderSummary {
  id: string;
  authenticated: boolean;
  paymentScope?: PaymentScope;
  hasStaticQris: boolean;
  default: boolean;
}

/**
 * Provider registry and composition root. Concrete authentication and payment
 * behavior remains owned by each provider adapter.
 */
export class MerchantId {
  private readonly providers = new Map<string, RegisteredMerchantProvider>();
  private defaultId?: string;

  constructor(config: MerchantIdConfig = {}) {
    for (const provider of config.providers ?? []) {
      this.register(provider);
    }
    if (config.defaultProviderId !== undefined) {
      this.setDefaultProvider(config.defaultProviderId);
    }
  }

  register<TSession>(provider: MerchantProvider<TSession>): this {
    const id = provider.providerId.trim();
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ConfigError(
        "providerId must use lowercase letters, numbers, and hyphens",
      );
    }
    if (this.providers.has(id)) {
      throw new ConfigError(`Provider is already registered: ${id}`);
    }
    this.providers.set(id, provider as RegisteredMerchantProvider);
    if (!this.defaultId && this.providers.size === 1) this.defaultId = id;
    return this;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  getProvider<
    TProvider extends RegisteredMerchantProvider = RegisteredMerchantProvider,
  >(providerId?: string): TProvider {
    const id = providerId ?? this.resolveDefaultProviderId();
    const provider = this.providers.get(id);
    if (!provider) throw new ConfigError(`Provider is not registered: ${id}`);
    return provider as TProvider;
  }

  setDefaultProvider(providerId: string): this {
    if (!this.providers.has(providerId)) {
      throw new ConfigError(
        `Cannot select an unregistered provider: ${providerId}`,
      );
    }
    this.defaultId = providerId;
    return this;
  }

  get defaultProviderId(): string | undefined {
    return this.defaultId;
  }

  listProviders(): MerchantIdProviderSummary[] {
    return [...this.providers.entries()].map(([id, provider]) => ({
      id,
      authenticated: provider.authenticated,
      paymentScope: provider.getPaymentScope(),
      hasStaticQris: Boolean(provider.staticQris),
      default: id === this.defaultId,
    }));
  }

  exportSessions(): Record<string, unknown> {
    const sessions: Record<string, unknown> = {};
    for (const [id, provider] of this.providers) {
      if (provider.authenticated) sessions[id] = provider.exportSession();
    }
    return sessions;
  }

  private resolveDefaultProviderId(): string {
    if (this.defaultId) return this.defaultId;
    if (this.providers.size === 1)
      return this.providers.keys().next().value as string;
    throw new ConfigError(
      "providerId is required when no default provider is configured",
    );
  }
}

export function createMerchantId(config: MerchantIdConfig = {}): MerchantId {
  return new MerchantId(config);
}
