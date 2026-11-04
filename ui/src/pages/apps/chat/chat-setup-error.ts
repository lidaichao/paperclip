import { l10n } from "../../../i18n";

export const chatSetupErrorFallback =
  l10n("local.chat_setup_error_fallback_10301420");

function uriEncoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    // encodeURIComponent rejects malformed UTF-16 (for example, a lone
    // surrogate). The raw and JSON-escaped forms remain safe to redact.
    return null;
  }
}

export function sanitizedSetupErrorMessage(
  error: unknown,
  submittedValues: Record<string, string> | undefined,
): string {
  let message = error instanceof Error ? error.message.trim() : "";
  if (!message) return chatSetupErrorFallback;

  const submittedSecrets = Object.values(submittedValues ?? {})
    .flatMap((value) => {
      const trimmed = value.trim();
      return trimmed && trimmed !== value ? [value, trimmed] : [value];
    })
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const secret of submittedSecrets) {
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const candidates = new Set<string>([secret, escapedSecret]);
    const encodedSecret = uriEncoded(secret);
    if (encodedSecret) candidates.add(encodedSecret);
    for (const candidate of candidates) {
      message = message.replaceAll(candidate, "[redacted]");
    }
  }

  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : chatSetupErrorFallback;
}
