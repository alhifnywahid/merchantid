import { describe, expect, it } from "vitest";
import { MerchantId, createMerchantId } from "../../../src/merchantid.js";
import { ConfigError } from "../../../src/core/errors.js";
import type { MerchantProvider } from "../../../src/core/provider.js";
import type { PaymentScope } from "../../../src/core/types.js";

interface TestSession {
  marker: string;
}

function provider(options: {
  id: string;
  authenticated?: boolean;
  scope?: PaymentScope;
  staticQris?: string;
}): MerchantProvider<TestSession> {
  return {
    providerId: options.id,
    authenticated: options.authenticated ?? false,
    staticQris: options.staticQris,
    getPaymentScope: () => (options.scope ? { ...options.scope } : undefined),
    exportSession: () => ({ marker: `session:${options.id}` }),
  };
}

describe("MerchantId provider registry", () => {
  it("selects the first provider by default and supports an explicit default", () => {
    const gopay = provider({ id: "gopay" });
    const shopee = provider({ id: "shopee" });
    const registry = createMerchantId({ providers: [gopay, shopee] });

    expect(registry.defaultProviderId).toBe("gopay");
    expect(registry.getProvider()).toBe(gopay);

    registry.setDefaultProvider("shopee");
    expect(registry.defaultProviderId).toBe("shopee");
    expect(registry.getProvider()).toBe(shopee);
  });

  it("registers providers fluently and reports canonical summaries", () => {
    const scope = {
      provider: "shopee",
      accountId: "account-1",
      merchantId: "store-1",
    };
    const registry = new MerchantId()
      .register(provider({ id: "gopay" }))
      .register(
        provider({
          id: "shopee",
          authenticated: true,
          staticQris: "synthetic-qris",
          scope,
        }),
      );

    expect(registry.has("gopay")).toBe(true);
    expect(registry.listProviders()).toEqual([
      {
        id: "gopay",
        authenticated: false,
        paymentScope: undefined,
        hasStaticQris: false,
        default: true,
      },
      {
        id: "shopee",
        authenticated: true,
        paymentScope: scope,
        hasStaticQris: true,
        default: false,
      },
    ]);
  });

  it("exports sessions only for authenticated providers", () => {
    const registry = new MerchantId({
      providers: [
        provider({ id: "gopay" }),
        provider({ id: "shopee", authenticated: true }),
      ],
    });

    expect(registry.exportSessions()).toEqual({
      shopee: { marker: "session:shopee" },
    });
  });

  it.each(["", " Shopee", "SHOPEE", "shopee_store", "-shopee"])(
    "rejects invalid provider id %j",
    (id) => {
      expect(() => new MerchantId().register(provider({ id }))).toThrowError(
        ConfigError,
      );
    },
  );

  it("rejects duplicate and unknown provider selections", () => {
    const registry = new MerchantId().register(provider({ id: "gopay" }));

    expect(() => registry.register(provider({ id: "gopay" }))).toThrow(
      /already registered/,
    );
    expect(() => registry.getProvider("shopee")).toThrow(/not registered/);
    expect(() => registry.setDefaultProvider("shopee")).toThrow(/unregistered/);
  });

  it("requires a provider when an empty registry has no default", () => {
    expect(() => new MerchantId().getProvider()).toThrow(
      /providerId is required/,
    );
  });
});
