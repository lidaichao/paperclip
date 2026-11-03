import type { ToolProfileStatus, ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { l10n } from "../../../i18n";

/**
 * Prosumer copy for the access-profile index (PAP-10997, AP1). Reads the
 * server-computed `summary` and renders the friendly "Allows" / "Assigned to"
 * lines the table shows. Vocabulary gate: nothing here says
 * binding/entry/selector/priority — only "tools", "apps", "agents".
 */

/** "9 tools · 3 apps" / "All tools" / "All except 2 tools". */
export function allowsLabel(summary: ToolProfileSummary): string {
  if (summary.accessMode === "all_except") {
    return summary.excludedToolCount === 0
      ? l10n("local.all_tools_10300268")
      : l10n(
        summary.excludedToolCount === 1
          ? "local.all_except_one_tool_10300280"
          : "local.all_except_value_tools_10300269",
        { v0: summary.excludedToolCount },
      );
  }
  const parts = [l10n(
    summary.allowedToolCount === 1 ? "local.one_tool_count_10300281" : "local.value_tools_count_10300270",
    { v0: summary.allowedToolCount },
  )];
  if (summary.allowedApplicationCount > 0) {
    parts.push(l10n(
      summary.allowedApplicationCount === 1 ? "local.one_app_count_10300282" : "local.value_apps_count_10300271",
      { v0: summary.allowedApplicationCount },
    ));
  }
  return parts.join(" · ");
}

export interface AssignedLabel {
  text: string;
  /** A profile with no assignment has no effect — the index shows a quiet hint. */
  unassigned: boolean;
}

/** "Organization default" / "2 agents" / "Not assigned yet". */
export function assignedLabel(summary: ToolProfileSummary): AssignedLabel {
  if (summary.isCompanyDefault) return { text: l10n("local.organization_default_804a1f08"), unassigned: false };
  if (summary.appliesToAgentCount > 0) {
    return { text: l10n(
      summary.appliesToAgentCount === 1 ? "local.one_agent_count_10300283" : "local.value_agents_count_10300272",
      { v0: summary.appliesToAgentCount },
    ), unassigned: false };
  }
  if (summary.assignmentCount > 0) {
    return { text: l10n(
      summary.assignmentCount === 1 ? "local.one_assignment_count_10300284" : "local.value_assignments_count_10300273",
      { v0: summary.assignmentCount },
    ), unassigned: false };
  }
  return { text: l10n("local.not_assigned_yet_b988b42c"), unassigned: true };
}

export const STATUS_LABEL: Record<ToolProfileStatus, string> = {
  draft: l10n("local.draft_ebf12ef4"),
  active: l10n("local.active_92340695"),
  disabled: l10n("local.off_ca7981b4"),
  archived: l10n("local.archived_bdb86505"),
};

export function isDraft(profile: Pick<ToolProfileWithDetails, "status">): boolean {
  return profile.status === "draft";
}
