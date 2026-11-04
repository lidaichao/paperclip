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
  "Document is locked": "local.api_document_locked_10301218",
  "Document was updated by someone else": "local.api_document_changed_10301219",
  "Document does not exist yet": "local.api_document_missing_10301220",
  "Document key already exists on this issue": "local.api_document_key_exists_10301221",
  "Selected revision is already the latest revision": "local.api_document_revision_latest_10301222",
  "This decision is already trained by this user": "local.api_decision_already_trained_10301223",
  "Skill policy revision is stale": "local.api_skill_policy_stale_10301224",
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
 * Keep user-visible API errors in the active locale. ApiError separately keeps
 * the raw server diagnostic and response body for branching and troubleshooting.
 */
export function localizeApiErrorMessage(message: string, status: number): string {
  const normalized = message.trim();
  if (/[^\u0000-\u007f]/.test(normalized)) return normalized;
  if (AUTH_ERRORS.has(normalized)) return l10n("local.api_authentication_required_10301174");
  if (normalized === "Forbidden") return l10n("local.api_permission_denied_10301175");
  if (status === 404 && /\bnot found\.?$/i.test(normalized)) {
    return l10n("local.api_resource_not_found_10301176");
  }
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
  return statusFallback(status);
}
