/**
 * Shared redaction for provider-supplied diagnostic text.
 *
 * Provider error messages are useful for debugging but arrive unvetted, so they
 * are filtered before being attached to an error or a log line. This rule lives
 * in one place on purpose: it previously existed as two near-identical copies
 * that had already drifted — the GoPay copy had lost the credential-keyword
 * check entirely — and a security rule that differs per provider is a rule that
 * will be wrong somewhere.
 *
 * The filter is deliberately blunt: anything long enough to be a token, or that
 * merely mentions a credential, is dropped whole rather than partially masked.
 * A missing reason is safe; a leaked one is not.
 */
const MAX_REASON_LENGTH = 100;

export function safeDiagnosticText(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  // Any long unbroken run is token-shaped; provider prose never looks like this.
  if (/[A-Za-z0-9_-]{24,}/.test(trimmed)) return undefined;
  if (/(token|cookie|otp|password|secret|authorization)/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.length > MAX_REASON_LENGTH
    ? `${trimmed.slice(0, MAX_REASON_LENGTH - 1)}…`
    : trimmed;
}
