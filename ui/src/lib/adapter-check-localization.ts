import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
} from "@paperclipai/shared";
import { l10n } from "../i18n";

function providerName(code: string): string {
  const prefix = code.split("_", 1)[0];
  return {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    gemini: "Gemini",
    grok: "Grok",
    hermes: "Hermes",
    kimi: "Kimi",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    pi: "Pi",
  }[prefix] ?? "Adapter";
}

function valueAfterColon(message: string): string {
  return message.replace(/^[^:]+:\s*/, "").trim();
}

const AUTH_READY_CODES = new Set([
  "kimi_auth_detected",
  "hermes_api_keys_found",
  "hermes_api_key_in_config",
  "openclaw_gateway_auth_present",
]);

const AUTH_MISSING_CODES = new Set([
  "kimi_auth_missing",
  "hermes_no_api_keys",
  "openclaw_gateway_auth_missing",
  "hermes_gateway_api_key_missing",
  "opencode_openai_api_key_missing",
]);

const MODELS_DISCOVERED_CODES = new Set([
  "grok_models_discovered",
  "grok_models_probe_passed",
  "opencode_models_discovered",
  "pi_models_discovered",
]);

const MODELS_EMPTY_CODES = new Set([
  "grok_models_empty",
  "opencode_models_empty",
  "pi_models_empty",
]);

const MODEL_DISCOVERY_FAILED_CODES = new Set([
  "cursor_cloud_model_probe_failed",
  "opencode_models_discovery_failed",
  "pi_models_discovery_failed",
]);

const MODEL_CONFIGURED_CODES = new Set([
  "hermes_configured_default_model",
  "hermes_model_configured",
  "opencode_model_configured",
  "pi_model_configured",
  "cursor_cloud_model_ok",
]);

const MODEL_UNAVAILABLE_CODES = new Set([
  "opencode_model_invalid",
  "opencode_hello_probe_model_unavailable",
  "pi_model_not_found",
  "cursor_cloud_model_unknown",
]);

const MODEL_VALIDATION_SKIPPED_CODES = new Set([
  "opencode_model_validation_skipped_remote",
  "pi_model_validation_skipped_remote",
]);

const COMMAND_CHECK_SKIPPED_CODES = new Set([
  "claude_hello_probe_skipped_unresolved_command",
  "opencode_command_skipped",
  "pi_command_skipped",
]);

