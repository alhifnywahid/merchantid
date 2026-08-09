import type { HttpClient } from "../http/httpClient.js";
import {
  DEFAULT_PAYMENT_TYPES,
  ENDPOINTS,
  GOJEK_API_BASE_URL,
  MAX_TRANSACTION_PAGE_SIZE,
  PAID_TRANSACTION_STATUSES,
  TRANSACTION_AMOUNT_SCALE,
} from "../core/constants.js";
import { toIsoUtc } from "../utils/time.js";
import type {
  MerchantTransaction,
  TransactionLister,
  TransactionQuery,
} from "../core/types.js";

interface RawTransaction {
  id: string;
  order_id: string;
  merchant_id: string;
  transaction_status: string;
  payment_type: string;
  gross_amount: number;
  real_gross_amount?: number;
  currency?: string;
  transaction_time: string;
  settlement_time?: string;
  transaction_source?: string;
  [key: string]: unknown;
}

interface TransactionListPayload {
  from: number;
  size: number;
  total: number;
  transactions?: RawTransaction[];
}

/**
 * Reads settled/authorized transactions from the merchant analytics API. This
 * is the signal source the gateway polls to detect incoming QRIS payments.
 */
export class TransactionClient implements TransactionLister {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async list(
    merchantId: string,
    query: TransactionQuery,
  ): Promise<MerchantTransaction[]> {
    // Undefined -> sensible defaults; an explicit empty array -> omit the
    // filter entirely (fetch all), letting the caller match client-side.
    const statuses = query.statuses ?? PAID_TRANSACTION_STATUSES;
    const paymentTypes = query.paymentTypes ?? DEFAULT_PAYMENT_TYPES;

    const params: Record<string, string | number> = {
      from: query.from ?? 0,
      // Clamped: the feed answers 422 for a larger page, which would fail the
      // entire poll. Returning fewer transactions is the graceful degradation.
      size: Math.min(query.size ?? 20, MAX_TRANSACTION_PAGE_SIZE),
      start_time: toIsoUtc(query.startTime),
      end_time: toIsoUtc(query.endTime),
      merchant_ids: merchantId,
    };
    if (statuses.length > 0) params.statuses = statuses.join(",");
    if (paymentTypes.length > 0) params.payment_types = paymentTypes.join(",");

    const payload = await this.http.requestJson<TransactionListPayload>({
      method: "GET",
      baseUrl: GOJEK_API_BASE_URL,
      path: ENDPOINTS.transactions,
      query: params,
    });

    return (payload.transactions ?? []).map(normalizeTransaction);
  }
}

/**
 * Convert a feed amount from minor units to whole rupiah.
 *
 * The feed sends `300100` for Rp 3.001. Division is exact rather than rounded:
 * a value that is not a whole rupiah stays fractional and therefore simply
 * fails to match a whole-rupiah payment intent, which is the safe outcome.
 */
function toWholeRupiah(minorUnits: number | undefined): number | undefined {
  if (typeof minorUnits !== "number" || Number.isNaN(minorUnits)) {
    return undefined;
  }
  return minorUnits / TRANSACTION_AMOUNT_SCALE;
}

function normalizeTransaction(raw: RawTransaction): MerchantTransaction {
  return {
    id: raw.id,
    orderId: raw.order_id,
    merchantId: raw.merchant_id,
    status: raw.transaction_status,
    paymentType: raw.payment_type,
    // The feed reports minor units; the rest of the library uses whole rupiah.
    grossAmount: toWholeRupiah(raw.gross_amount) ?? 0,
    realGrossAmount: toWholeRupiah(raw.real_gross_amount),
    currency: raw.currency ?? "IDR",
    transactionTime: raw.transaction_time,
    settlementTime: raw.settlement_time,
    transactionSource: raw.transaction_source,
    // Untouched, so callers can still read the original minor-unit values.
    raw,
  };
}
