import { l10n } from "../i18n";
import { KeyRound, Save } from "lucide-react";
import type { CompanySecret, RoutineEnvConfig } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { AgentAvatar, type AvatarAgent } from "./AgentAvatar";

export interface StageSecretsPanelProps {
  /** Whether the stage has a backing automation routine with an assignee. */
  hasAutomation: boolean;
  /** Display name + icon of the agent that runs this step (when automation exists). */
  agentName?: string | null;
  agentIcon?: string | null;
  agent?: AvatarAgent;
  /** Company secret inventory (shared, not stage-scoped). */
  secrets: CompanySecret[];
  secretsLoading: boolean;
  value: RoutineEnvConfig;
  onChange: (env: RoutineEnvConfig) => void;
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Jump to the Automation section so the user can pick an agent. */
  onSetupAutomation: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}

/**
 * Stage Secrets tab body. Stage secrets are env bindings on the step's backing
 * automation routine — the same company-secret backbone used by routines,
 * agents, and projects. This panel is intentionally dense and reuses
 * `EnvironmentVariablesEditor` for secret refs, inline secret creation, version
 * selection, and missing/disabled-secret warnings.
 */
export function StageSecretsPanel({
  hasAutomation,
  agentName,
  agentIcon,
  agent,
  secrets,
  secretsLoading,
  value,
  onChange,
  onCreateSecret,
  onSetupAutomation,
  onSave,
  saving,
  dirty,
}: StageSecretsPanelProps) {
  // No backing automation/assignee → nothing can receive secrets at runtime.
  // Point the user at Automation instead of creating a hidden routine just
  // because the Secrets tab was opened.
  if (!hasAutomation) {
    return (
      <EmptyState
        icon={KeyRound}
        message="Secrets are available only to step automation. Pick an agent to run this step, then add the secrets it needs."
        action="Set up automation"
        onAction={onSetupAutomation}
      />
    );
  }

  const displayName = agentName?.trim() || "the responsible agent";

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        {agentName ? (
          <AgentAvatar agent={agent} name={displayName} size={16} />
        ) : (
          <KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        )}
        <p>
          {l10n("local.these_env_vars_are_injected_when_ec634ff6")}{" "}
          <span className="font-medium text-foreground">{displayName}</span> {l10n("local.runs_this_step_they_override_matching_project_26a73892")}{" "}<span className="font-mono">PAPERCLIP_*</span> {l10n("local.names_are_reserved_a23f67d3")}</p>
      </div>

      {secretsLoading ? (
        <p className="text-sm text-muted-foreground">{l10n("local.loading_secrets_3775fb66")}</p>
      ) : (
        <EnvironmentVariablesEditor
          value={value}
          secrets={secrets}
          onCreateSecret={onCreateSecret}
          onChange={(env) => onChange((env ?? {}) as RoutineEnvConfig)}
        />
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={!dirty || saving}>
          <Save className="h-4 w-4 mr-1.5" />
          {saving ? l10n("local.saving_23e39291") : l10n("local.save_secrets_a84c957d")}
        </Button>
        {dirty && !saving ? <span className="text-xs text-muted-foreground">{l10n("local.unsaved_changes_a710c2b9")}</span> : null}
      </div>
    </div>
  );
}
