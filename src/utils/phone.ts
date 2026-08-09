/**
 * Indonesian mobile number parsing shared by every provider.
 *
 * Users type a single phone field however they like: `62...`, `+62...`,
 * `08...`, or a bare `8...`, with spaces, dashes, dots, or parentheses. This
 * helper accepts all of those, validates that the result is a plausible
 * Indonesian mobile number, and returns every canonical form so each provider
 * can send the exact shape its API expects (GoPay wants the subscriber number
 * plus a separate country code; Shopee wants the combined `62...` form).
 */

import { ConfigError } from "../core/errors.js";

export const INDONESIA_COUNTRY_CODE = "62";

/**
 * Length of the subscriber part (the digits after the trunk `0` / country
 * code, always starting with `8`). Indonesian mobile numbers run roughly 10-13
 * digits in national form including the leading `0`, which is 9-12 for the
 * subscriber; the bounds are widened by one to stay inclusive of every
 * operator's range rather than rejecting a real customer.
 */
const MIN_SUBSCRIBER_DIGITS = 9;
const MAX_SUBSCRIBER_DIGITS = 13;

const INVALID_MESSAGE = "Enter a valid Indonesian mobile number";

interface IndonesianMobileNumber {
  /** Country calling code. Always "62" for Indonesia. */
  countryCode: string;
  /** Subscriber number starting with 8, without a trunk 0 or country code. */
  subscriber: string;
  /** National form with a single leading 0, e.g. "0812xxxxxxx". */
  national: string;
  /** International form without a plus, e.g. "62812xxxxxxx". */
  e164: string;
}

/**
 * Parse and validate an Indonesian mobile number from free-form user input.
 * Throws {@link ConfigError} when the value cannot be a valid Indonesian
 * mobile number. The error message never prescribes a format, so callers can
 * surface it directly without telling the user how to prefix their number.
 */
export function parseIndonesianMobile(input: string): IndonesianMobileNumber {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ConfigError(INVALID_MESSAGE);
  }

  let digits = input.replace(/\D+/g, "");
  if (!digits) {
    throw new ConfigError(INVALID_MESSAGE);
  }

  // Peel an international access code, then the country code, then any trunk
  // zero, in the order they can legally stack (e.g. "00 62 0 812...").
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(INDONESIA_COUNTRY_CODE)) {
    digits = digits.slice(INDONESIA_COUNTRY_CODE.length);
  }
  digits = digits.replace(/^0+/, "");

  // Indonesian mobile subscriber numbers always start with 8; anything else is
  // a landline or a foreign number that cannot receive an SMS OTP here.
  if (
    !digits.startsWith("8") ||
    digits.length < MIN_SUBSCRIBER_DIGITS ||
    digits.length > MAX_SUBSCRIBER_DIGITS
  ) {
    throw new ConfigError(INVALID_MESSAGE);
  }

  return {
    countryCode: INDONESIA_COUNTRY_CODE,
    subscriber: digits,
    national: `0${digits}`,
    e164: `${INDONESIA_COUNTRY_CODE}${digits}`,
  };
}
