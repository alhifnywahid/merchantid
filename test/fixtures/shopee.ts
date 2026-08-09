import { SHOPEE_LIVE_TOKEN_COOKIE } from "../../src/providers/shopee/constants.js";
import type {
  ShopeeSession,
  ShopeeStore,
} from "../../src/providers/shopee/types.js";

export const SHOPEE_MERCHANT_ID = "10001";
export const SHOPEE_MERCHANT_TWO_ID = "10002";
export const SHOPEE_STORE_ONE_ID = "20001";
export const SHOPEE_STORE_TWO_ID = "20002";

export const SHOPEE_STORES: readonly ShopeeStore[] = [
  { id: SHOPEE_STORE_ONE_ID, name: "Dev Lab Central", status: 1 },
  { id: SHOPEE_STORE_TWO_ID, name: "Dev Lab North", status: 1 },
];

function merchantJwt(merchantId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      token: "synthetic-shopee-token",
      userid: "90001",
      businessId: merchantId,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

/** Restorable Shopee session made only from deterministic placeholder data. */
export function syntheticShopeeSession(
  storeId = SHOPEE_STORE_ONE_ID,
): ShopeeSession {
  const merchant = {
    id: SHOPEE_MERCHANT_ID,
    name: "MerchID Dev Merchant",
    status: 1,
    staffUserId: 90001,
    staffRole: 1,
    staffStatus: 1,
    isActive: true,
    isBanned: false,
    isCurrentLoginUser: true,
  };
  return {
    version: 1,
    cookies: [
      {
        name: SHOPEE_LIVE_TOKEN_COOKIE,
        value: merchantJwt(SHOPEE_MERCHANT_ID),
        domain: "partner.shopee.co.id",
        path: "/",
        hostOnly: true,
        secure: true,
        httpOnly: true,
        expiresAt: Date.now() + 3_600_000,
      },
    ],
    accountId: "90001",
    merchant: { ...merchant },
    merchants: [
      { ...merchant },
      {
        id: SHOPEE_MERCHANT_TWO_ID,
        name: "MerchID Dev Merchant North",
        status: 1,
        staffUserId: 90002,
        staffRole: 2,
        staffStatus: 1,
        isActive: true,
        isBanned: false,
        isCurrentLoginUser: false,
      },
    ],
    switchCredential: {
      tocNonce: "synthetic-toc-nonce",
      spcClientId: "synthetic-spc-clientid",
      deviceFingerprint: "synthetic-device-fingerprint",
    },
    stores: SHOPEE_STORES.map((store) => ({ ...store })),
    storeId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
}

export function syntheticShopeeTransaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    transactionId: "tx-shopee-1",
    externalTransactionId: "order-shopee-1",
    createTime: Math.floor(Date.now() / 1_000),
    storeId: Number(SHOPEE_STORE_ONE_ID),
    merchantId: Number(SHOPEE_MERCHANT_ID),
    service: 3,
    amount: "10.001",
    status: 3,
    ...overrides,
  };
}
