/**
 * Typed error hierarchy for MerchantId. Every failure surfaced to callers is an
 * instance of {@link MerchantIdError}, which keeps error handling predictable.
 */

export type MerchantIdErrorCode =
  | "CONFIG_INVALID"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "CAPTCHA_REQUIRED"
  | "HTTP_ERROR"
  | "API_ERROR"
  | "AMOUNT_POOL_EXHAUSTED"
  | "QRIS_PARSE_ERROR";

export class MerchantIdError extends Error {
  public readonly code: MerchantIdErrorCode;
  public override readonly cause?: unknown;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: MerchantIdErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "MerchantIdError";
    this.code = code;
    this.cause = options.cause;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends MerchantIdError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_INVALID", message, { details });
    this.name = "ConfigError";
  }
}

export class AuthError extends MerchantIdError {
  constructor(
    code: Extract<MerchantIdErrorCode, "AUTH_REQUIRED" | "AUTH_FAILED">,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, options);
    this.name = "AuthError";
  }
}

/** Authentication cannot continue until the caller completes a CAPTCHA. */
export class CaptchaRequiredError extends MerchantIdError {
  constructor(
    message = "CAPTCHA is required to continue authentication",
    details?: Record<string, unknown>,
  ) {
    super("CAPTCHA_REQUIRED", message, { details });
    this.name = "CaptchaRequiredError";
  }
}

export class HttpError extends MerchantIdError {
  public readonly status: number;
  /**
   * The parsed (or raw) response body, for callers that need to inspect a
   * provider failure. Deliberately **non-enumerable**: `util.inspect` — which
   * is what `console.error(err)` uses — prints an error's own enumerable
   * properties, so an enumerable body would dump the provider's entire
   * response, credentials included, into the caller's logs the moment anyone
   * logged the error. Reading `error.body` still works exactly as before.
   */
  public readonly body: unknown;

  constructor(
    status: number,
    message: string,
    body: unknown,
    details?: Record<string, unknown>,
  ) {
    super("HTTP_ERROR", message, { details });
    this.name = "HttpError";
    this.status = status;
    Object.defineProperty(this, "body", {
      value: body,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
}

export class ApiError extends MerchantIdError {
  public readonly apiCode?: string;

  constructor(
    message: string,
    options: {
      apiCode?: string;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super("API_ERROR", message, {
      cause: options.cause,
      details: options.details,
    });
    this.name = "ApiError";
    this.apiCode = options.apiCode;
  }
}
