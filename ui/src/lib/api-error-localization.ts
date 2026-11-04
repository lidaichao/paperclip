import { l10n } from "../i18n";

const AUTH_ERRORS = new Set([
  "unauthorized",
  "Bearer token is required",
  "Tool gateway session token is required",
]);

const NOT_FOUND_ERRORS = new Set([
  "API route not found",
  "Identity-link request not found",
]);

const INVALID_GATEWAY_ERRORS = new Set([
  "Invalid gateway payload",
  "Invalid gateway token payload",
]);

const DOMAIN_ERROR_KEYS: Record<string, string> = {
  "Execution workspace is not reopenable": "local.api_workspace_not_reopenable_10301212",
  "Failed to rebuild the execution workspace": "local.api_workspace_rebuild_failed_10301213",
  "Release is waiting for durable delivery": "local.api_release_delivery_pending_10301214",
  "Provider vault is disabled.": "local.api_provider_vault_disabled_10301215",
  "Provider vault runtime is locked while coming soon.": "local.api_provider_vault_locked_10301216",
  "An existing secret already links this exact provider reference.":
    "local.api_provider_reference_already_linked_10301217",
};

function statusFallback(status: number): string {
  if (status === 401) return l10n("local.api_authentication_required_10301174");
  if (status === 403) return l10n("local.api_permission_denied_10301175");
  if (status === 404) return l10n("local.api_resource_not_found_10301176");
  if (status === 409) return l10n("local.api_state_conflict_10301177");
  if (status === 422) return l10n("local.api_validation_failed_10301178");
  if (status === 429) return l10n("local.api_rate_limited_10301179");
  if (status >= 500) return l10n("local.api_server_error_10301180");
  return l10n("local.api_request_failed_10301181", { v0: status });
}

/**
 * Translate only stable, generic API errors. Domain diagnostics remain intact
 * because replacing them with a status-only sentence would remove the detail
 * an operator needs to fix the request.
 */
export function localizeApiErrorMessage(message: string, status: number): string {
  const normalized = message.trim();
  if (/[^\u0000-\u007f]/.test(normalized)) return normalized;
  if (AUTH_ERRORS.has(normalized)) return l10n("local.api_authentication_required_10301174");
  if (normalized === "Forbidden") return l10n("local.api_permission_denied_10301175");
  if (NOT_FOUND_ERRORS.has(normalized)) return l10n("local.api_resource_not_found_10301176");
  if (normalized === "Validation error") return l10n("local.api_validation_failed_10301178");
  if (normalized === "Internal server error") return l10n("local.api_server_error_10301180");
  if (normalized === "Invalid JSON body") return l10n("local.api_invalid_json_body_10301182");
  if (normalized === "Method not found") return l10n("local.api_method_not_supported_10301183");
  if (INVALID_GATEWAY_ERRORS.has(normalized)) return l10n("local.api_invalid_gateway_payload_10301184");
  if (normalized === "Invalid audit cursor") return l10n("local.api_invalid_audit_cursor_10301185");
  const domainErrorKey = DOMAIN_ERROR_KEYS[normalized];
  if (domainErrorKey) return l10n(domainErrorKey);
  if (/^Request failed:\s*\d+$/.test(normalized)) return statusFallback(status);
  return message;
}
