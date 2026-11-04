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
  return check.hint;
}

function localizedDetail(check: AdapterEnvironmentCheck): string | null | undefined {
  if (!check.detail) return check.detail;
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