function localizedMessage(check: AdapterEnvironmentCheck): string {
  const { code, message } = check;
  const provider = providerName(code);

  if (code.endsWith("_environment_target")) {
    return l10n("local.probing_inside_environment_10301066", { v0: valueAfterColon(message) });
  }
  if (code.endsWith("_cwd_valid") || code === "codex_acp_cwd_valid") {
    return l10n("local.working_directory_is_valid_10301067", { v0: valueAfterColon(message) });
  }
  if (code.endsWith("_cwd_invalid") || code === "codex_acp_cwd_invalid") {
    return l10n("local.working_directory_is_invalid_10301068");
  }
  if (code.endsWith("_command_resolvable")) {
    return l10n("local.command_is_executable_10301069", { v0: valueAfterColon(message) });
  }
  if (code.endsWith("_command_unresolvable")) {
    return l10n("local.command_is_not_executable_10301070");
  }
  if (code === "codex_openai_api_key_present" || code === "cursor_api_key_present") {
    return l10n("local.api_key_is_set_for_provider_auth_10301071", { v0: provider });
  }
  if (code === "codex_native_auth_present" || code === "cursor_native_auth_present") {
    return l10n("local.provider_native_auth_is_ready_10301072", { v0: provider });
  }
  if (code === "codex_openai_api_key_missing" || code === "cursor_api_key_missing") {
    return l10n("local.api_key_missing_provider_runs_may_fail_10301073", { v0: provider });
  }
  if (code === "gemini_api_key_present") {
    return l10n("local.provider_auth_credentials_configured_10301109", { v0: provider });
  }
  if (code === "gemini_api_key_missing") {
    return l10n("local.gemini_explicit_api_key_missing_10301110");
  }
  if (AUTH_READY_CODES.has(code)) {
    return l10n("local.provider_auth_credentials_configured_10301109", { v0: provider });
  }
  if (code === "cursor_cloud_auth_ok") {
    return l10n("local.provider_auth_credentials_valid_10301111", { v0: provider });
  }
  if (code === "cursor_cloud_auth_failed") {
    return l10n("local.provider_auth_validation_failed_10301112", { v0: provider });
  }
  if (AUTH_MISSING_CODES.has(code) || code === "cursor_cloud_api_key_missing") {
    return l10n("local.provider_auth_credentials_missing_10301113", { v0: provider });
  }
  if (code === "claude_bedrock_auth") {
    return l10n("local.claude_bedrock_auth_ready_10301114");
  }
  if (code === "claude_anthropic_api_key_overrides_subscription") {
    return l10n("local.claude_api_key_overrides_subscription_10301115");
  }
  if (code === "claude_oauth_token_configured") {
    return l10n("local.claude_subscription_token_configured_10301116");
  }
  if (code === "claude_subscription_mode_possible") {
    return l10n("local.claude_subscription_auth_available_10301117");
  }
  if (code === "claude_hello_probe_usage_limited") {
    return l10n("local.provider_usage_limit_exhausted_10301118", { v0: provider });
  }
  if (code === "claude_hello_probe_transient_upstream") {
    return l10n("local.provider_transient_upstream_error_10301119", { v0: provider });
  }
  if (code === "gemini_hello_probe_quota_exhausted") {
    return l10n("local.provider_quota_exhausted_10301120", { v0: provider });
  }
  if (code.endsWith("_hello_probe_skipped_custom_command")) {
    return l10n("local.skipped_hello_probe_custom_command_10301074", { v0: provider });
  }
  if (code.endsWith("_version_probe_timed_out")) {
    return l10n("local.provider_version_probe_timed_out_10301075", { v0: provider });
  }
  if (code.endsWith("_version_probe_passed")) {
    return l10n("local.provider_version_probe_succeeded_10301076", { v0: provider });
  }
  if (code.endsWith("_version_probe_failed")) {
    return l10n("local.provider_version_probe_failed_10301077", { v0: provider });
  }
  if (code.endsWith("_hello_probe_timed_out")) {
    return l10n("local.provider_hello_probe_timed_out_10301078", { v0: provider });
  }
  if (code.endsWith("_hello_probe_passed")) {
    return l10n("local.provider_hello_probe_succeeded_10301079", { v0: provider });
  }
  if (code.endsWith("_hello_probe_unexpected_output")) {
    return l10n("local.provider_hello_probe_unexpected_output_10301080", { v0: provider });
  }
  if (code.endsWith("_hello_probe_auth_required")) {
    return l10n("local.provider_cli_auth_not_ready_10301081", { v0: provider });
  }
  if (code.endsWith("_hello_probe_failed")) {
    return l10n("local.provider_hello_probe_failed_10301082", { v0: provider });
  }
  if (code === "adapter_auth_missing") {
    return l10n("local.adapter_environment_auth_not_ready_10301083");
  }
  if (code === "adapter_engine_unavailable") {
    return l10n("local.selected_execution_engine_unavailable_10301084");
  }
  if (code === "codex_fast_mode_unsupported_model") {
    return l10n("local.codex_fast_mode_unsupported_model_10301085");
  }
  if (code === "codex_git_repo_check_skipped") {
    return l10n("local.codex_git_repo_check_skipped_10301086");
  }
  if (code === "codex_probe_cleanup_incomplete") {
    return l10n("local.codex_probe_cleanup_incomplete_10301087");
  }
  if (code.endsWith("_engine_selected")) {
    return l10n("local.execution_engine_selected_acp_10301088");
  }
  if (code.endsWith("_acp_remote_target")) {
    return l10n("local.codex_acp_remote_environment_10301089", { v0: provider });
  }
  if (code === "codex_acp_node_supported" || code === "codex_acp_node_unsupported") {
    const version = message.match(/Node\s+(\S+)/)?.[1] ?? "Node";
    return code.endsWith("_supported")
      ? l10n("local.node_version_supports_acp_10301090", { v0: version })
      : l10n("local.node_version_does_not_support_acp_10301091", { v0: version });
  }
  if (code === "codex_acp_command_resolvable" || code === "codex_acp_command_missing") {
    const command = valueAfterColon(message);
    return code.endsWith("_resolvable")
      ? l10n("local.codex_acp_command_executable_10301092", { v0: command })
      : l10n("local.codex_acp_command_unavailable_10301093", { v0: command });
  }
  if (code === "codex_acp_openai_api_key_detected") {
    return l10n("local.openai_api_key_set_for_codex_acp_10301094");
  }
  if (code === "codex_acp_external_home_configured") {
    return l10n("local.codex_acp_uses_external_home_10301095");
  }
  if (code === "codex_acp_native_auth_detected") {
    return l10n("local.codex_acp_native_auth_ready_10301096");
  }
  if (code === "codex_acp_credentials_missing") {
    return l10n("local.codex_acp_credentials_missing_10301097");
  }
  if (code.endsWith("_acp_credentials_detected")) {
    return l10n("local.provider_acp_credentials_detected_10301107", { v0: provider });
  }
  if (code.endsWith("_acp_credentials_not_detected")) {
    return l10n("local.provider_acp_credentials_not_detected_10301108", { v0: provider });
  }
  if (code.endsWith("_acp_runtime_scaffold")) {
    return l10n("local.codex_acp_runtime_available_10301098", { v0: provider });
  }
  if (MODELS_DISCOVERED_CODES.has(code)) {
    return l10n("local.provider_models_discovered_10301121", { v0: provider });
  }
  if (MODELS_EMPTY_CODES.has(code)) {
    return l10n("local.provider_models_empty_10301122", { v0: provider });
  }
  if (MODEL_DISCOVERY_FAILED_CODES.has(code)) {
    return l10n("local.provider_model_discovery_failed_10301123", { v0: provider });
  }
  if (code === "grok_models_probe_timed_out") {
    return l10n("local.provider_model_discovery_timed_out_10301124", { v0: provider });
  }
  if (MODEL_CONFIGURED_CODES.has(code)) {
    return l10n("local.provider_model_configured_10301125", { v0: provider });
  }
  if (MODEL_UNAVAILABLE_CODES.has(code)) {
    return l10n("local.provider_model_unavailable_10301126", { v0: provider });
  }
  if (code === "pi_model_required") {
    return l10n("local.provider_model_required_10301127", { v0: provider });
  }
  if (MODEL_VALIDATION_SKIPPED_CODES.has(code)) {
    return l10n("local.provider_model_validation_skipped_remote_10301128", { v0: provider });
  }
  if (COMMAND_CHECK_SKIPPED_CODES.has(code)) {
    return l10n("local.provider_command_check_skipped_10301129", { v0: provider });
  }
  if (code === "pi_package_install_failed") {
    return l10n("local.provider_package_install_failed_10301130", { v0: provider });
  }
  if (code === "kimi_version_detected" || code === "hermes_version") {
    return l10n("local.provider_version_detected_10301131", {
      v0: provider,
      v1: valueAfterColon(message),
    });
  }
  if (code === "hermes_version_unknown") {
    return l10n("local.provider_version_unknown_10301132", { v0: provider });
  }
  if (code === "hermes_version_failed") {
    return l10n("local.provider_version_probe_failed_10301077", { v0: provider });
  }
  if (code === "claude_cli_version_probe_mismatch") {
    return l10n("local.claude_cli_probe_mismatch_10301133");
  }
  if (code === "claude_cli_version_incompatible") {
    return l10n("local.claude_cli_version_incompatible_10301134");
  }
  if (code === "claude_effort_flag_unsupported") {
    return l10n("local.claude_effort_flag_unsupported_10301135");
  }
  if (code === "grok_environment_unprepared") {
    return l10n("local.provider_environment_unprepared_10301136", { v0: provider });
  }
  if (code === "opencode_headless_permissions_enabled") {
    return l10n("local.opencode_headless_permissions_enabled_10301137");
  }
  if (code === "cursor_cloud_repo_missing") {
    return l10n("local.cursor_repository_required_10301138");
  }
  if (code === "cursor_cloud_repo_invalid") {
    return l10n("local.cursor_repository_invalid_10301139");
  }
  if (code === "cursor_cloud_repo_present") {
    return l10n("local.cursor_repository_configured_10301140", { v0: valueAfterColon(message) });
  }
  if (code === "openclaw_gateway_url_missing") {
    return l10n("local.openclaw_gateway_websocket_required_10301141");
  }
  if (code === "openclaw_gateway_url_invalid") {
    return l10n("local.gateway_address_invalid_10301142", { v0: provider });
  }
  if (code === "openclaw_gateway_url_protocol_invalid") {
    return l10n("local.openclaw_gateway_protocol_invalid_10301143");
  }
  if (code === "openclaw_gateway_url_valid") {
    return l10n("local.gateway_address_configured_10301144", {
      v0: provider,
      v1: valueAfterColon(message),
    });
  }
  if (code === "openclaw_gateway_plaintext_remote_ws") {
    return l10n("local.openclaw_remote_websocket_insecure_10301145");
  }
  if (code === "openclaw_gateway_probe_ok") {
    return l10n("local.gateway_probe_succeeded_10301146", { v0: provider });
  }
  if (code === "openclaw_gateway_probe_challenge_only") {
    return l10n("local.gateway_probe_challenge_rejected_10301147", { v0: provider });
  }
  if (code === "openclaw_gateway_probe_failed" || code === "openclaw_gateway_probe_error") {
    return l10n("local.gateway_probe_failed_10301148", { v0: provider });
  }
  if (code === "hermes_gateway_api_base_url_missing") {
    return l10n("local.hermes_gateway_address_required_10301149");
  }
  if (code === "hermes_gateway_api_base_url_invalid") {
    return l10n("local.hermes_gateway_address_invalid_10301150");
  }
  if (code === "hermes_gateway_dashboard_root_mapped") {
    return l10n("local.hermes_gateway_dashboard_root_mapped_10301151");
  }
  if (code === "hermes_gateway_plain_http_remote_denied") {
    return l10n("local.hermes_remote_http_denied_10301152");
  }
  if (code === "hermes_gateway_plain_http_remote_unsafe_allowed") {
    return l10n("local.hermes_remote_http_unsafe_allowed_10301153");
  }
  if (code === "hermes_gateway_loopback_http_allowed") {
    return l10n("local.hermes_loopback_http_allowed_10301154");
  }
  if (code === "hermes_gateway_health_ok") {
    return l10n("local.gateway_health_reachable_10301155", { v0: provider });
  }
  if (code === "hermes_gateway_health_failed") {
    return l10n("local.gateway_health_failed_10301156", { v0: provider });
  }
  if (code === "hermes_gateway_health_unreachable") {
    return l10n("local.gateway_health_unreachable_10301157", { v0: provider });
  }
  if (code === "hermes_cli_not_found") {
    return l10n("local.provider_cli_not_found_10301158", { v0: provider });
  }
  if (code === "hermes_python_missing") {
    return l10n("local.hermes_python_missing_10301159");
  }
  if (code === "hermes_python_old") {
    return l10n("local.hermes_python_too_old_10301160");
  }
  if (code === "hermes_custom_provider_config" || code === "hermes_provider_runtime_config") {
    return l10n("local.hermes_provider_config_loaded_10301161");
  }
  if (code === "hermes_provider_detected") {
    return l10n("local.hermes_provider_detected_10301162");
  }
  if (code === "hermes_provider_mismatch") {
    return l10n("local.hermes_provider_mismatch_10301163");
  }
  if (code === "hermes_provider_unsupported" || code === "hermes_provider_unknown") {
    return l10n("local.hermes_provider_unsupported_10301164");
  }
  return message;
}

