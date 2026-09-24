import { l10n } from "../../i18n";
import type { AdapterModel } from "../../api/agents";
import type { Issue, Project } from "@paperclipai/shared";
import { extractProviderIdWithFallback } from "../../lib/model-utils";
import type { IssueModelLane } from "../../lib/issue-assignee-overrides";
import { codexReasoningEffortOptions } from "../../lib/codex-reasoning-effort";

export function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

export function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (defaultMode === "isolated_workspace" || defaultMode === "operator_branch") return defaultMode;
  if (defaultMode === "adapter_default") return "agent_default";
  return "shared_workspace";
}

function primaryWorkspaceIdForProject(project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined) {
  return project?.primaryWorkspace?.id
    ?? project?.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project?.workspaces[0]?.id
    ?? null;
}

export function isMainIssueWorkspace(input: {
  issue: Pick<Issue, "projectWorkspaceId" | "currentExecutionWorkspace">;
  project: Pick<Project, "primaryWorkspace" | "workspaces"> | null | undefined;
}) {
  const workspace = input.issue.currentExecutionWorkspace ?? null;
  const primaryWorkspaceId = primaryWorkspaceIdForProject(input.project);
  const linkedProjectWorkspaceId = workspace?.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  if (workspace) {
    if (workspace.mode !== "shared_workspace") return false;
    if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
    return workspace.mode === "shared_workspace" && linkedProjectWorkspaceId === primaryWorkspaceId;
  }
  if (!linkedProjectWorkspaceId || !primaryWorkspaceId) return true;
  return linkedProjectWorkspaceId === primaryWorkspaceId;
}

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: l10n("local.default_21b111cb") },
    { value: "low", label: l10n("local.low_f793de20") },
    { value: "medium", label: l10n("local.medium_8e588cd1") },
    { value: "high", label: l10n("local.high_c4ebc6d4") },
  ],
  opencode_local: [
    { value: "", label: l10n("local.default_21b111cb") },
    { value: "minimal", label: l10n("local.minimal_057b5de4") },
    { value: "low", label: l10n("local.low_f793de20") },
    { value: "medium", label: l10n("local.medium_8e588cd1") },
    { value: "high", label: l10n("local.high_c4ebc6d4") },
    { value: "xhigh", label: l10n("local.x_high_393d3e4b") },
    { value: "max", label: l10n("local.max_a1a5936d") },
  ],
} as const;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

export function thinkingEffortOptionsFor(
  adapterType: string | null | undefined,
  model?: string | null,
) {
  if (adapterType === "codex_local") return codexReasoningEffortOptions(model);
  if (adapterType === "opencode_local") return ISSUE_THINKING_EFFORT_OPTIONS.opencode_local;
  return ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
}

export function thinkingEffortKeyFor(adapterType: string | null | undefined) {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "opencode_local") return "variant";
  return "effort";
}

export function thinkingEffortValueFor(adapterType: string | null | undefined, adapterConfig: Record<string, unknown>) {
  if (adapterType === "codex_local") {
    return String(adapterConfig.modelReasoningEffort ?? adapterConfig.reasoningEffort ?? adapterConfig.effort ?? "");
  }
  if (adapterType === "opencode_local") {
    return String(adapterConfig.variant ?? "");
  }
  return String(adapterConfig.effort ?? "");
}

export function overrideLane(overrides: Issue["assigneeAdapterOverrides"]): IssueModelLane {
  if (overrides?.adapterConfig) return "custom";
  return "primary";
}

export function sortAdapterModels(models: AdapterModel[]) {
  return [...models].sort((a, b) => {
    const providerA = extractProviderIdWithFallback(a.id);
    const providerB = extractProviderIdWithFallback(b.id);
    const byProvider = providerA.localeCompare(providerB);
    if (byProvider !== 0) return byProvider;
    return a.id.localeCompare(b.id);
  });
}
