import { l10n } from "../i18n";
import { auditSectionHref, type AuditSection } from "./audit/audit-navigation";

export type AgentDetailView =
  | "overview"
  | "instructions"
  | "skills"
  | "runtime"
  | "secrets"
  | "tools"
  | "channels"
  | "permissions"
  | "api-keys"
  | "revisions"
  | "run-detail";

export type AgentLocalDetailView = Exclude<AgentDetailView, "run-detail">;

export const AGENT_DETAIL_NAVIGATION: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ value: AgentLocalDetailView; label: string }>;
}> = [
  {
    label: l10n("local.agent_11b39c93"),
    items: [
      { value: "overview", label: l10n("local.overview_d4b1ea57") },
      { value: "instructions", label: l10n("local.instructions_934652dc") },
      { value: "skills", label: l10n("local.skills_66d0f523") },
    ],
  },
  {
    label: l10n("local.runtime_10931158"),
    items: [
      { value: "runtime", label: l10n("local.harness_runtime_6711e546") },
      { value: "secrets", label: l10n("local.secrets_d8707d41") },
      { value: "tools", label: l10n("local.tools_ea93d6a2") },
      { value: "channels", label: l10n("local.channels_4c8906cf") },
    ],
  },
  {
    label: l10n("local.governance_86f8a694"),
    items: [
      { value: "permissions", label: l10n("local.permissions_trust_183c6ae8") },
      { value: "api-keys", label: l10n("local.api_keys_c08f17eb") },
      { value: "revisions", label: l10n("local.revisions_da80b1d5") },
    ],
  },
] as const;

export function parseAgentDetailView(value: string | null): AgentLocalDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "skills") return "skills";
  if (value === "runtime" || value === "configure" || value === "configuration") return "runtime";
  if (value === "secrets") return "secrets";
  if (value === "tools") return "tools";
  if (value === "channels") return "channels";
  if (value === "permissions" || value === "trust") return "permissions";
  if (value === "api-keys" || value === "keys") return "api-keys";
  if (value === "revisions" || value === "history") return "revisions";
  return "overview";
}

export function agentDetailHref(agentRef: string, view: AgentLocalDetailView = "overview") {
  return `/agents/${agentRef}/${view}`;
}

export function agentLegacyAuditSection(value: string | null): AuditSection | null {
  if (value === "runs") return "runs";
  if (value === "audit" || value === "activity") return "activity";
  if (value === "cost" || value === "costs") return "costs";
  if (value === "budget" || value === "budgets") return "budgets";
  return null;
}

export function agentScopedAuditHref(agentId: string, section: AuditSection) {
  return auditSectionHref(section, {
    mode: section === "activity" ? "agents" : undefined,
    agentId,
  });
}
