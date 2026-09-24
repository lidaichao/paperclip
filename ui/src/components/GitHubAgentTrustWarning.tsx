import { l10n } from "../i18n";
import { AlertTriangle, ExternalLink } from "lucide-react";
import type { AgentPermissions } from "@paperclipai/shared";
import { getTrustPreset } from "@/lib/trust-policy-ui";

export const LOW_TRUST_AGENT_GUIDE =
  "https://docs.paperclip.ing/administration/trust-and-low-trust-review/";

export function GitHubAgentTrustWarning({
  agent,
}: {
  agent:
    { name: string; permissions: Partial<AgentPermissions> } | null | undefined;
}) {
  if (!agent || getTrustPreset(agent.permissions) === "low_trust_review")
    return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        {agent.name} {l10n("local.is_not_configured_for_low_trust_review_50c5fb10")}</p>
      <p>
        {l10n("local.github_comments_and_pull_requests_can_contain_e21696ad")}</p>
      <p className="text-xs text-muted-foreground">
        {l10n("local.continuing_keeps_this_agent_s_current_permiss_63846416")}</p>
      <a
        className="inline-flex items-center gap-1 underline underline-offset-4"
        href={LOW_TRUST_AGENT_GUIDE}
        target="_blank"
        rel="noreferrer"
      >
        {l10n("local.learn_about_low_trust_agents_3c6aaa98")}<ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