function localizedHint(check: AdapterEnvironmentCheck): string | null | undefined {
  if (!check.hint) return check.hint;
  const { code } = check;
  const provider = providerName(code);
  if (code.endsWith("_hello_probe_timed_out") || code.endsWith("_hello_probe_unexpected_output") || code.endsWith("_hello_probe_failed")) {
    return l10n("local.run_provider_probe_manually_10301099", { v0: provider });
  }
  if (code.endsWith("_hello_probe_auth_required") || code.endsWith("_api_key_missing") || code === "adapter_auth_missing" || code === "codex_acp_credentials_missing") {
    return l10n("local.complete_provider_login_or_api_key_10301100", { v0: provider });
  }
  if (code.endsWith("_hello_probe_skipped_custom_command")) {
    return l10n("local.use_default_provider_cli_entrypoint_10301101", { v0: provider });
  }
  if (code === "codex_acp_node_unsupported") {
    return l10n("local.use_supported_node_or_cli_engine_10301102");
  }
  if (code === "codex_acp_command_missing") {
    return l10n("local.install_codex_acp_or_set_command_10301103");
  }
  if (AUTH_READY_CODES.has(code) || code === "cursor_cloud_auth_ok" || code === "gemini_api_key_present") {
    return l10n("local.provider_auth_ready_no_action_10301173", { v0: provider });
  }
  if (AUTH_MISSING_CODES.has(code) || code === "cursor_cloud_api_key_missing" || code === "gemini_api_key_missing") {
    return l10n("local.complete_provider_login_or_api_key_10301100", { v0: provider });
  }
  if (code === "claude_hello_probe_usage_limited" || code === "claude_hello_probe_transient_upstream" || code === "gemini_hello_probe_quota_exhausted") {
    return l10n("local.retry_provider_probe_later_10301165", { v0: provider });
  }
  if (MODEL_DISCOVERY_FAILED_CODES.has(code) || MODEL_UNAVAILABLE_CODES.has(code) || code === "pi_model_required" || code === "grok_models_probe_timed_out") {
    return l10n("local.check_provider_model_configuration_10301166", { v0: provider });
  }
  if (code.startsWith("openclaw_gateway_") || code.startsWith("hermes_gateway_")) {
    return l10n("local.check_gateway_configuration_and_network_10301167", { v0: provider });
  }
  if (code.startsWith("cursor_cloud_repo_")) {
    return l10n("local.configure_cursor_repository_10301168");
  }
  if (COMMAND_CHECK_SKIPPED_CODES.has(code) || code === "hermes_cli_not_found") {
    return l10n("local.install_provider_cli_and_retry_10301169", { v0: provider });
  }
  if (code === "claude_cli_version_probe_mismatch" || code === "claude_cli_version_incompatible" || code === "claude_effort_flag_unsupported") {
    return l10n("local.update_provider_cli_and_retry_10301170", { v0: provider });
  }
  return check.hint;
}

