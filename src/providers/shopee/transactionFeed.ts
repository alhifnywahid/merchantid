import { ApiError, ConfigError } from "../../core/errors.js";
import type {
  TransactionFeed,
  TransactionFeedQuery,
  TransactionFeedResult,
} from "../../core/provider.js";
import type { MerchantTransaction } from "../../core/types.js";
import type { Logger } from "../../utils/logger.js";
import { noopLogger } from "../../utils/logger.js";
import { paymentHeaders, paymentMetadata, requirePaymentData } from "./api.js";
import type { ShopeeApiLocale, ShopeePaymentEnvelope } from "./api.js";
import {
  SHOPEE_COMPLETED_TRANSACTION_STATUS,
  SHOPEE_ENDPOINTS,
  SHOPEE_PAY_BASE_URL,
  SHOPEE_PROVIDER_ID,
  SHOPEE_TRANSACTION_PAGE_SIZE,
  SHOPEE_TRANSACTION_SERVICES,
} from "./constants.js";
import type { ShopeeHttpClient } from "./httpClient.js";
import { shopeeUrl } from "./httpClient.js";

interface RawShopeeTransaction {
  transactionId?: string;
  externalTransactionId?: string;
  displayTransactionId?: string;
  createTime?: number;
  storeId?: number;
  service?: number;
  amount?: string;
  status?: number;
  transactionType?: number;
  merchantId?: number;
  [key: string]: unknown;
}

interface TransactionListData {
  list?: RawShopeeTransaction[];
  next_position?: string;
}

export interface ShopeeTransactionFeedOptions {
  token: string;
  merchantId: string;
  storeId: string;
  locale?: ShopeeApiLocale;
  logger?: Logger;
}

/**
 * Parse Shopee's Indonesian grouped integer format into whole rupiah.
 *
 * Returns `undefined` for anything it cannot parse, including non-string input:
 * this is part of the public API and is fed straight from provider JSON, where
 * a field's type is a promise the provider can break at any time. Throwing a
 * `TypeError` there would turn a malformed row into a crashed poll.
 */
export function parseShopeeAmount(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) && !/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    return undefined;
  }
  const amount = Number(normalized.replace(/\./g, ""));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

/** Cursor-owned ShopeePay feed normalized to the provider-neutral transaction port. */
export class ShopeeTransactionFeed implements TransactionFeed {
  private readonly http: ShopeeHttpClient;
  private readonly token: string;
  private readonly merchantId: string;
  private readonly storeId: string;
  private readonly locale: ShopeeApiLocale;
  private readonly logger: Logger;

  constructor(http: ShopeeHttpClient, options: ShopeeTransactionFeedOptions) {
    this.http = http;
    this.token = options.token;
    this.merchantId = options.merchantId;
    this.storeId = options.storeId;
    this.locale = options.locale ?? {};
    this.logger = options.logger ?? noopLogger;
  }

  async listRecent(
    query: TransactionFeedQuery,
  ): Promise<TransactionFeedResult> {
    this.validateScope(query);
    const pageSize = Math.min(
      SHOPEE_TRANSACTION_PAGE_SIZE,
      Math.max(1, Math.floor(query.pageSize)),
    );
    const maxPages = Math.max(1, Math.floor(query.maxPages));
    const transactions: MerchantTransaction[] = [];
    const transactionIds = new Set<string>();
    const cursors = new Set<string>();
    let nextPosition = "";
    let pagesFetched = 0;

    for (let page = 0; page < maxPages; page++) {
      const response = await this.http.requestJson<
        ShopeePaymentEnvelope<TransactionListData>
      >({
        method: "POST",
        url: shopeeUrl(SHOPEE_PAY_BASE_URL, SHOPEE_ENDPOINTS.transactions),
        headers: paymentHeaders(),
        body: {
          data: {
            metadata: paymentMetadata(this.token, this.locale),
            pageSize,
            filter: {
              startTime: Math.floor(query.startTime.getTime() / 1_000),
              endTime: Math.floor(query.endTime.getTime() / 1_000),
              serviceList: [...SHOPEE_TRANSACTION_SERVICES],
            },
            sorter: { field: "createTime", order: "descend" },
            next_position: nextPosition,
          },
        },
      });
      pagesFetched++;
      const data = requirePaymentData(response, SHOPEE_ENDPOINTS.transactions);
      let rejected = 0;
      for (const raw of data.list ?? []) {
        const transaction = this.normalize(raw);
        if (!transaction) {
          rejected++;
          continue;
        }
        if (!transactionIds.has(transaction.id)) {
          transactionIds.add(transaction.id);
          transactions.push(transaction);
        }
      }
      if (rejected > 0) {
        this.logger.warn(
          "ignored malformed or out-of-scope Shopee transactions",
          {
            count: rejected,
            provider: SHOPEE_PROVIDER_ID,
          },
        );
      }

      const cursor = data.next_position ?? "";
      if (!cursor) {
        return { transactions, pagesFetched, truncated: false };
      }
      if (cursor === nextPosition || cursors.has(cursor)) {
        throw new ApiError("Shopee transaction cursor did not advance", {
          details: {
            provider: SHOPEE_PROVIDER_ID,
            endpoint: SHOPEE_ENDPOINTS.transactions,
          },
        });
      }
      cursors.add(cursor);
      nextPosition = cursor;
    }

    return {
      transactions,
      pagesFetched,
      truncated: nextPosition.length > 0,
    };
  }

  private validateScope(query: TransactionFeedQuery): void {
    if (
      query.scope.provider !== SHOPEE_PROVIDER_ID ||
      query.scope.merchantId !== this.storeId ||
      query.scope.accountId !== this.merchantId
    ) {
      throw new ConfigError(
        "Shopee transaction query scope does not match the session",
      );
    }
    if (
      !Number.isFinite(query.startTime.getTime()) ||
      !Number.isFinite(query.endTime.getTime()) ||
      query.startTime > query.endTime
    ) {
      throw new ConfigError("Shopee transaction time range is invalid");
    }
  }

  private normalize(
    raw: RawShopeeTransaction,
  ): MerchantTransaction | undefined {
    const id = raw.transactionId?.trim();
    const amount =
      typeof raw.amount === "string"
        ? parseShopeeAmount(raw.amount)
        : undefined;
    const time =
      typeof raw.createTime === "number" && Number.isFinite(raw.createTime)
        ? new Date(raw.createTime * 1_000)
        : undefined;
    if (
      !id ||
      amount === undefined ||
      !time ||
      Number.isNaN(time.getTime()) ||
      String(raw.merchantId) !== this.merchantId ||
      String(raw.storeId) !== this.storeId
    ) {
      return undefined;
    }

    const completed = raw.status === SHOPEE_COMPLETED_TRANSACTION_STATUS;
    return {
      id,
      orderId:
        raw.externalTransactionId ??
        raw.displayTransactionId ??
        raw.transactionId ??
        id,
      merchantId: this.merchantId,
      status: completed ? "completed" : `shopee:${String(raw.status)}`,
      paymentType: `shopee:${String(raw.service ?? raw.transactionType ?? "unknown")}`,
      grossAmount: amount,
      currency: "IDR",
      transactionTime: time.toISOString(),
      settlementTime: completed ? time.toISOString() : undefined,
      transactionSource: SHOPEE_PROVIDER_ID,
      raw,
    };
  }
}
