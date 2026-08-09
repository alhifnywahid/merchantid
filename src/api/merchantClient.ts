import type { HttpClient } from "../http/httpClient.js";
import { ENDPOINTS } from "../core/constants.js";
import type {
  MerchantOutlet,
  MerchantProfile,
  StoredMerchant,
} from "../core/types.js";

interface GopayPopPayload {
  status?: string;
  gopay_receiver_id?: string;
  gopay_qr_string?: string;
  aspi_qr_string?: string;
  [key: string]: unknown;
}

interface PopPayload {
  pop_id?: string;
  name?: string;
  status?: string;
  gopay?: GopayPopPayload;
  [key: string]: unknown;
}

interface MerchantDetailPayload {
  id: string;
  merchant_name?: string;
  outlet_name?: string;
  phone?: string;
  email?: string;
  server_key?: string;
  client_key?: string;
  timezone?: string;
  business_type?: string;
  merchant_type?: string;
  service_area?: string;
  pops?: PopPayload[];
  [key: string]: unknown;
}

interface MerchantSearchPayload {
  total?: number;
  success?: boolean;
  hits?: MerchantDetailPayload[];
}

/** Fields requested from the merchant search index (mirrors the dashboard). */
const MERCHANT_SEARCH_SOURCE = [
  "id",
  "director_name",
  "merchant_name",
  "email",
  "feature_types",
  "phone",
  "outlet_address",
  "outlet_name",
  "outlet_city",
  "payment_settings.GOPAY",
  "tags",
  "bank_account",
  "applications",
  "pops",
  "aspi",
  "business_type",
  "metadata",
  "id_type",
  "merchant_type",
  "service_area",
] as const;

interface CurrentUserPayload {
  id?: number;
  email?: string;
  full_name?: string;
  phone?: string;
  merchant_id?: string;
  roles?: string[];
  [key: string]: unknown;
}

/** Normalized authenticated user, including the resolved merchant id. */
export interface CurrentUser {
  id?: number;
  merchantId?: string;
  email?: string;
  fullName?: string;
  phone?: string;
  roles: string[];
  raw: unknown;
}

/** Read access to merchant profile and account context. */
export class MerchantClient {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  /** Fetch and normalize the authenticated user (`/v1/users/me`). */
  async getCurrentUser(): Promise<CurrentUser> {
    const raw = await this.http.requestJson<{ user?: CurrentUserPayload }>({
      method: "GET",
      path: ENDPOINTS.usersMe,
    });

    const user = raw.user ?? ({} as CurrentUserPayload);
    return {
      id: user.id,
      merchantId: user.merchant_id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      roles: user.roles ?? [],
      raw,
    };
  }

  /** Fetch and normalize a merchant profile by id, including outlet QRIS. */
  async getMerchant(merchantId: string): Promise<MerchantProfile> {
    const raw = await this.http.requestJson<MerchantDetailPayload>({
      method: "GET",
      path: ENDPOINTS.merchantDetail(merchantId),
    });

    const outlets: MerchantOutlet[] = (raw.pops ?? []).map((pop) => ({
      popId: pop.pop_id ?? "",
      name: pop.name,
      status: pop.status,
      receiverId: pop.gopay?.gopay_receiver_id,
      qrString: pop.gopay?.aspi_qr_string,
      raw: pop,
    }));

    return {
      id: raw.id,
      merchantName: raw.merchant_name ?? "",
      outletName: raw.outlet_name,
      phone: raw.phone,
      email: raw.email,
      serverKey: raw.server_key,
      clientKey: raw.client_key,
      timezone: raw.timezone,
      outlets,
      raw,
    };
  }

  /**
   * Enumerate every merchant the account can access, with full detail and
   * outlet QRIS, via `/v1/merchants/search`. Returns one {@link StoredMerchant}
   * per merchant. This is the source of truth for multi-merchant accounts.
   */
  async searchMerchants(limit = 200): Promise<StoredMerchant[]> {
    const raw = await this.http.requestJson<MerchantSearchPayload>({
      method: "POST",
      path: ENDPOINTS.merchantsSearch,
      body: {
        from: 0,
        size: limit,
        _source: MERCHANT_SEARCH_SOURCE,
      },
    });

    return (raw.hits ?? []).map(normalizeStoredMerchant);
  }
}

function normalizeStoredMerchant(hit: MerchantDetailPayload): StoredMerchant {
  const outlets: MerchantOutlet[] = (hit.pops ?? []).map((pop) => ({
    popId: pop.pop_id ?? "",
    name: pop.name,
    status: pop.status,
    receiverId: pop.gopay?.gopay_receiver_id,
    qrString: pop.gopay?.aspi_qr_string,
    raw: pop,
  }));

  const primaryQris = outlets.find((o) => Boolean(o.qrString))?.qrString;

  return {
    id: hit.id,
    merchantName: hit.merchant_name ?? "",
    outletName: hit.outlet_name,
    phone: hit.phone,
    email: hit.email,
    businessType: hit.business_type,
    merchantType: hit.merchant_type,
    serviceArea: hit.service_area,
    outlets,
    qrString: primaryQris,
    raw: hit,
  };
}
