import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getConsoleRuntime, runConsoleAction } from "./console.server";

const providerId = z.enum(["gopay", "shopee"]);

export const getConsoleSnapshot = createServerFn({ method: "GET" }).handler(
  async () => (await getConsoleRuntime()).snapshot(),
);

export const setActiveProvider = createServerFn({ method: "POST" })
  .validator(z.object({ providerId }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.setActiveProvider(data.providerId)),
  );

export const requestProviderOtp = createServerFn({ method: "POST" })
  .validator(
    z.object({
      providerId,
      phoneNumber: z.string().trim().min(8).max(24),
      countryCode: z.string().trim().min(1).max(4).optional(),
      channel: z.number().int().min(1).max(5).optional(),
      password: z.string().min(6).max(128).optional(),
    }),
  )
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.requestOtp(data)),
  );

export const verifyProviderOtp = createServerFn({ method: "POST" })
  .validator(z.object({ providerId, otp: z.string().trim().min(4).max(12) }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.verifyOtp(data)),
  );

export const completeShopeeLogin = createServerFn({ method: "POST" })
  .validator(
    z.object({
      merchantId: z.string().trim().min(1),
      storeId: z.string().trim().min(1).optional(),
    }),
  )
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.completeShopeeLogin(data)),
  );

export const refreshDiscovery = createServerFn({ method: "POST" })
  .validator(z.object({ providerId }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.refreshDiscovery(data.providerId)),
  );

export const selectGopayMerchant = createServerFn({ method: "POST" })
  .validator(z.object({ merchantId: z.string().trim().min(1) }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.selectGopayMerchant(data.merchantId)),
  );

export const selectShopeeStore = createServerFn({ method: "POST" })
  .validator(z.object({ storeId: z.string().trim().min(1) }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.selectShopeeStore(data.storeId)),
  );

export const switchShopeeMerchant = createServerFn({ method: "POST" })
  .validator(z.object({ merchantId: z.string().trim().min(1) }))
  .handler(({ data }) =>
    runConsoleAction((runtime) =>
      runtime.switchShopeeMerchant(data.merchantId),
    ),
  );

export const saveStaticQris = createServerFn({ method: "POST" })
  .validator(
    z.object({ providerId, payload: z.string().trim().min(16).max(8_192) }),
  )
  .handler(({ data }) =>
    runConsoleAction((runtime) =>
      runtime.setStaticQris(data.providerId, data.payload),
    ),
  );

export const createConsolePayment = createServerFn({ method: "POST" })
  .validator(
    z.object({
      providerId,
      amount: z.number().int().positive().max(999_999_999),
      reference: z.string().trim().max(120).optional(),
      expiresInMinutes: z.number().int().min(1).max(1_440).optional(),
    }),
  )
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.createPayment(data)),
  );

export const cancelConsolePayment = createServerFn({ method: "POST" })
  .validator(z.object({ paymentId: z.string().trim().min(1) }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.cancelPayment(data.paymentId)),
  );

export const reconcileProvider = createServerFn({ method: "POST" })
  .validator(z.object({ providerId }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.reconcile(data.providerId)),
  );

export const refreshProviderSession = createServerFn({ method: "POST" })
  .validator(z.object({ providerId }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.refreshSession(data.providerId)),
  );

export const logoutProvider = createServerFn({ method: "POST" })
  .validator(z.object({ providerId }))
  .handler(({ data }) =>
    runConsoleAction((runtime) => runtime.logout(data.providerId)),
  );

export const clearConsoleActivity = createServerFn({ method: "POST" }).handler(
  () => runConsoleAction((runtime) => runtime.clearActivity()),
);
