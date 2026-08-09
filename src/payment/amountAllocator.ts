import { DEFAULT_MAX_UNIQUE_OFFSET } from "../core/constants.js";
import { MerchantIdError } from "../core/errors.js";

/**
 * Allocates a unique whole-rupiah offset so that concurrent orders can be told
 * apart purely by the amount that lands in the merchant account.
 *
 * Uniqueness is enforced on the resulting amount (`baseAmount + offset`), not on
 * the offset alone. Scoping it per base amount is not enough: with a 999-wide
 * offset window, base amounts that differ by less than that can produce the
 * same final amount. `3500 + 1` and `3499 + 2` both settle at `3501`, and since
 * the amount is the only discriminator the poller has, a single transaction
 * would be attributed to whichever order it happened to compare first.
 *
 * Offsets are released once the occupying payment leaves the active set (paid,
 * expired, or cancelled), and the smallest free slot is always chosen first.
 */
export class AmountAllocator {
  private readonly maxOffset: number;

  constructor(maxOffset: number = DEFAULT_MAX_UNIQUE_OFFSET) {
    if (!Number.isInteger(maxOffset) || maxOffset < 1) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "maxOffset must be a positive integer",
      );
    }
    this.maxOffset = maxOffset;
  }

  /** The largest offset this allocator will hand out. */
  get max(): number {
    return this.maxOffset;
  }

  /**
   * Find the smallest offset in [1, maxOffset] whose resulting amount
   * (`baseAmount + offset`) is not already claimed by an active payment.
   *
   * @param baseAmount The nominal the merchant asked for, in whole rupiah.
   * @param takenAmounts Unique amounts currently held by active payments. Values
   * outside this base amount's reachable range are ignored, so callers can pass
   * the whole active set without filtering.
   * @throws MerchantIdError with code AMOUNT_POOL_EXHAUSTED when every slot
   * in range is claimed.
   */
  allocate(baseAmount: number, takenAmounts: Iterable<number>): number {
    const taken = new Set<number>(takenAmounts);

    for (let offset = 1; offset <= this.maxOffset; offset++) {
      if (!taken.has(baseAmount + offset)) {
        return offset;
      }
    }

    throw new MerchantIdError(
      "AMOUNT_POOL_EXHAUSTED",
      `No free unique amount slot available for base amount ${baseAmount} ` +
        `(offset window 1..${this.maxOffset} is fully claimed)`,
    );
  }
}
