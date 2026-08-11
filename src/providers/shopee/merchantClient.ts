import { ApiError } from "../../core/errors.js";
import {
  partnerHeaders,
  paymentHeaders,
  paymentMetadata,
  requirePartnerData,
  requirePaymentData,
} from "./api.js";
import type {
  ShopeeApiLocale,
  ShopeePartnerEnvelope,
  ShopeePaymentEnvelope,
} from "./api.js";
import {
  SHOPEE_ENDPOINTS,
  SHOPEE_PARTNER_API_BASE_URL,
  SHOPEE_PAY_BASE_URL,
  SHOPEE_STORE_PAGE_SIZE,
  SHOPEE_STORE_SERVICES,
} from "./constants.js";
import type { ShopeeHttpClient } from "./httpClient.js";
import { shopeeUrl } from "./httpClient.js";
import type { ShopeeMerchantProfile, ShopeeStore } from "./types.js";

interface RawUserInfo {
  merchantId?: number;
  merchantName?: string;
  store_id?: number;
  tobUserId?: number;
  tocUid?: number;
  userName?: string;
  tocUserName?: string;
  language?: string;
  shopeepay_service_status?: number;
  [key: string]: unknown;
}

interface RawStore {
  storeId?: number;
  storeName?: string;
  status?: number;
}

interface StoreListData {
  list?: RawStore[];
  storeCount?: number;
}

export interface ShopeeMerchantClientOptions {
  token: string;
  merchantId: string;
  locale?: ShopeeApiLocale;
}

/** Merchant profile and full store discovery for an authenticated session. */
export class ShopeeMerchantClient {
  private readonly http: ShopeeHttpClient;
  private readonly token: string;
  private readonly merchantId: string;
  private readonly locale: ShopeeApiLocale;

  constructor(http: ShopeeHttpClient, options: ShopeeMerchantClientOptions) {
    this.http = http;
    this.token = options.token;
    this.merchantId = options.merchantId;
    this.locale = options.locale ?? {};
  }

  async getProfile(): Promise<ShopeeMerchantProfile> {
    const response = await this.http.requestJson<
      ShopeePartnerEnvelope<RawUserInfo>
    >({
      method: "POST",
      url: shopeeUrl(SHOPEE_PARTNER_API_BASE_URL, SHOPEE_ENDPOINTS.userInfo),
      headers: partnerHeaders({ token: this.token, locale: this.locale }),
      body: {},
    });
    const raw = requirePartnerData(response, SHOPEE_ENDPOINTS.userInfo);
    const merchantId = toId(raw.merchantId);
    if (!merchantId || merchantId !== this.merchantId) {
      throw new ApiError("Shopee returned a profile for a different merchant", {
        details: { provider: "shopee", endpoint: SHOPEE_ENDPOINTS.userInfo },
      });
    }

    return {
      merchantId,
      merchantName: raw.merchantName ?? "",
      storeId: toId(raw.store_id),
      accountId: toId(raw.tocUid) ?? "",
      userId: toId(raw.tobUserId) ?? "",
      userName: raw.userName ?? raw.tocUserName ?? "",
      language: raw.language ?? "",
      shopeePayServiceStatus:
        typeof raw.shopeepay_service_status === "number"
          ? raw.shopeepay_service_status
          : 0,
      raw,
    };
  }

  /**
   * Every store the active merchant owns.
   *
   * The dashboard's store page filters by `serviceList` (`SHOPEE_STORE_SERVICES`)
   * and that filter is mirrored here, but some merchants own stores that carry
   * neither service and are then omitted entirely - the merchant looks store-less
   * and no payment scope can be selected. When the filtered query finds nothing,
   * repeat it unfiltered so those stores are still discovered. Merchants whose
   * stores do match keep the exact filtered result the browser sees.
   */
  async listStores(maxPages = 100): Promise<ShopeeStore[]> {
    const filtered = await this.fetchStores(maxPages, [
      ...SHOPEE_STORE_SERVICES,
    ]);
    if (filtered.length > 0) return filtered;
    return this.fetchStores(maxPages, undefined);
  }

  private async fetchStores(
    maxPages: number,
    serviceList: number[] | undefined,
  ): Promise<ShopeeStore[]> {
    const pages = Math.max(1, Math.floor(maxPages));
    const stores = new Map<string, ShopeeStore>();
    const seenStoreCursors = new Set<number>([0]);
    let lastStoreId = 0;

    for (let page = 0; page < pages; page++) {
      const response = await this.http.requestJson<
        ShopeePaymentEnvelope<StoreListData>
      >({
        method: "POST",
        url: shopeeUrl(SHOPEE_PAY_BASE_URL, SHOPEE_ENDPOINTS.stores),
        headers: paymentHeaders(),
        body: {
          data: {
            metadata: paymentMetadata(this.token, this.locale),
            storeName: "",
            lastStoreId,
            pageSize: SHOPEE_STORE_PAGE_SIZE,
            // Omitted entirely (not an empty array) on the unfiltered retry, so
            // the service filter is absent rather than empty.
            ...(serviceList ? { serviceList } : {}),
          },
        },
      });
      const data = requirePaymentData(response, SHOPEE_ENDPOINTS.stores);
      const rawBatch = data.list ?? [];
      const batch = rawBatch
        .map(normalizeStore)
        .filter((store): store is ShopeeStore => store !== undefined);
      for (const store of batch) stores.set(store.id, store);

      const total =
        typeof data.storeCount === "number" && data.storeCount >= 0
          ? data.storeCount
          : undefined;
      if (
        rawBatch.length === 0 ||
        rawBatch.length < SHOPEE_STORE_PAGE_SIZE ||
        (total !== undefined && stores.size >= total)
      ) {
        return [...stores.values()];
      }

      const nextStoreId = Number(toId(rawBatch[rawBatch.length - 1]?.storeId));
      if (
        !Number.isSafeInteger(nextStoreId) ||
        seenStoreCursors.has(nextStoreId)
      ) {
        throw new ApiError("Shopee store cursor did not advance", {
          details: { provider: "shopee", endpoint: SHOPEE_ENDPOINTS.stores },
        });
      }
      seenStoreCursors.add(nextStoreId);
      lastStoreId = nextStoreId;
    }

    throw new ApiError("Shopee store pagination limit was reached", {
      details: {
        provider: "shopee",
        endpoint: SHOPEE_ENDPOINTS.stores,
        pages,
      },
    });
  }
}

function toId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value) return value;
  return undefined;
}

function normalizeStore(raw: RawStore): ShopeeStore | undefined {
  const id = toId(raw.storeId);
  if (!id) return undefined;
  return {
    id,
    name: raw.storeName ?? "",
    status: typeof raw.status === "number" ? raw.status : 0,
  };
}