function localizedDetail(check: AdapterEnvironmentCheck): string | null | undefined {
  if (!check.detail) return check.detail;
  const detectedSource = check.detail.match(/^Detected in (adapter config|server environment)\.?$/);
  if (detectedSource) {
    return detectedSource[1] === "adapter config"
      ? l10n("local.detected_in_adapter_environment_10301104")
      : l10n("local.detected_in_server_environment_10301105");
  }
  const authenticatedAs = check.detail.match(/^Authenticated as (.+)\.$/);
  if (authenticatedAs) {
    return l10n("local.authenticated_account_10301171", { v0: authenticatedAs[1] });
  }
  const apiKeyName = check.detail.match(/^API key: (.+)$/);
  if (apiKeyName) {
    return l10n("local.api_key_name_10301172", { v0: apiKeyName[1] });
  }
  if (check.code === "codex_acp_openai_api_key_detected") {
    return check.detail.includes("adapter config")
      ? l10n("local.detected_in_adapter_environment_10301104")
      : l10n("local.detected_in_server_environment_10301105");
  }
  const nativeCredentialMatch = check.detail.match(/^Credentials are available through (.+) or shared source (.+)\.$/);
  if (check.code === "codex_acp_native_auth_detected" && nativeCredentialMatch) {
    return l10n("local.credentials_available_through_paths_10301106", {
      v0: nativeCredentialMatch[1],
      v1: nativeCredentialMatch[2],
    });
  }
  return check.detail;
}

export function localizeAdapterEnvironmentCheck(
  check: AdapterEnvironmentCheck,
): AdapterEnvironmentCheck {
  return {
    ...check,
    message: localizedMessage(check),
    detail: localizedDetail(check),
    hint: localizedHint(check),
  };
}

export function adapterCheckLevelLabel(level: AdapterEnvironmentCheckLevel): string {
  if (level === "info") return l10n("local.info_170322a3");
  if (level === "warn") return l10n("local.warning_e981ddae");
  return l10n("local.error_54a0e8c1");
}
