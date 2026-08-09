import type { MerchantTransaction, Payment } from "../core/types.js";

/**
 * Determines whether a transaction settles a given pending payment.
 *
 * Matching rules:
 * - The transaction gross amount must equal the payment's unique amount.
 * - The transaction time must fall within the payment's validity window
 *   (created .. expires), with a small tolerance for clock skew.
 *
 * The amount is the primary discriminator; uniqueness of amounts across active
 * payments is guaranteed by the allocator, so an exact amount match within the
 * window unambiguously identifies the payer.
 */
/** Success-like transaction statuses (compared case-insensitively). */
const SETTLED_STATUSES = new Set([
  "settlement",
  "capture",
  "success",
  "paid",
  "settled",
  "completed",
]);

export function matchesPayment(
  payment: Payment,
  transaction: MerchantTransaction,
  clockSkewMs = 60_000,
): boolean {
  // The paid amount may be reported in gross or real_gross depending on the
  // feed; accept either.
  const amountMatches =
    transaction.grossAmount === payment.uniqueAmount ||
    transaction.realGrossAmount === payment.uniqueAmount;
  if (!amountMatches) {
    return false;
  }

  // Only settle on success-like statuses so pending/failed transactions that
  // happen to carry the same amount never settle a payment. Unknown/empty
  // statuses are treated as success (fail-open) to tolerate feed variations.
  const status = (transaction.status ?? "").trim().toLowerCase();
  if (status && !SETTLED_STATUSES.has(status)) {
    return false;
  }

  const txTime = Date.parse(transaction.transactionTime);
  if (Number.isNaN(txTime)) {
    // Cannot verify timing; fall back to amount + status match only.
    return true;
  }

  const windowStart = payment.createdAt - clockSkewMs;
  const windowEnd = payment.expiresAt + clockSkewMs;
  return txTime >= windowStart && txTime <= windowEnd;
}

/**
 * Given a list of pending payments and freshly fetched transactions, return the
 * pairs that match. Each transaction is consumed by at most one payment to
 * avoid double-settling when amounts happen to repeat outside their windows.
 */
export function reconcile(
  pending: readonly Payment[],
  transactions: readonly MerchantTransaction[],
  clockSkewMs = 60_000,
): Array<{ payment: Payment; transaction: MerchantTransaction }> {
  const matches: Array<{ payment: Payment; transaction: MerchantTransaction }> =
    [];
  const consumed = new Set<string>();

  // Prefer the smallest unique amount first for deterministic assignment.
  const ordered = [...pending].sort((a, b) => a.uniqueAmount - b.uniqueAmount);

  for (const payment of ordered) {
    for (const transaction of transactions) {
      if (consumed.has(transaction.id)) continue;
      if (matchesPayment(payment, transaction, clockSkewMs)) {
        matches.push({ payment, transaction });
        consumed.add(transaction.id);
        break;
      }
    }
  }

  return matches;
}
