import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";

describe("MerchID public API contract", () => {
  it("exports the canonical composition root, providers, errors, and transport", () => {
    expect(api.MerchID).toBeTypeOf("function");
    expect(api.createMerchID).toBeTypeOf("function");
    expect(api.GopayProvider).toBeTypeOf("function");
    expect(api.ShopeeProvider).toBeTypeOf("function");
    expect(api.ShopeeHttpClient).toBeTypeOf("function");
    expect(api.MerchIDError).toBeTypeOf("function");
    expect(api.PaymentService).toBeTypeOf("function");
    expect(api.samePaymentScope).toBeTypeOf("function");
  });

  it.each([
    "IndoPay",
    "createIndoPay",
    "GopayMerchant",
    "ShopeeMerchant",
    "GopayMerchantError",
    "GopayErrorCode",
  ])("does not expose removed facade %s", (name) => {
    expect(name in api).toBe(false);
  });
});
