import { l10n } from "../i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  extractRoutineVariableNames,
  groupWarningsByStage,
  isBuiltinRoutineVariable,
  isPipelineTerminalStageKind,
  PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE,
  syncRoutineVariablesWithTemplate,
  type ExecutionWorkspaceMode,
  type ExecutionWorkspaceSummary,
  type IssueExecutionWorkspaceSettings,
  type RoutineEnvConfig,
  type RoutineVariable,
} from "@paperclipai/shared";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Archive,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  GitBranch,
  Hammer,
  History as HistoryIcon,
  Hexagon,
  KeyRound,
  LayoutGrid,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import type {
  PipelineCaseChildRow,
  PipelineCompanyCaseEvent,
  PipelineDetail,
  PipelineListItem,
  PipelineStage,
  PipelineTransitionEdge,
} from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { EmptyState } from "../components/EmptyState";
import { StageSecretsPanel } from "../components/StageSecretsPanel";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { PipelineStageHistoryPanel } from "../components/PipelineStageHistoryPanel";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { buildCompanyUserInlineOptions, isAgentTaskTarget } from "../lib/company-members";
import { useStandardMarkdownMentionOptions } from "../hooks/useStandardMarkdownMentionOptions";
import { formatPipelineItemEvent, INTERNAL_FIELD_KEYS } from "../lib/pipeline-item-detail";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import {
  defaultExecutionWorkspaceModeForProject,
  defaultProjectWorkspaceIdForProject,
  issueExecutionWorkspaceModeForExistingWorkspace,
} from "../lib/project-workspace-defaults";
import { orderReusableExecutionWorkspaces } from "../lib/reusable-execution-workspaces";
import { cn, relativeTime } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { StageHealthWarnings } from "../components/PipelineHealthWarnings";
import {
  breakdownSummarySentence,
  isCarryOverFieldEnabled,
  isCarryOverIdentityFieldKey,
  pieceNounPlural,
  readStageBreakdown,
  type BreakdownCarryOverPolicy,
  type BreakdownCopyNames,
} from "../lib/pipeline-breakdown";
import { getPipelineStageColumnTone } from "../lib/pipeline-stage-presentation";

type StageSectionKey = "instructions" | "advanced" | "secrets" | "activity" | "history";
type ApproverKind = "any_human" | "user" | "agent";
type EditableStageKind = "working" | "review" | "done" | "cancelled";

type StageConfig = {
  // Stage instruction variables are stored in the routine variable shape
  // (`{ name, label, type, defaultValue, required, options }`) and kept in sync
  // with the instructions body. Legacy entries used `{ key, ... }`; both are
  // read through `toRoutineVariables`.
  variables?: unknown[];
  disabled?: boolean;
  disabledReason?: string | null;
  automation?: {
    assigneeAgentId?: string | null;
    titleTemplate?: string | null;
    instructionsBody?: string | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: ExecutionWorkspaceMode | string | null;
    executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
    // Derived (read-only) fields the server adds from the backing automation
    // routine. They are never persisted into stage config — stage secrets live
    // on `routines.env` and are saved through the automation-env route.
    routineId?: string;
    env?: RoutineEnvConfig | null;
    latestRoutineRevisionId?: string | null;
    latestRoutineRevisionNumber?: number;
  };
  requireApproval?: boolean;
  approver?: {
    kind?: ApproverKind;
    id?: string | null;
  };
  reviewerKind?: string;
  whatHappensHere?: string;
  approveToStageKey?: string;
  rejectToStageKey?: string;
  requestChangesToStageKey?: string;
  requireRejectReason?: boolean;
  requireRequestChangesReason?: boolean;
  requireChildrenTerminal?: boolean;
  autoAdvanceOnChildrenTerminal?: string;
  [key: string]: unknown;
};

type EditorRoutineVariable = RoutineVariable & { source?: "manual" };

const STAGE_NAV_GROUPS: Array<{
  label: string;
  items: Array<{ id: StageSectionKey; label: string; icon: typeof Circle }>;
}> = [
  {
    label: l10n("local.stage_de838855"),
    items: [
      { id: "instructions", label: l10n("local.automation_d909750b"), icon: LayoutGrid },
      { id: "advanced", label: l10n("local.advanced_9f088dbe"), icon: SlidersHorizontal },
      { id: "secrets", label: l10n("local.secrets_d8707d41"), icon: KeyRound },
    ],
  },
  {
    label: l10n("local.operate_58c3939c"),
    items: [
      { id: "activity", label: l10n("local.activity_38da1505"), icon: ActivityIcon },
      { id: "history", label: l10n("local.history_0e769600"), icon: HistoryIcon },
    ],
  },
];

const STAGE_SECTION_TITLES: Record<StageSectionKey, string> = {
  instructions: "Automation",
  secrets: "Secrets",
  activity: "Activity",
  history: "History",
  advanced: "Advanced",
};

function parseStageSectionKey(value: string | null): StageSectionKey | null {
  switch (value) {
    case "instructions":
    case "advanced":
    case "secrets":
    case "activity":
    case "history":
      return value;
    default:
      return null;
  }
}

export function resolvePipelineSettingsFallbackStageId(
  stages: Array<Pick<PipelineStage, "id">>,
  selectedStageId: string | null,
  requestedStageId: string | null,
) {
  const requestedStageExists = Boolean(requestedStageId && stages.some((stage) => stage.id === requestedStageId));
  if (selectedStageId || requestedStageExists) return null;
  return stages[0]?.id ?? null;
}

const STAGE_KIND_OPTIONS: Array<{
  value: EditableStageKind;
  label: string;
  description: string;
  icon: typeof Circle;
}> = [
  {
    value: "working",
    label: l10n("local.working_a92f0449"),
    description: l10n("local.items_wait_here_while_work_happens_an_agent_o_5217c39b"),
    icon: Hammer,
  },
  {
    value: "review",
    label: l10n("local.review_aff0766a"),
    description: l10n("local.someone_has_to_approve_before_items_leave_use_279e0914"),
    icon: BadgeCheck,
  },
  {
    value: "done",
    label: l10n("local.done_11a6767d"),
    description: l10n("local.the_final_step_items_that_reach_here_are_fini_f11b3150"),
    icon: CircleCheck,
  },
  {
    value: "cancelled",
    label: l10n("local.cancelled_d353a99e"),
    description: l10n("local.the_dead_end_items_that_reach_here_are_droppe_2dcda684"),
    icon: Ban,
  },
];

/** Per-stage instructions document key — keyed by stage id so it survives renames. */
function stageInstructionsKey(stageId: string) {
  return `stage-instructions:${stageId}`;
}

const ROUTINE_VARIABLE_TYPES: ReadonlySet<RoutineVariable["type"]> = new Set([
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
]);

/**
 * Read stage `config.variables` into the routine variable shape, tolerating
 * both the current shape (`{ name, ... }`) and the legacy pipeline shape
 * (`{ key, type: text|multiline|select, showInAddForm }`).
 */
function toRoutineVariables(raw: unknown): RoutineVariable[] {
  if (!Array.isArray(raw)) return [];
  const result: RoutineVariable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : typeof record.key === "string" && record.key.trim()
        ? record.key.trim()
        : null;
    if (!name) continue;
    const rawType = typeof record.type === "string" ? record.type : "text";
    const type: RoutineVariable["type"] = ROUTINE_VARIABLE_TYPES.has(rawType as RoutineVariable["type"])
      ? (rawType as RoutineVariable["type"])
      : rawType === "multiline"
        ? "textarea"
        : "text";
    const options = Array.isArray(record.options)
      ? record.options.filter((option): option is string => typeof option === "string")
      : [];
    const defaultValue = record.defaultValue as RoutineVariable["defaultValue"];
    result.push({
      name,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : null,
      type,
      defaultValue:
        defaultValue === undefined ||
        (typeof defaultValue !== "string" && typeof defaultValue !== "number" && typeof defaultValue !== "boolean")
          ? null
          : defaultValue,
      required: record.required === true,
      options,
    });
  }
  return result;
}

function stageConfig(stage: PipelineStage | null | undefined): StageConfig {
  const config = stage?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { variables: [] };
  }
  return config as StageConfig;
}

const STAGE_EXECUTION_WORKSPACE_OPTIONS = [
  { value: "shared_workspace", label: l10n("local.project_default_e8cb80e5") },
  { value: "isolated_workspace", label: l10n("local.new_isolated_workspace_0c67029f") },
  { value: "reuse_existing", label: l10n("local.reuse_existing_workspace_c84ba2b6") },
] as const;

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableExecutionWorkspaceMode(value: unknown): ExecutionWorkspaceMode | "" {
  switch (nullableString(value)) {
    case "inherit":
    case "shared_workspace":
    case "isolated_workspace":
    case "operator_branch":
    case "reuse_existing":
    case "agent_default":
      return nullableString(value) as ExecutionWorkspaceMode;
    default:
      return "";
  }
}

function nullableExecutionWorkspaceSettings(value: unknown): IssueExecutionWorkspaceSettings | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as IssueExecutionWorkspaceSettings
    : null;
}

export function pipelineAutomationTitleTemplate(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE;
}

export function syncPipelineStageAutomationVariables(
  titleTemplate: string,
  instructionsBody: string,
  existing: RoutineVariable[],
): RoutineVariable[] {
  const synced = syncRoutineVariablesWithTemplate([titleTemplate, instructionsBody], existing);
  const syncedNames = new Set(synced.map((variable) => variable.name));
  return [...synced, ...existing.filter((variable) => !syncedNames.has(variable.name))];
}

export function buildStageAutomationForSave(input: {
  assigneeAgentId: string;
  titleTemplate: string;
  instructionsBody: string;
  projectId: string;
  projectWorkspaceId: string;
  executionWorkspaceId: string;
  executionWorkspacePreference: ExecutionWorkspaceMode | "";
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
}) {
  return {
    assigneeAgentId: input.assigneeAgentId || null,
    titleTemplate: pipelineAutomationTitleTemplate(input.titleTemplate),
    instructionsBody: input.instructionsBody,
    projectId: input.projectId || null,
    projectWorkspaceId: input.projectId && input.projectWorkspaceId ? input.projectWorkspaceId : null,
    executionWorkspaceId:
      input.projectId && input.executionWorkspacePreference === "reuse_existing" && input.executionWorkspaceId
        ? input.executionWorkspaceId
        : null,
    executionWorkspacePreference:
      input.projectId && input.executionWorkspacePreference ? input.executionWorkspacePreference : null,
    executionWorkspaceSettings: input.executionWorkspaceSettings,
  };
}

function executionWorkspaceSettingsForPreference(
  preference: ExecutionWorkspaceMode | "",
  reusableWorkspace: Pick<ExecutionWorkspaceSummary, "mode"> | null,
): IssueExecutionWorkspaceSettings | null {
  if (!preference) return null;
  return {
    mode: preference === "reuse_existing"
      ? issueExecutionWorkspaceModeForExistingWorkspace(reusableWorkspace?.mode)
      : preference,
  };
}

function stageAutomation(stage: PipelineStage | null | undefined) {
  const automation = stageConfig(stage).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) {
    return {
      assigneeAgentId: "",
      titleTemplate: PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE,
      instructionsBody: null as string | null,
      projectId: "",
      projectWorkspaceId: "",
      executionWorkspaceId: "",
      executionWorkspacePreference: "" as ExecutionWorkspaceMode | "",
      executionWorkspaceSettings: null as IssueExecutionWorkspaceSettings | null,
    };
  }
  const executionWorkspaceSettings = nullableExecutionWorkspaceSettings(automation.executionWorkspaceSettings);
  return {
    assigneeAgentId: nullableString(automation.assigneeAgentId),
    titleTemplate: pipelineAutomationTitleTemplate(automation.titleTemplate),
    instructionsBody: typeof automation.instructionsBody === "string" ? automation.instructionsBody : null,
    projectId: nullableString(automation.projectId),
    projectWorkspaceId: nullableString(automation.projectWorkspaceId),
    executionWorkspaceId: nullableString(automation.executionWorkspaceId),
    executionWorkspacePreference:
      nullableExecutionWorkspaceMode(automation.executionWorkspacePreference)
      || nullableExecutionWorkspaceMode(executionWorkspaceSettings?.mode),
    executionWorkspaceSettings,
  };
}

function stageNewEntriesDisabled(stage: PipelineStage | null | undefined) {
  return stageConfig(stage).disabled === true;
}

/**
 * Read the server-derived automation detail for the Secrets tab. The backing
 * routine is the source of truth: `routineId` + `assigneeAgentId` tell us
 * whether automation actually exists (so secrets can be bound), `env` is the
 * current routine env, and `latestRoutineRevisionId` is used for optimistic
 * concurrency when saving.
 */
function stageAutomationDetail(stage: PipelineStage | null | undefined) {
  const automation = stageConfig(stage).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) {
    return { routineId: "", assigneeAgentId: "", env: {} as RoutineEnvConfig, latestRoutineRevisionId: null as string | null };
  }
  return {
    routineId: typeof automation.routineId === "string" ? automation.routineId : "",
    assigneeAgentId: typeof automation.assigneeAgentId === "string" ? automation.assigneeAgentId : "",
    env: (automation.env ?? {}) as RoutineEnvConfig,
    latestRoutineRevisionId:
      typeof automation.latestRoutineRevisionId === "string" ? automation.latestRoutineRevisionId : null,
  };
}

/**
 * Stage intake fields share the routine variable shape, but they are not purely
 * body-driven. Placeholder-derived fields are added while existing manual
 * fields stay in place when instructions change.
 */
function savedStageVariables(
  stage: PipelineStage | null | undefined,
  savedTitleTemplate: string,
  savedBody: string,
): RoutineVariable[] {
  const existing = toRoutineVariables(stageConfig(stage).variables);
  return syncPipelineStageAutomationVariables(savedTitleTemplate, savedBody, existing);
}

function stripVariableEditorMetadata(variables: RoutineVariable[]): RoutineVariable[] {
  return variables.map((variable) => {
    const { source: _source, ...rest } = variable as EditorRoutineVariable;
    return rest;
  });
}

function stripVariablesByName(variables: RoutineVariable[], names: Iterable<string>): RoutineVariable[] {
  const nameSet = new Set(names);
  if (nameSet.size === 0) return variables;
  return variables.filter((variable) => !nameSet.has(variable.name));
}

function manualVariableNamesForTemplate(
  variables: RoutineVariable[],
  template: Array<string | null | undefined>,
): string[] {
  const templateNames = new Set(
    extractRoutineVariableNames(template).filter((name) => !isBuiltinRoutineVariable(name)),
  );
  return variables.filter((variable) => !templateNames.has(variable.name)).map((variable) => variable.name);
}

const DEFAULT_CARRY_OVER_POLICY: BreakdownCarryOverPolicy = {
  version: 1,
  mode: "all_except",
  includeFields: [],
  excludeFields: [],
};

type PipelineWithOptionalConnections = (PipelineDetail | PipelineListItem) & {
  connections?: PipelineListItem["connections"];
};

type CarryOverFieldOption = {
  key: string;
  label: string;
  required: boolean;
  originId: string;
  originLabel: string;
  originDescription: string | null;
};

type CarryOverFieldGroup = {
  id: string;
  label: string;
  description: string | null;
  depth: number;
  fields: CarryOverFieldOption[];
};

function copyCarryOverPolicy(policy: BreakdownCarryOverPolicy | null | undefined): BreakdownCarryOverPolicy {
  return {
    version: 1,
    mode: policy?.mode === "only" ? "only" : "all_except",
    includeFields: [...(policy?.includeFields ?? [])],
    excludeFields: [...(policy?.excludeFields ?? [])],
  };
}

function readVariableField(variable: unknown): { key: string; label: string; required: boolean } | null {
  if (!variable || typeof variable !== "object" || Array.isArray(variable)) return null;
  const record = variable as Record<string, unknown>;
  const key = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : typeof record.key === "string" && record.key.trim()
      ? record.key.trim()
      : "";
  if (!key) return null;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : key;
  if (isCarryOverIdentityFieldKey(key) || isCarryOverIdentityFieldKey(label)) return null;
  return { key, label, required: record.required === true };
}

function fieldOriginLabel(depth: number, pipelineName: string) {
  if (depth === 0) return l10n("local.this_item_10ceeb1a");
  if (depth === 1) return l10n("local.parent_value_926ade7d", {v0: (pipelineName)});
  if (depth === 2) return l10n("local.grandparent_value_e9dc53c2", {v0: (pipelineName)});
  return l10n("local.ancestor_value_value_e052c49d", {v0: (depth), v1: (pipelineName)});
}

function pipelineCarryOverFields(source: { pipeline: PipelineWithOptionalConnections; depth: number }): CarryOverFieldOption[] {
  const stages = [...(source.pipeline.stages ?? [])].sort((left, right) => left.position - right.position);
  const seen = new Set<string>();
  return stages.flatMap((stage) => {
    const variables = stageConfig(stage).variables ?? [];
    return variables.flatMap((variable) => {
      const field = readVariableField(variable);
      if (!field || seen.has(field.key)) return [];
      seen.add(field.key);
      return [{
        ...field,
        originId: source.pipeline.id,
        originLabel: fieldOriginLabel(source.depth, source.pipeline.name),
        originDescription: source.depth === 0 ? source.pipeline.name : null,
      }];
    });
  });
}

function pipelineBreakdownTargetIds(pipeline: PipelineWithOptionalConnections) {
  const ids: string[] = [];
  for (const stage of pipeline.stages ?? []) {
    const targetPipelineId = readStageBreakdown(stage)?.targetPipelineId;
    if (targetPipelineId) ids.push(targetPipelineId);
  }
  return ids;
}

function upstreamPipelineIds(
  pipeline: PipelineWithOptionalConnections,
  candidates: PipelineWithOptionalConnections[],
) {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === pipeline.id) continue;
    if (pipelineBreakdownTargetIds(candidate).includes(pipeline.id)) ids.add(candidate.id);
  }
  for (const id of pipeline.connections?.upstreamPipelineIds ?? []) ids.add(id);
  return [...ids];
}

function buildCarryOverFieldGroups(
  pipeline: PipelineWithOptionalConnections | null,
  candidates: PipelineWithOptionalConnections[],
): CarryOverFieldGroup[] {
  if (!pipeline) return [];
  const byId = new Map<string, PipelineWithOptionalConnections>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  const listedCurrentPipeline = byId.get(pipeline.id);
  byId.set(pipeline.id, listedCurrentPipeline ? { ...listedCurrentPipeline, ...pipeline } : pipeline);

  const sources: Array<{ pipeline: PipelineWithOptionalConnections; depth: number }> = [];
  const queue: Array<{ pipeline: PipelineWithOptionalConnections; depth: number }> = [{ pipeline: byId.get(pipeline.id)!, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.pipeline.id) || next.depth > 8) continue;
    visited.add(next.pipeline.id);
    sources.push(next);
    for (const upstreamId of upstreamPipelineIds(next.pipeline, [...byId.values()]).sort()) {
      const upstream = byId.get(upstreamId);
      if (upstream && !visited.has(upstream.id)) queue.push({ pipeline: upstream, depth: next.depth + 1 });
    }
  }

  const claimedFieldKeys = new Set<string>();
  return sources.flatMap((source) => {
    const fields = pipelineCarryOverFields(source).filter((field) => {
      if (claimedFieldKeys.has(field.key)) return false;
      claimedFieldKeys.add(field.key);
      return true;
    });
    if (fields.length === 0) return [];
    return [{
      id: source.pipeline.id,
      label: fieldOriginLabel(source.depth, source.pipeline.name),
      description: source.depth === 0 ? source.pipeline.name : null,
      depth: source.depth,
      fields,
    }];
  });
}

function flattenCarryOverFields(groups: CarryOverFieldGroup[]) {
  return groups.flatMap((group) => group.fields);
}

function selectedCarryOverFieldKeys(policy: BreakdownCarryOverPolicy, fields: CarryOverFieldOption[]) {
  return fields.filter((field) => isCarryOverFieldEnabled(policy, field.key)).map((field) => field.key);
}

function carryOverPolicyForCheckedFields(checkedKeys: Iterable<string>, fields: CarryOverFieldOption[]): BreakdownCarryOverPolicy {
  const checked = new Set(checkedKeys);
  return {
    version: 1,
    mode: "all_except",
    includeFields: [],
    excludeFields: fields.filter((field) => !checked.has(field.key)).map((field) => field.key),
  };
}

function toggleCarryOverField(
  policy: BreakdownCarryOverPolicy,
  fields: CarryOverFieldOption[],
  fieldKey: string,
  checked: boolean,
): BreakdownCarryOverPolicy {
  const selected = new Set(selectedCarryOverFieldKeys(policy, fields));
  if (checked) selected.add(fieldKey);
  else selected.delete(fieldKey);
  return carryOverPolicyForCheckedFields(selected, fields);
}

function buildIncomingCarryOverFieldGroups(
  pipeline: PipelineDetail | null,
  stage: PipelineStage | null,
  candidates: PipelineListItem[],
): CarryOverFieldGroup[] {
  if (!pipeline || !stage) return [];
  const byId = new Map<string, PipelineWithOptionalConnections>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  const listedCurrentPipeline = byId.get(pipeline.id);
  byId.set(pipeline.id, listedCurrentPipeline ? { ...listedCurrentPipeline, ...pipeline } : pipeline);

  return [...byId.values()].flatMap((sourcePipeline) => {
    return (sourcePipeline.stages ?? []).flatMap((sourceStage) => {
      const breakdown = readStageBreakdown(sourceStage);
      if (!breakdown || breakdown.targetPipelineId !== pipeline.id || breakdown.targetStageKey !== stage.key) {
        return [];
      }
      const sourceFieldGroups = buildCarryOverFieldGroups(sourcePipeline, [...byId.values()]);
      const sourceFields = flattenCarryOverFields(sourceFieldGroups);
      const fieldByKey = new Map(sourceFields.map((field) => [field.key, field]));
      const policy = copyCarryOverPolicy(breakdown.carryOverPolicy ?? DEFAULT_CARRY_OVER_POLICY);
      const selectedKeys = policy.mode === "only"
        ? policy.includeFields.filter((key) => !isCarryOverIdentityFieldKey(key))
        : selectedCarryOverFieldKeys(policy, sourceFields);
      const fields = selectedKeys.map((key) => {
        const field = fieldByKey.get(key);
        return field ?? {
          key,
          label: key,
          required: false,
          originId: sourcePipeline.id,
          originLabel: sourcePipeline.name,
          originDescription: sourceStage.name,
        };
      });
      if (fields.length === 0) return [];
      return [{
        id: `${sourcePipeline.id}:${sourceStage.id}`,
        label: sourcePipeline.name,
        description: sourceStage.name,
        depth: 1,
        fields,
      }];
    });
  });
}

function carryOverPolicyForSave(policy: BreakdownCarryOverPolicy, fields: CarryOverFieldOption[]) {
  if (fields.length === 0) return copyCarryOverPolicy(policy);
  return carryOverPolicyForCheckedFields(selectedCarryOverFieldKeys(policy, fields), fields);
}

function inheritFieldsForSave(policy: BreakdownCarryOverPolicy, fields: CarryOverFieldOption[]) {
  if (fields.length === 0) return policy.mode === "only" ? [...policy.includeFields] : [];
  return selectedCarryOverFieldKeys(policy, fields);
}

type StageFormValues = {
  name: string;
  kind: string;
  newEntriesDisabled: boolean;
  disableReason: string;
  assigneeAgentId: string;
  approvalRequired: boolean;
  approval: string;
  approveTarget: string;
  rejectTarget: string;
  requestChangesTarget: string;
  requireRejectReason: boolean;
  requireRequestChangesReason: boolean;
  requireChildrenTerminal: boolean;
  autoAdvanceOnChildrenTerminal: string;
  breakdownEnabled: boolean;
  breakdownTargetPipelineId: string;
  breakdownTargetStageKey: string;
  breakdownPieceNoun: string;
  breakdownCarryOverPolicy: BreakdownCarryOverPolicy;
  breakdownAdvanceTo: string;
  breakdownWaitForPieces: boolean;
  breakdownWhenFinishedMoveTo: string;
  transitionTargetIds: string[];
  automationProjectId: string;
  automationProjectWorkspaceId: string;
  automationExecutionWorkspaceId: string;
  automationExecutionWorkspacePreference: ExecutionWorkspaceMode | "";
  automationExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  automationTitleTemplate: string;
};

type PipelineTransitionRecord = { fromStageId: string; toStageId: string; label?: string | null };

function computeStageForm(
  stage: PipelineStage,
  transitions: PipelineTransitionRecord[],
): StageFormValues {
  const config = stageConfig(stage);
  const automation = stageAutomation(stage);
  const breakdown = readStageBreakdown(stage);
  return {
    name: stage.name,
    kind: canonicalStageKind(stage.kind),
    newEntriesDisabled: stageNewEntriesDisabled(stage),
    disableReason: config.disabledReason ?? "",
    assigneeAgentId: automation.assigneeAgentId,
    approvalRequired: Boolean(config.requireApproval),
    approval: approvalValue(config),
    approveTarget: config.approveToStageKey ?? "",
    rejectTarget: config.rejectToStageKey ?? "",
    requestChangesTarget: config.requestChangesToStageKey ?? "",
    requireRejectReason: config.requireRejectReason ?? true,
    requireRequestChangesReason: config.requireRequestChangesReason ?? true,
    requireChildrenTerminal: config.requireChildrenTerminal === true,
    autoAdvanceOnChildrenTerminal:
      typeof config.autoAdvanceOnChildrenTerminal === "string" ? config.autoAdvanceOnChildrenTerminal : "",
    breakdownEnabled: breakdown !== null,
    breakdownTargetPipelineId: breakdown?.targetPipelineId ?? "",
    breakdownTargetStageKey: breakdown?.targetStageKey ?? "",
    breakdownPieceNoun: breakdown?.pieceNoun ?? "piece",
    breakdownCarryOverPolicy: copyCarryOverPolicy(breakdown?.carryOverPolicy ?? DEFAULT_CARRY_OVER_POLICY),
    breakdownAdvanceTo: breakdown?.advanceTo ?? "",
    breakdownWaitForPieces: breakdown?.waitForPieces ?? false,
    breakdownWhenFinishedMoveTo: breakdown?.whenFinishedMoveTo ?? "",
    transitionTargetIds: transitions
      .filter((transition) => transition.fromStageId === stage.id)
      .map((transition) => transition.toStageId)
      .sort(),
    automationProjectId: automation.projectId,
    automationProjectWorkspaceId: automation.projectWorkspaceId,
    automationExecutionWorkspaceId: automation.executionWorkspaceId,
    automationExecutionWorkspacePreference: automation.executionWorkspacePreference,
    automationExecutionWorkspaceSettings: automation.executionWorkspaceSettings,
    automationTitleTemplate: automation.titleTemplate,
  };
}

function approvalValue(config: StageConfig) {
  const approver = config.approver;
  if (!approver || !approver.kind || approver.kind === "any_human") {
    return "any_human";
  }
  if ((approver.kind === "user" || approver.kind === "agent") && approver.id) {
    return `${approver.kind}:${approver.id}`;
  }
  return "any_human";
}

function parseApprovalValue(value: string): { kind: ApproverKind; id: string | null } {
  if (value === "any_human") {
    return { kind: "any_human", id: null };
  }
  const [kind, id] = value.split(":", 2);
  if ((kind === "user" || kind === "agent") && id) {
    return { kind, id };
  }
  return { kind: "any_human", id: null };
}

export function stageKeyFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug || "stage";
}

function nextStageKey(name: string, existingKeys: Set<string>) {
  const base = stageKeyFromName(name);
  if (!existingKeys.has(base)) return base;
  return `${base}_${Date.now().toString(36)}`;
}

function sortedStages(pipeline: PipelineDetail | null | undefined) {
  return [...(pipeline?.stages ?? [])].sort((left, right) => left.position - right.position);
}

function canonicalStageKind(kind: string | null | undefined): EditableStageKind {
  if (kind === "review" || kind === "done" || kind === "cancelled") return kind;
  return "working";
}

function nextStageByPosition(stages: PipelineStage[], stage: PipelineStage | null | undefined) {
  if (!stage) return null;
  return stages.find((candidate) => candidate.id !== stage.id && candidate.position > stage.position) ?? null;
}

function nextStageForInsert(stages: PipelineStage[], position: number) {
  return stages.find((stage) => stage.position >= position) ?? null;
}

function stageNavGroups(kind: string): typeof STAGE_NAV_GROUPS {
  void kind;
  return STAGE_NAV_GROUPS;
}

export function isPipelineSettingsStageSectionAvailable(kind: string, section: StageSectionKey) {
  return stageNavGroups(kind).some((group) => group.items.some((item) => item.id === section));
}

function defaultReviewTarget(stages: PipelineStage[], selectedStageId: string | null, kind: string) {
  const match = stages.find((stage) => stage.kind === kind && stage.id !== selectedStageId);
  if (match) return match.key;
  const fallback = stages.find((stage) => stage.id !== selectedStageId);
  return fallback?.key ?? "";
}

function dedupeEdges(edges: PipelineTransitionEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (edge.fromStageKey === edge.toStageKey) return false;
    const key = `${edge.fromStageKey}:${edge.toStageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stageAssigneeOptionId(agentId: string | null | undefined) {
  return agentId ? `agent:${agentId}` : "";
}

function stageAssigneeIdFromOption(value: string) {
  return value.startsWith("agent:") ? value.slice("agent:".length) : "";
}

function approverValueFromOption(value: string) {
  return value || "any_human";
}

type AutomationVariableOption = {
  key: string;
  label: string;
  description: string;
  example: unknown;
  exampleSource: string | null;
};

type AutomationVariableGroup = {
  id: string;
  label: string;
  variables: AutomationVariableOption[];
};

const AUTOMATION_ITEM_BUILTIN_KEYS = new Set([
  "case_id",
  "case_key",
  "case_title",
  "case_version",
  "title",
  "body",
  "case_body",
]);

function primitiveAutomationVariablePreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function automationVariableKind(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value == null) return "empty";
  return typeof value;
}

function automationVariablePreviewTitle(variable: AutomationVariableOption) {
  const preview = primitiveAutomationVariablePreview(variable.example);
  const size = typeof variable.example === "string" ? `${variable.example.length} chars` : `${preview.length} chars`;
  const lines = [
    variable.description,
    `Example: ${automationVariableKind(variable.example)}, ${size}`,
  ];
  if (variable.exampleSource) lines.push(`From ${variable.exampleSource}`);
  if (preview) lines.push(preview.length > 500 ? `${preview.slice(0, 500)}...` : preview);
  return lines.join("\n");
}

function itemExampleSource(row: PipelineCaseChildRow | null) {
  if (!row) return null;
  return row.case.caseKey ? `${row.case.title} (${row.case.caseKey})` : row.case.title;
}

function buildAutomationVariableGroups(input: {
  pipeline: PipelineDetail;
  stage: PipelineStage;
  sampleRow: PipelineCaseChildRow | null;
}): AutomationVariableGroup[] {
  const sampleCase = input.sampleRow?.case ?? null;
  const exampleSource = itemExampleSource(input.sampleRow);
  const pipelineVariables: AutomationVariableOption[] = [
    {
      key: "pipeline_id",
      label: l10n("local.pipeline_id_2ee44497"),
      description: l10n("local.id_of_the_pipeline_this_automation_runs_in_dbfdd9eb"),
      example: input.pipeline.id,
      exampleSource: null,
    },
    {
      key: "pipeline_key",
      label: l10n("local.pipeline_key_e43abacb"),
      description: l10n("local.stable_key_of_the_pipeline_this_automation_ru_e4e978ed"),
      example: input.pipeline.key,
      exampleSource: null,
    },
    {
      key: "pipeline_name",
      label: l10n("local.pipeline_name_5ba23939"),
      description: l10n("local.display_name_of_the_pipeline_this_automation_8e08d669"),
      example: input.pipeline.name,
      exampleSource: null,
    },
    {
      key: "stage_id",
      label: l10n("local.stage_id_449d8bc1"),
      description: l10n("local.id_of_this_automation_stage_1a6b1a39"),
      example: input.stage.id,
      exampleSource: null,
    },
    {
      key: "stage_key",
      label: l10n("local.stage_key_aa600fc4"),
      description: l10n("local.stable_key_of_this_automation_stage_833b1cc1"),
      example: input.stage.key,
      exampleSource: null,
    },
    {
      key: "stage_name",
      label: l10n("local.stage_name_1f31e5b6"),
      description: l10n("local.display_name_of_this_automation_stage_482eb586"),
      example: input.stage.name,
      exampleSource: null,
    },
  ];
  const itemVariables: AutomationVariableOption[] = [
    {
      key: "title",
      label: l10n("local.item_title_8ae08972"),
      description: l10n("local.title_of_the_item_being_automated_8c88b0d3"),
      example: sampleCase?.title ?? "",
      exampleSource,
    },
    {
      key: "body",
      label: l10n("local.item_body_256f4ed7"),
      description: l10n("local.body_text_of_the_item_being_automated_4ca7c36f"),
      example: sampleCase?.summary ?? "",
      exampleSource,
    },
    {
      key: "case_id",
      label: l10n("local.item_id_2e5ffe2c"),
      description: l10n("local.id_of_the_item_being_automated_2e177d4d"),
      example: sampleCase?.id ?? "",
      exampleSource,
    },
    {
      key: "case_key",
      label: l10n("local.item_key_cde9feab"),
      description: l10n("local.stable_key_of_the_item_being_automated_51e54d15"),
      example: sampleCase?.caseKey ?? "",
      exampleSource,
    },
    {
      key: "case_title",
      label: l10n("local.item_title_alias_8be0f3d4"),
      description: l10n("local.compatibility_alias_for_the_item_title_bbc5fab9"),
      example: sampleCase?.title ?? "",
      exampleSource,
    },
    {
      key: "case_version",
      label: l10n("local.item_version_9c9fef79"),
      description: l10n("local.current_item_version_when_the_automation_runs_31f83639"),
      example: sampleCase?.version ?? "",
      exampleSource,
    },
  ];
  const fieldVariables: AutomationVariableOption[] = [];
  const fields = sampleCase?.fields && typeof sampleCase.fields === "object" && !Array.isArray(sampleCase.fields)
    ? sampleCase.fields
    : {};
  for (const [key, value] of Object.entries(fields)) {
    if (INTERNAL_FIELD_KEYS.has(key) || AUTOMATION_ITEM_BUILTIN_KEYS.has(key)) continue;
    fieldVariables.push({
      key,
      label: key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
      description: `Field copied from the current item data.`,
      example: value,
      exampleSource,
    });
  }
  const groups: AutomationVariableGroup[] = [
    { id: "pipeline", label: l10n("local.pipeline_and_stage_a1da6a95"), variables: pipelineVariables },
    { id: "item", label: l10n("local.current_item_542a6937"), variables: itemVariables },
  ];
  if (fieldVariables.length > 0) {
    groups.push({ id: "fields", label: "Item fields", variables: fieldVariables });
  }
  return groups;
}

function flattenAutomationVariableKeys(groups: AutomationVariableGroup[]) {
  return [...new Set(groups.flatMap((group) => group.variables.map((variable) => variable.key)))];
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-3 text-sm sm:grid-cols-(--gtc-41) sm:items-center">
      <div className="font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CarriedFieldTokenHelper({
  groups,
  onInsert,
}: {
  groups: CarryOverFieldGroup[];
  onInsert: (fieldKey: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/25 px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {l10n("local.already_available_on_child_items_8806b5f6")}</span>
      </div>
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{group.label}</span>
              {group.description ? <span> · {group.description}</span> : null}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {group.fields.map((field) => (
                <button
                  key={`${group.id}:${field.key}`}
                  type="button"
                  onClick={() => onInsert(field.key)}
                  className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground transition-colors hover:bg-accent"
                  title={l10n("local.insert_value_b4c258da", {v0: (field.key)})}
                  aria-label={l10n("local.insert_value_b4c258da", {v0: (field.key)})}
                >
                  {`{{${field.key}}}`}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomationVariableTokenHelper({
  groups,
  onInsert,
  label = "Available variables",
}: {
  groups: AutomationVariableGroup[];
  onInsert: (fieldKey: string) => void;
  label?: string;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
            <div className="flex flex-wrap gap-1.5">
              {group.variables.map((variable) => (
                <button
                  key={`${group.id}:${variable.key}`}
                  type="button"
                  onClick={() => onInsert(variable.key)}
                  className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground transition-colors hover:bg-accent"
                  title={automationVariablePreviewTitle(variable)}
                  aria-label={l10n("local.insert_value_b4c258da", {v0: (variable.key)})}
                >
                  {`{{${variable.key}}}`}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageSubSidebar({
  activeSection,
  stageKind,
  onSectionChange,
}: {
  activeSection: StageSectionKey;
  stageKind: string;
  onSectionChange: (section: StageSectionKey) => void;
}) {
  const groups = stageNavGroups(stageKind);
  return (
    <>
      <div className="md:hidden">
        <label className="sr-only" htmlFor="stage-section-picker">{l10n("local.stage_section_b041ad38")}</label>
        <select
          id="stage-section-picker"
          value={activeSection}
          onChange={(event) => onSectionChange(event.target.value as StageSectionKey)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <nav
        aria-label={l10n("local.stage_sections_6c7456b4")}
        className="sticky top-14 hidden max-h-(--sz-calc-39) w-52 shrink-0 flex-col gap-4 self-start overflow-y-auto border-r border-border bg-sidebar/30 px-3 py-4 md:flex"
      >
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/80">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSectionChange(item.id)}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-3 text-left text-sm transition-colors motion-safe:duration-150",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}

function StageEventsList({
  events,
  stages,
  emptyMessage,
}: {
  events: PipelineCompanyCaseEvent[];
  stages: PipelineStage[];
  emptyMessage: string;
}) {
  if (events.length === 0) {
    return <EmptyState icon={ActivityIcon} message={emptyMessage} />;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {events.map((event) => (
        <div
          key={event.id}
          className="grid min-h-11 grid-cols-(--gtc-15) items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-b-0"
        >
          <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
            {relativeTime(event.createdAt)}
          </span>
          <div className="min-w-0">
            <Link
              to={`/pipelines/${event.pipeline.id}/items/${event.caseId}`}
              className="font-medium text-foreground hover:underline"
            >
              {event.case.title}
            </Link>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatPipelineItemEvent(event, stages)}
              {event.actorAgent ? (" " + l10n("local.by_value_c4188371", {v0: (event.actorAgent.name)})) : null}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PipelineSettings() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [activeStageSection, setActiveStageSection] = useState<StageSectionKey>("instructions");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageKind, setStageKind] = useState("open");
  const [newEntriesDisabled, setNewEntriesDisabled] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [stageAssigneeAgentId, setStageAssigneeAgentId] = useState("");
  const [stageProjectId, setStageProjectId] = useState("");
  const [stageProjectWorkspaceId, setStageProjectWorkspaceId] = useState("");
  const [stageExecutionWorkspacePreference, setStageExecutionWorkspacePreference] =
    useState<ExecutionWorkspaceMode | "">("");
  const [stageExecutionWorkspaceId, setStageExecutionWorkspaceId] = useState("");
  const [stageExecutionWorkspaceSettings, setStageExecutionWorkspaceSettings] =
    useState<IssueExecutionWorkspaceSettings | null>(null);
  const [selectedApproval, setSelectedApproval] = useState("any_human");
  const [issueTitleTemplate, setIssueTitleTemplate] = useState<string>(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);
  const [instructionsBody, setInstructionsBody] = useState("");
  const [instructionsVariables, setInstructionsVariables] = useState<RoutineVariable[]>([]);
  const issueTitleTemplateInputRef = useRef<HTMLInputElement>(null);
  const pendingIssueTitleCursorRef = useRef<number | null>(null);
  const instructionsEditorRef = useRef<MarkdownEditorRef>(null);
  // Stage secrets (the automation routine's env). Edited independently of the
  // rest of the stage form and saved through the narrow automation-env route.
  const [stageEnv, setStageEnv] = useState<RoutineEnvConfig>({});
  const [approveTarget, setApproveTarget] = useState("");
  const [rejectTarget, setRejectTarget] = useState("");
  const [requestChangesTarget, setRequestChangesTarget] = useState("");
  const [requireRejectReason, setRequireRejectReason] = useState(true);
  const [requireRequestChangesReason, setRequireRequestChangesReason] = useState(true);
  const [requireChildrenTerminal, setRequireChildrenTerminal] = useState(false);
  const [autoAdvanceOnChildrenTerminal, setAutoAdvanceOnChildrenTerminal] = useState("");
  const [breakdownEnabled, setBreakdownEnabled] = useState(false);
  const [breakdownTargetPipelineId, setBreakdownTargetPipelineId] = useState("");
  const [breakdownTargetStageKey, setBreakdownTargetStageKey] = useState("");
  const [breakdownPieceNoun, setBreakdownPieceNoun] = useState("piece");
  const [breakdownCarryOverPolicy, setBreakdownCarryOverPolicy] = useState<BreakdownCarryOverPolicy>(
    DEFAULT_CARRY_OVER_POLICY,
  );
  const [breakdownAdvanceTo, setBreakdownAdvanceTo] = useState("");
  const [breakdownWaitForPieces, setBreakdownWaitForPieces] = useState(false);
  const [breakdownWhenFinishedMoveTo, setBreakdownWhenFinishedMoveTo] = useState("");
  const [transitionTargets, setTransitionTargets] = useState<Set<string>>(() => new Set());
  const [deleteStageDialogOpen, setDeleteStageDialogOpen] = useState(false);
  const [deleteMoveTargetStageId, setDeleteMoveTargetStageId] = useState("");
  const [pipelineName, setPipelineName] = useState("");
  const [pipelineDescription, setPipelineDescription] = useState("");
  const [strictTransitionsEnabled, setStrictTransitionsEnabled] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });

  const healthQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.health(pipelineId) : ["pipelines", "health", "none"],
    queryFn: () => pipelinesApi.getHealth(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const usersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.companyUserDirectory(selectedCompanyId) : ["access", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const activeProjects = useMemo(
    () => projectsQuery.data ?? [],
    [projectsQuery.data],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  // Company secrets back the Secrets tab — the same inventory used by routines,
  // agents, and projects. We never create a stage-only secret namespace.
  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select an organization to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  // Other pipelines in the workspace power the "Break into pieces" target
  // picker; their stages come back on the list payload so we can offer the
  // entry-stage choices without a second fetch per pipeline.
  const pipelinesListQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "none"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const pipelineCasesQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.cases(pipelineId) : ["pipelines", "cases", "none-settings"],
    queryFn: () => pipelinesApi.listCases(pipelineId!),
    enabled: !!selectedCompanyId && !!pipelineId,
  });

  // The chosen target pipeline's intake form drives the "Carry over" field
  // checkboxes — those are the variables a new piece can be stamped with.
  const breakdownTargetIntakeQuery = useQuery({
    queryKey: breakdownTargetPipelineId
      ? queryKeys.pipelines.intakeForm(breakdownTargetPipelineId)
      : ["pipelines", "intake-form", "none-breakdown"],
    queryFn: () => pipelinesApi.getIntakeForm(breakdownTargetPipelineId),
    enabled: !!selectedCompanyId && !!breakdownTargetPipelineId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(() => sortedStages(pipeline), [pipeline]);
  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0] ?? null;
  const incomingCarryOverFieldGroups = useMemo(
    () => buildIncomingCarryOverFieldGroups(pipeline, selectedStage, pipelinesListQuery.data ?? []),
    [pipeline, pipelinesListQuery.data, selectedStage],
  );
  const incomingCarryOverFieldKeys = useMemo(
    () => [...new Set(flattenCarryOverFields(incomingCarryOverFieldGroups).map((field) => field.key))],
    [incomingCarryOverFieldGroups],
  );
  const sampleCaseRow = useMemo(() => {
    const rows = pipelineCasesQuery.data ?? [];
    return rows.find((row) => row.case.stageId === selectedStage?.id) ?? rows[0] ?? null;
  }, [pipelineCasesQuery.data, selectedStage?.id]);
  const automationVariableGroups = useMemo(
    () => pipeline && selectedStage
      ? buildAutomationVariableGroups({ pipeline, stage: selectedStage, sampleRow: sampleCaseRow })
      : [],
    [pipeline, sampleCaseRow, selectedStage],
  );
  const automationVariableKeys = useMemo(
    () => flattenAutomationVariableKeys(automationVariableGroups),
    [automationVariableGroups],
  );
  const resolvedAutomationVariableKeys = useMemo(
    () => [...new Set([...incomingCarryOverFieldKeys, ...automationVariableKeys])],
    [automationVariableKeys, incomingCarryOverFieldKeys],
  );
  const insertInstructionsVariableToken = useCallback((fieldKey: string) => {
    const token = `{{${fieldKey}}}`;
    if (instructionsEditorRef.current) {
      instructionsEditorRef.current.insertMarkdown(token);
      return;
    }
    setInstructionsBody((current) => `${current}${current ? " " : ""}${token}`);
  }, []);
  const insertIssueTitleVariableToken = useCallback((fieldKey: string) => {
    const token = `{{${fieldKey}}}`;
    setIssueTitleTemplate((current) => {
      const input = issueTitleTemplateInputRef.current;
      if (!input) return `${current}${current ? " " : ""}${token}`;
      const start = input.selectionStart ?? current.length;
      const end = input.selectionEnd ?? start;
      const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
      pendingIssueTitleCursorRef.current = start + token.length;
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const cursor = pendingIssueTitleCursorRef.current;
    if (cursor == null) return;
    pendingIssueTitleCursorRef.current = null;
    const input = issueTitleTemplateInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }, [issueTitleTemplate]);

  const instructionsKey = selectedStage ? stageInstructionsKey(selectedStage.id) : null;
  const instructionsQuery = useQuery({
    queryKey: pipelineId && instructionsKey
      ? queryKeys.pipelines.document(pipelineId, instructionsKey)
      : ["pipelines", "document", "none-stage"],
    queryFn: async () => {
      try {
        return await pipelinesApi.getDocument(pipelineId!, instructionsKey!);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!pipelineId && !!instructionsKey && !!selectedCompanyId,
  });
  const instructionsDocument = instructionsQuery.data ?? null;
  // Routine-backed automation is the source of truth. Per-stage documents and
  // the legacy field remain as read-through fallbacks for older stages.
  const savedInstructionsBody = instructionsDocument
    ? stageAutomation(selectedStage).instructionsBody ?? instructionsDocument.revision?.body ?? instructionsDocument.document?.latestBody ?? ""
    : stageAutomation(selectedStage).instructionsBody ?? stageConfig(selectedStage).whatHappensHere ?? "";
  const savedIssueTitleTemplate = stageAutomation(selectedStage).titleTemplate;
  const savedInstructionsVariables = useMemo(
    () => savedStageVariables(selectedStage, savedIssueTitleTemplate, savedInstructionsBody),
    [selectedStage, savedInstructionsBody, savedIssueTitleTemplate],
  );
  const savedManualVariableNames = useMemo(
    () => manualVariableNamesForTemplate(savedInstructionsVariables, [savedIssueTitleTemplate, savedInstructionsBody]),
    [savedInstructionsBody, savedInstructionsVariables, savedIssueTitleTemplate],
  );

  const mentionOptions = useStandardMarkdownMentionOptions({
    companyId: selectedCompanyId,
    agents: agentsQuery.data,
    projects: projectsQuery.data,
    members: usersQuery.data?.users,
  });
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), []);
  const recentAssigneeOptionIds = useMemo(
    () => recentAssigneeIds.map(stageAssigneeOptionId),
    [recentAssigneeIds],
  );
  const stageAssigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agentsQuery.data ?? []).filter(isAgentTaskTarget),
        recentAssigneeIds,
      ).map((agent) => ({
        id: stageAssigneeOptionId(agent.id),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agentsQuery.data, recentAssigneeIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), []);
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const selectedAutomationProject = useMemo(
    () => orderedProjects.find((project) => project.id === stageProjectId) ?? null,
    [orderedProjects, stageProjectId],
  );
  const selectedAutomationProjectWorkspace = useMemo(
    () =>
      selectedAutomationProject?.workspaces.find((workspace) => workspace.id === stageProjectWorkspaceId)
      ?? null,
    [selectedAutomationProject, stageProjectWorkspaceId],
  );
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const selectedProjectSupportsExecutionWorkspace =
    workspaceIsolationControlsVisible &&
    experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true
    && Boolean(selectedAutomationProject?.executionWorkspacePolicy?.enabled);
  const reusableExecutionWorkspacesQuery = useQuery({
    queryKey: selectedCompanyId && stageProjectId
      ? queryKeys.executionWorkspaces.summaryList(selectedCompanyId, {
          projectId: stageProjectId,
          projectWorkspaceId: stageProjectWorkspaceId || undefined,
          reuseEligible: true,
        })
      : ["execution-workspaces", "summary", "none-pipeline-stage"],
    queryFn: () =>
      executionWorkspacesApi.listSummaries(selectedCompanyId!, {
        projectId: stageProjectId,
        projectWorkspaceId: stageProjectWorkspaceId || undefined,
        reuseEligible: true,
      }),
    enabled:
      Boolean(selectedCompanyId) &&
      Boolean(stageProjectId) &&
      selectedProjectSupportsExecutionWorkspace &&
      stageExecutionWorkspacePreference === "reuse_existing",
  });
  const deduplicatedReusableWorkspaces = useMemo<ExecutionWorkspaceSummary[]>(
    () => orderReusableExecutionWorkspaces(reusableExecutionWorkspacesQuery.data ?? []),
    [reusableExecutionWorkspacesQuery.data],
  );
  const selectedReusableExecutionWorkspace = useMemo(
    () =>
      deduplicatedReusableWorkspaces.find((workspace) => workspace.id === stageExecutionWorkspaceId)
      ?? null,
    [deduplicatedReusableWorkspaces, stageExecutionWorkspaceId],
  );
  const approvalOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...buildCompanyUserInlineOptions(usersQuery.data?.users),
      ...sortAgentsByRecency(
        (agentsQuery.data ?? []).filter(isAgentTaskTarget),
        recentAssigneeIds,
      ).map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agentsQuery.data, recentAssigneeIds, usersQuery.data?.users],
  );
  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
  );
  const healthWarningsByStage = useMemo(
    () => groupWarningsByStage(healthQuery.data?.warnings ?? []),
    [healthQuery.data?.warnings],
  );

  const stageEventsQuery = useQuery({
    queryKey: selectedCompanyId && pipelineId && selectedStage
      ? ["pipelines", "stage-events", selectedCompanyId, pipelineId, selectedStage.id]
      : ["pipelines", "stage-events", "none"],
    queryFn: () => pipelinesApi.listCompanyCaseEvents(selectedCompanyId!, { limit: 75 }),
    enabled:
      !!selectedCompanyId &&
      !!pipelineId &&
      !!selectedStage &&
      activeStageSection === "activity",
  });

  const stageEvents = useMemo(() => {
    if (!selectedStage || !pipelineId) return [];
    return (stageEventsQuery.data?.items ?? []).filter(
      (event) =>
        event.pipeline.id === pipelineId &&
        (
          event.fromStageId === selectedStage.id ||
          event.toStageId === selectedStage.id ||
          event.automation?.stage?.id === selectedStage.id
        ),
    );
  }, [pipelineId, selectedStage, stageEventsQuery.data?.items]);

  useEffect(() => {
    if (!pipeline) return;
    setBreadcrumbs([
      { label: l10n("local.pipelines_d1a8fffe"), href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
      { label: l10n("local.settings_74a883a0") },
    ]);
  }, [pipeline, setBreadcrumbs]);

  // Deep-link from a board-header health warning: ?stage=<id> preselects the
  // flagged stage so the warning's "fix" lands on the right panel.
  const requestedStageId = searchParams.get("stage");
  const requestedStageExists = Boolean(requestedStageId && stages.some((stage) => stage.id === requestedStageId));
  const requestedStageSection = parseStageSectionKey(searchParams.get("section"));
  const fallbackStageId = resolvePipelineSettingsFallbackStageId(stages, selectedStageId, requestedStageId);
  useEffect(() => {
    if (requestedStageId && requestedStageExists) {
      setSelectedStageId(requestedStageId);
    }
  }, [requestedStageExists, requestedStageId]);

  useEffect(() => {
    if (fallbackStageId) {
      setSelectedStageId(fallbackStageId);
    }
  }, [fallbackStageId]);

  useEffect(() => {
    if (!selectedStage) return;
    const form = computeStageForm(selectedStage, pipeline?.transitions ?? []);
    setStageName(form.name);
    setStageKind(form.kind);
    setNewEntriesDisabled(form.newEntriesDisabled);
    setDisableReason(form.disableReason);
    setStageAssigneeAgentId(form.assigneeAgentId);
    setStageProjectId(form.automationProjectId);
    setStageProjectWorkspaceId(form.automationProjectWorkspaceId);
    setStageExecutionWorkspacePreference(form.automationExecutionWorkspacePreference);
    setStageExecutionWorkspaceId(form.automationExecutionWorkspaceId);
    setStageExecutionWorkspaceSettings(form.automationExecutionWorkspaceSettings);
    setIssueTitleTemplate(form.automationTitleTemplate);
    setSelectedApproval(form.approval);
    setApproveTarget(form.approveTarget);
    setRejectTarget(form.rejectTarget);
    setRequestChangesTarget(form.requestChangesTarget);
    setRequireRejectReason(form.requireRejectReason);
    setRequireRequestChangesReason(form.requireRequestChangesReason);
    setRequireChildrenTerminal(form.requireChildrenTerminal);
    setAutoAdvanceOnChildrenTerminal(form.autoAdvanceOnChildrenTerminal);
    setBreakdownEnabled(form.breakdownEnabled);
    setBreakdownTargetPipelineId(form.breakdownTargetPipelineId);
    setBreakdownTargetStageKey(form.breakdownTargetStageKey);
    setBreakdownPieceNoun(form.breakdownPieceNoun);
    setBreakdownCarryOverPolicy(form.breakdownCarryOverPolicy);
    setBreakdownAdvanceTo(form.breakdownAdvanceTo);
    setBreakdownWaitForPieces(form.breakdownWaitForPieces);
    setBreakdownWhenFinishedMoveTo(form.breakdownWhenFinishedMoveTo);
    setTransitionTargets(new Set(form.transitionTargetIds));
  }, [pipeline?.transitions, selectedStage]);

  useEffect(() => {
    if (!stageProjectId || !selectedAutomationProject) return;
    if (!stageProjectWorkspaceId) {
      setStageProjectWorkspaceId(defaultProjectWorkspaceIdForProject(selectedAutomationProject));
    }
    if (workspaceIsolationControlsVisible && !stageExecutionWorkspacePreference) {
      setStageExecutionWorkspacePreference(defaultExecutionWorkspaceModeForProject(selectedAutomationProject));
    }
  }, [
    selectedAutomationProject,
    workspaceIsolationControlsVisible,
    stageExecutionWorkspacePreference,
    stageProjectId,
    stageProjectWorkspaceId,
  ]);

  useEffect(() => {
    if (!selectedStage) return;
    if (requestedStageSection && isPipelineSettingsStageSectionAvailable(selectedStage.kind, requestedStageSection)) {
      setActiveStageSection(requestedStageSection);
    }
  }, [requestedStageSection, selectedStage?.id, selectedStage?.kind]);

  useEffect(() => {
    if (!selectedStage) return;
    if (!isPipelineSettingsStageSectionAvailable(selectedStage.kind, activeStageSection)) {
      setActiveStageSection("instructions");
    }
  }, [activeStageSection, requestedStageSection, selectedStage]);

  // Instructions body + title + variables hydrate from the backing automation
  // routine (or legacy fields). Resetting on the saved value clears dirty after
  // save/reload.
  useEffect(() => {
    setIssueTitleTemplate(savedIssueTitleTemplate);
    setInstructionsBody(savedInstructionsBody);
    setInstructionsVariables(savedInstructionsVariables);
  }, [selectedStage?.id, savedInstructionsBody, savedInstructionsVariables, savedIssueTitleTemplate]);

  // Stage secrets hydrate from the backing routine's derived env. Re-running on
  // the serialized saved env clears the dirty state after a save/refetch.
  const savedStageEnv = stageAutomationDetail(selectedStage).env;
  const savedStageEnvKey = JSON.stringify(savedStageEnv ?? {});
  useEffect(() => {
    setStageEnv((savedStageEnv ?? {}) as RoutineEnvConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStage?.id, savedStageEnvKey]);

  useEffect(() => {
    setDeleteStageDialogOpen(false);
    setDeleteMoveTargetStageId(stages.find((stage) => stage.id !== selectedStage?.id)?.id ?? "");
  }, [selectedStage?.id, stages]);

  useEffect(() => {
    if (!pipeline) return;
    setPipelineName(pipeline.name);
    setPipelineDescription(pipeline.description ?? "");
    setStrictTransitionsEnabled(pipeline.enforceTransitions);
  }, [pipeline]);

  const refreshPipeline = async () => {
    if (!pipelineId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.health(pipelineId) });
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage || !pipeline) return null;
      if (
        stageProjectId &&
        selectedProjectSupportsExecutionWorkspace &&
        stageExecutionWorkspacePreference === "reuse_existing" &&
        !stageExecutionWorkspaceId
      ) {
        throw new Error("Choose an existing workspace before saving this stage.");
      }
      const parsedApproval = parseApprovalValue(selectedApproval);
      const nextRequiresApproval = stageKind === "review";
      const config: StageConfig = {
        ...stageConfig(selectedStage),
        variables: stripVariablesByName(instructionsVariables, resolvedAutomationVariableKeys),
        disabled: newEntriesDisabled,
        disabledReason: newEntriesDisabled ? disableReason.trim() || null : null,
        automation: buildStageAutomationForSave({
          assigneeAgentId: stageAssigneeAgentId,
          titleTemplate: issueTitleTemplate,
          instructionsBody,
          projectId: stageProjectId,
          projectWorkspaceId: stageProjectWorkspaceId,
          executionWorkspaceId: stageExecutionWorkspaceId,
          executionWorkspacePreference: stageExecutionWorkspacePreference,
          executionWorkspaceSettings: currentAutomationExecutionWorkspaceSettings,
        }),
        requireApproval: nextRequiresApproval,
        approver: nextRequiresApproval && parsedApproval.kind !== "any_human"
          ? { kind: parsedApproval.kind, id: parsedApproval.id }
          : { kind: "any_human" },
        requireChildrenTerminal,
      };
      if (autoAdvanceOnChildrenTerminal) {
        config.autoAdvanceOnChildrenTerminal = autoAdvanceOnChildrenTerminal;
      } else {
        delete config.autoAdvanceOnChildrenTerminal;
      }
      // "Break into pieces" folds the children gate (wait + then-move-to) into
      // its own config block; the standalone requireChildrenTerminal /
      // autoAdvanceOnChildrenTerminal fields are derived from it server-side, so
      // we drop them here to avoid two competing sources of truth.
      if (breakdownEnabled && breakdownTargetPipelineId && breakdownTargetStageKey) {
        config.breakdown = {
          targetPipelineId: breakdownTargetPipelineId,
          targetStageKey: breakdownTargetStageKey,
          pieceNoun: breakdownPieceNoun.trim() || "piece",
          carryOverPolicy: carryOverPolicyForSave(breakdownCarryOverPolicy, breakdownCarryOverFieldOptions),
          inheritFields: inheritFieldsForSave(breakdownCarryOverPolicy, breakdownCarryOverFieldOptions),
          waitForPieces: breakdownWaitForPieces,
          ...(breakdownAdvanceTo ? { advanceTo: breakdownAdvanceTo } : {}),
          ...(breakdownWaitForPieces && breakdownWhenFinishedMoveTo
            ? { whenFinishedMoveTo: breakdownWhenFinishedMoveTo }
            : {}),
        };
        delete config.requireChildrenTerminal;
        delete config.autoAdvanceOnChildrenTerminal;
      } else {
        delete config.breakdown;
      }
      // The approval model replaces the legacy reviewerKind input.
      delete config.reviewerKind;
      if (stageKind === "review") {
        config.approveToStageKey = approveTarget;
        config.rejectToStageKey = rejectTarget;
        if (requestChangesTarget) {
          config.requestChangesToStageKey = requestChangesTarget;
        } else {
          delete config.requestChangesToStageKey;
        }
        config.requireRejectReason = requireRejectReason;
        config.requireRequestChangesReason = requireRequestChangesReason;
      }

      const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
      const existingTransitions = pipeline.transitions ?? [];
      const retainedEdges = existingTransitions
        .filter((transition) => transition.fromStageId !== selectedStage.id)
        .flatMap((transition) => {
          const fromStageKey = keyById.get(transition.fromStageId);
          const toStageKey = keyById.get(transition.toStageId);
          if (!fromStageKey || !toStageKey) return [];
          return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
        });
      // Effective "allowed next steps". For review stages the connections are
      // kept in sync with the review outcomes (approve / decline / changes)
      // instead of a separate picker. For non-review stages, manual transition
      // edges are only edited while strict transition enforcement is enabled.
      const keyToId = new Map(stages.map((stage) => [stage.key, stage.id]));
      const effectiveTargetIds = new Set<string>(
        stageKind === "review"
          ? [approveTarget, rejectTarget, requestChangesTarget]
              .map((key) => keyToId.get(key))
              .filter((id): id is string => Boolean(id))
          : strictTransitionsEnabled
            ? transitionTargets
            : [],
      );
      for (const stage of stages) {
        if (stage.kind === "cancelled" && stage.id !== selectedStage.id) {
          effectiveTargetIds.add(stage.id);
        }
      }
      const selectedEdges = [...effectiveTargetIds].flatMap((targetId) => {
        const toStageKey = keyById.get(targetId);
        if (!toStageKey) return [];
        const prior = existingTransitions.find(
          (transition) => transition.fromStageId === selectedStage.id && transition.toStageId === targetId,
        );
        return [{ fromStageKey: selectedStage.key, toStageKey, label: prior?.label ?? null }];
      });

      await pipelinesApi.updateStage(pipelineId, selectedStage.id, {
        name: stageName.trim(),
        kind: stageKind,
        config,
      });
      if (stageKind === "review" || strictTransitionsEnabled) {
        await pipelinesApi.setTransitions(pipelineId, {
          transitions: dedupeEdges([...retainedEdges, ...selectedEdges]),
        });
      }
      return null;
    },
    onSuccess: async () => {
      if (pipelineId && instructionsKey) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.document(pipelineId, instructionsKey) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.documentRevisions(pipelineId, instructionsKey) }),
        ]);
      }
      await refreshPipeline();
      pushToast({ title: l10n("local.stage_saved_9d908412"), tone: "success" });
    },
    onError: async (error) => {
      pushToast({
        title: l10n("local.failed_to_save_stage_fb320870"),
        body: error instanceof Error ? error.message : l10n("local.paperclip_could_not_save_the_stage_0d715db6"),
        tone: "error",
      });
    },
  });

  // Secrets save through the narrow automation-env route so it only touches the
  // routine's env (and secret bindings) — never the rest of the stage config.
  const saveStageEnv = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage) return null;
      const detail = stageAutomationDetail(selectedStage);
      const env = Object.keys(stageEnv).length > 0 ? stageEnv : null;
      await pipelinesApi.updateStageAutomationEnv(pipelineId, selectedStage.id, {
        env,
        baseRoutineRevisionId: detail.latestRoutineRevisionId,
      });
      return null;
    },
    onSuccess: async () => {
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
      }
      pushToast({ title: l10n("local.stage_secrets_saved_571b2128"), tone: "success" });
    },
    onError: async (error) => {
      pushToast({
        title: l10n("local.failed_to_save_secrets_3e524597"),
        body: error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : l10n("local.paperclip_could_not_save_the_stage_secrets_a9015389"),
        tone: "error",
      });
    },
  });

  const addStage = useMutation({
    mutationFn: async (afterStage: PipelineStage | null) => {
      if (!pipelineId || !pipeline) return null;
      const lastStage = stages[stages.length - 1] ?? null;
      const insertPosition = afterStage ? afterStage.position + 1 : (lastStage ? lastStage.position + 100 : 100);
      const nextStage = afterStage
        ? stages.find((stage) => stage.position > afterStage.position) ?? null
        : null;
      const existingKeys = new Set(stages.map((stage) => stage.key));
      const autoAdvanceTarget = nextStageForInsert(stages, insertPosition);
      const created = await pipelinesApi.createStage(pipelineId, {
        key: nextStageKey("New stage", existingKeys),
        name: "New stage",
        kind: "working",
        position: insertPosition,
        config: {
          variables: [],
          requireChildrenTerminal: true,
          ...(autoAdvanceTarget ? { autoAdvanceOnChildrenTerminal: autoAdvanceTarget.key } : {}),
        },
      });
      if (afterStage) {
        const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
        const existingTransitions = pipeline.transitions ?? [];
        const edges = existingTransitions
          .filter(
            (transition) => !(nextStage && transition.fromStageId === afterStage.id && transition.toStageId === nextStage.id),
          )
          .flatMap((transition) => {
            const fromStageKey = keyById.get(transition.fromStageId);
            const toStageKey = keyById.get(transition.toStageId);
            if (!fromStageKey || !toStageKey) return [];
            return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
          });
        edges.push({ fromStageKey: afterStage.key, toStageKey: created.key, label: null });
        if (nextStage) {
          edges.push({ fromStageKey: created.key, toStageKey: nextStage.key, label: null });
        }
        await pipelinesApi.setTransitions(pipelineId, { transitions: dedupeEdges(edges) });
      }
      return created;
    },
    onSuccess: async (created) => {
      await refreshPipeline();
      if (created) {
        setSelectedStageId(created.id);
      }
      pushToast({ title: l10n("local.stage_added_76d5ac5d"), tone: "success" });
    },
  });

  const deleteStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage) return null;
      return pipelinesApi.deleteStage(pipelineId, selectedStage.id, {
        moveCasesToStageId: deleteMoveTargetStageId || null,
      });
    },
    onSuccess: async () => {
      const nextStageId = deleteMoveTargetStageId || (stages.find((stage) => stage.id !== selectedStage?.id)?.id ?? null);
      setDeleteStageDialogOpen(false);
      setSelectedStageId(nextStageId);
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      pushToast({ title: l10n("local.stage_deleted_004d66bc"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.failed_to_delete_stage_0bfd9c20"),
        body: error instanceof Error ? error.message : l10n("local.paperclip_could_not_delete_the_stage_df312840"),
        tone: "error",
      });
    },
  });

  const savePipelineDetails = useMutation({
    mutationFn: () =>
      pipelinesApi.update(pipelineId!, {
        name: pipelineName.trim(),
        description: pipelineDescription.trim() || null,
      }),
    onSuccess: async () => {
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      pushToast({ title: l10n("local.pipeline_updated_d3eb589b"), tone: "success" });
    },
  });

  const saveStrictTransitions = useMutation({
    mutationFn: (enforceTransitions: boolean) =>
      pipelinesApi.update(pipelineId!, { enforceTransitions }),
    onSuccess: async () => {
      await refreshPipeline();
      pushToast({ title: l10n("local.transition_rules_updated_6b35ef56"), tone: "success" });
    },
    onError: (error) => {
      setStrictTransitionsEnabled(pipeline?.enforceTransitions ?? false);
      pushToast({
        title: l10n("local.failed_to_update_transition_rules_aa35c7df"),
        body: error instanceof Error ? error.message : l10n("local.paperclip_could_not_update_transition_rules_bda1d620"),
        tone: "error",
      });
    },
  });

  const archivePipeline = useMutation({
    mutationFn: (archived: boolean) => pipelinesApi.update(pipelineId!, { archived }),
    onSuccess: async (_result, archived) => {
      setArchiveDialogOpen(false);
      setArchiveConfirmation("");
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      if (archived) {
        navigate("/pipelines");
      } else {
        await refreshPipeline();
        pushToast({ title: l10n("local.pipeline_restored_05912fab"), tone: "success" });
      }
    },
  });

  const setStageKindWithDefaults = (kind: string) => {
    setStageKind(kind);
    if (kind === "review") {
      setApproveTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "done"));
      setRejectTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "cancelled"));
    }
  };

  const handleAutomationProjectChange = (nextProjectId: string) => {
    if (nextProjectId) trackRecentProject(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    setStageProjectId(nextProjectId);
    setStageProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
    setStageExecutionWorkspacePreference(nextProject && workspaceIsolationControlsVisible ? defaultExecutionWorkspaceModeForProject(nextProject) : "");
    setStageExecutionWorkspaceId("");
    setStageExecutionWorkspaceSettings(null);
  };

  const handleAutomationProjectWorkspaceChange = (nextProjectWorkspaceId: string) => {
    setStageProjectWorkspaceId(nextProjectWorkspaceId);
    setStageExecutionWorkspaceId("");
    setStageExecutionWorkspaceSettings(null);
  };

  const handleAutomationExecutionWorkspacePreferenceChange = (nextPreference: string) => {
    const preference = nullableExecutionWorkspaceMode(nextPreference);
    setStageExecutionWorkspacePreference(preference);
    setStageExecutionWorkspaceSettings(null);
    if (preference !== "reuse_existing") {
      setStageExecutionWorkspaceId("");
    }
  };

  const handleAutomationExecutionWorkspaceIdChange = (nextExecutionWorkspaceId: string) => {
    setStageExecutionWorkspaceId(nextExecutionWorkspaceId);
    const workspace = deduplicatedReusableWorkspaces.find((entry) => entry.id === nextExecutionWorkspaceId) ?? null;
    setStageExecutionWorkspaceSettings(executionWorkspaceSettingsForPreference("reuse_existing", workspace));
  };

  const handleStageSectionChange = (section: StageSectionKey) => {
    setActiveStageSection(section);
    const nextSearchParams = new URLSearchParams(searchParams);
    if (selectedStage?.id) {
      nextSearchParams.set("stage", selectedStage.id);
    }
    nextSearchParams.set("section", section);
    navigate(`/pipelines/${pipelineId}/settings?${nextSearchParams.toString()}`, { replace: true });
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select an organization to edit pipeline settings." />;
  }

  if (!pipelineId) {
    return <EmptyState icon={Hexagon} message="No pipeline selected." />;
  }

  if (pipelineQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (pipelineQuery.error) {
    return <p className="text-sm text-destructive">{pipelineQuery.error.message}</p>;
  }

  if (!pipeline) {
    return <EmptyState icon={Hexagon} message="Pipeline not found." />;
  }

  const isArchived = Boolean(pipeline.archivedAt);
  const archiveEnabled = archiveConfirmation === pipeline.name && !archivePipeline.isPending;
  const detailsDirty = pipelineName !== pipeline.name || pipelineDescription !== (pipeline.description ?? "");
  const reviewTargetsMissing = stageKind === "review" && (!approveTarget || !rejectTarget);
  const otherStages = stages.filter((stage) => stage.id !== selectedStage?.id);
  const isReviewStage = stageKind === "review";
  const defaultAutoAdvanceStage = nextStageByPosition(stages, selectedStage) ?? otherStages[0] ?? null;
  const currentAutomationExecutionWorkspaceSettings =
    stageProjectId && stageExecutionWorkspacePreference
      ? (
          stageExecutionWorkspaceSettings
          ?? executionWorkspaceSettingsForPreference(stageExecutionWorkspacePreference, selectedReusableExecutionWorkspace)
        )
      : null;
  const canSaveAutomationWorkspace =
    !selectedProjectSupportsExecutionWorkspace ||
    stageExecutionWorkspacePreference !== "reuse_existing" ||
    Boolean(stageExecutionWorkspaceId);

  const savedStageForm = selectedStage
    ? computeStageForm(selectedStage, pipeline.transitions ?? [])
    : null;
  const currentStageForm: StageFormValues | null = selectedStage
    ? {
        name: stageName,
        kind: stageKind,
        newEntriesDisabled,
        disableReason,
        assigneeAgentId: stageAssigneeAgentId,
        approvalRequired: stageKind === "review",
        approval: selectedApproval,
        approveTarget,
        rejectTarget,
        requestChangesTarget,
        requireRejectReason,
        requireRequestChangesReason,
        requireChildrenTerminal,
        autoAdvanceOnChildrenTerminal,
        breakdownEnabled,
        breakdownTargetPipelineId,
        breakdownTargetStageKey,
        breakdownPieceNoun,
        breakdownCarryOverPolicy,
        breakdownAdvanceTo,
        breakdownWaitForPieces,
        breakdownWhenFinishedMoveTo,
        transitionTargetIds: [...transitionTargets].sort(),
        automationProjectId: stageProjectId,
        automationProjectWorkspaceId: stageProjectId ? stageProjectWorkspaceId : "",
        automationExecutionWorkspaceId:
          stageProjectId && stageExecutionWorkspacePreference === "reuse_existing" ? stageExecutionWorkspaceId : "",
        automationExecutionWorkspacePreference: stageProjectId ? stageExecutionWorkspacePreference : "",
        automationExecutionWorkspaceSettings: currentAutomationExecutionWorkspaceSettings,
        automationTitleTemplate: pipelineAutomationTitleTemplate(issueTitleTemplate),
      }
    : null;
  const selectedStageKindOption =
    STAGE_KIND_OPTIONS.find((option) => option.value === stageKind) ?? STAGE_KIND_OPTIONS[0]!;
  const SelectedStageKindIcon = selectedStageKindOption.icon;
  const issueTitleTemplateDirty =
    selectedStage != null && pipelineAutomationTitleTemplate(issueTitleTemplate) !== savedIssueTitleTemplate;
  const instructionsBodyDirty = selectedStage != null && instructionsBody !== savedInstructionsBody;
  const variablesDirty =
    selectedStage != null &&
    JSON.stringify(stripVariablesByName(stripVariableEditorMetadata(instructionsVariables), resolvedAutomationVariableKeys)) !==
      JSON.stringify(stripVariablesByName(savedInstructionsVariables, resolvedAutomationVariableKeys));
  const selectedAutomationAgent = stageAssigneeAgentId ? agentById.get(stageAssigneeAgentId) ?? null : null;
  const stageEnvDirty = selectedStage != null && JSON.stringify(stageEnv) !== savedStageEnvKey;
  const stageDirty =
    (savedStageForm != null &&
      currentStageForm != null &&
      JSON.stringify(savedStageForm) !== JSON.stringify(currentStageForm)) ||
    issueTitleTemplateDirty ||
    instructionsBodyDirty ||
    variablesDirty;

  // --- "Break into pieces" derived values -------------------------------
  const breakdownTargetOptions = (pipelinesListQuery.data ?? []).filter(
    (candidate) => candidate.id !== pipelineId && !candidate.archivedAt,
  );
  const breakdownTargetPipeline = breakdownTargetOptions.find((candidate) => candidate.id === breakdownTargetPipelineId)
    ?? (pipelinesListQuery.data ?? []).find((candidate) => candidate.id === breakdownTargetPipelineId)
    ?? null;
  const breakdownTargetStages = [...(breakdownTargetPipeline?.stages ?? [])].sort(
    (left, right) => left.position - right.position,
  );
  const breakdownEntryStage = breakdownTargetStages.find((stage) => stage.key === breakdownTargetStageKey) ?? null;
  const breakdownCarryOverFieldGroups = buildCarryOverFieldGroups(pipeline, pipelinesListQuery.data ?? []);
  const breakdownCarryOverFieldOptions = flattenCarryOverFields(breakdownCarryOverFieldGroups);
  const breakdownSelectedCarryOverFields = breakdownCarryOverFieldOptions.filter((field) =>
    isCarryOverFieldEnabled(breakdownCarryOverPolicy, field.key),
  );
  const breakdownTargetFieldByKey = new Map(
    (breakdownTargetIntakeQuery.data?.fields ?? []).map((field) => [field.key, field]),
  );
  const breakdownIntakeStageName =
    breakdownTargetIntakeQuery.data?.stageName ?? breakdownEntryStage?.name ?? null;
  const breakdownIntakeStageId = breakdownTargetIntakeQuery.data?.stageId ?? null;
  const breakdownTargetArchived = Boolean(breakdownTargetPipeline?.archivedAt);
  const breakdownIntakeSettingsHref = breakdownTargetPipelineId
    ? `/pipelines/${breakdownTargetPipelineId}/settings${breakdownIntakeStageId ? `?stage=${breakdownIntakeStageId}` : ""}`
    : null;
  const breakdownPieceNounPlural = pieceNounPlural(breakdownPieceNoun);
  const stageKeyToName = new Map(stages.map((stage) => [stage.key, stage.name]));
  const breakdownCopyNames: BreakdownCopyNames = {
    targetPipelineName: breakdownTargetPipeline?.name ?? "",
    entryStageName: breakdownEntryStage?.name ?? breakdownTargetStageKey,
    advanceToName: breakdownAdvanceTo ? stageKeyToName.get(breakdownAdvanceTo) ?? breakdownAdvanceTo : null,
    whenFinishedName: breakdownWhenFinishedMoveTo
      ? stageKeyToName.get(breakdownWhenFinishedMoveTo) ?? breakdownWhenFinishedMoveTo
      : null,
    inheritedFieldLabels: breakdownSelectedCarryOverFields.map((field) => field.label),
  };
  const breakdownConfigForCopy = {
    targetPipelineId: breakdownTargetPipelineId,
    targetStageKey: breakdownTargetStageKey,
    pieceNoun: breakdownPieceNoun.trim() || "piece",
    inheritFields: breakdownSelectedCarryOverFields.map((field) => field.key),
    carryOverPolicy: carryOverPolicyForSave(breakdownCarryOverPolicy, breakdownCarryOverFieldOptions),
    advanceTo: breakdownAdvanceTo || null,
    waitForPieces: breakdownWaitForPieces,
    whenFinishedMoveTo: breakdownWhenFinishedMoveTo || null,
  };
  const breakdownSummary = breakdownEnabled
    ? breakdownSummarySentence(breakdownConfigForCopy, breakdownCopyNames)
    : null;
  const transitionTargetsControl = !isReviewStage && !isPipelineTerminalStageKind(stageKind) ? (
    <FieldRow label={l10n("local.allowed_next_steps_729b8a76")}>
      <div className="space-y-2">
        {otherStages.map((stage) => {
          const isCancelled = stage.kind === "cancelled";
          const checked = isCancelled || transitionTargets.has(stage.id);
          return (
            <label
              key={stage.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm",
                isCancelled && "text-muted-foreground",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={isCancelled}
                onChange={(event) => {
                  if (isCancelled) return;
                  setTransitionTargets((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(stage.id);
                    else next.delete(stage.id);
                    return next;
                  });
                }}
              />
              <span className="flex-1">{stage.name}</span>
              {isCancelled ? (
                <span className="text-xs text-muted-foreground">{l10n("local.always_available_0fda3772")}</span>
              ) : null}
            </label>
          );
        })}
      </div>
    </FieldRow>
  ) : null;
  const breakdownSettingsCard = !isPipelineTerminalStageKind(stageKind) ? (
    <div className="rounded-lg border border-border">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{l10n("local.break_into_smaller_pieces_02bc4068")}</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            {l10n("local.the_agent_decides_what_the_pieces_are_papercl_d8c8e5d1")}</p>
        </div>
        <ToggleSwitch
          aria-label={l10n("local.break_into_smaller_pieces_02bc4068")}
          checked={breakdownEnabled}
          onCheckedChange={(checked) => {
            setBreakdownEnabled(checked);
            if (checked && !breakdownAdvanceTo) {
              setBreakdownAdvanceTo(defaultAutoAdvanceStage?.key ?? "");
            }
          }}
        />
      </div>
      {breakdownEnabled ? (
        <div className="divide-y divide-border px-4">
          <FieldRow label={l10n("local.create_each_piece_in_f762f68b")}>
            <div className="space-y-1">
              <div className="flex w-full max-w-sm items-center">
                <select
                  aria-label={l10n("local.create_each_piece_in_f762f68b")}
                  value={breakdownTargetPipelineId}
                  onChange={(event) => {
                    setBreakdownTargetPipelineId(event.target.value);
                    setBreakdownTargetStageKey("");
                  }}
                  className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">{l10n("local.choose_a_pipeline_4309efab")}</option>
                  {breakdownTargetOptions.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
                </select>
                {breakdownTargetPipelineId ? (
                  <Link
                    to={`/pipelines/${breakdownTargetPipelineId}`}
                    aria-label={l10n("local.open_value_pipeline_bcc106d4", {v0: (breakdownTargetPipeline?.name ?? "selected")})}
                    title={l10n("local.open_value_pipeline_bcc106d4", {v0: (breakdownTargetPipeline?.name ?? "selected")})}
                    className="ml-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ArrowUpRight className="h-4 w-4" />
                  </Link>
                ) : null}
              </div>
              {!breakdownTargetPipelineId ? (
                <p className="text-xs text-muted-foreground">{l10n("local.a_pipeline_in_this_workspace_a641cac6")}</p>
              ) : null}
            </div>
          </FieldRow>
          <FieldRow label={l10n("local.starting_at_491013df")}>
            <div className="space-y-1">
              <select
                aria-label={l10n("local.starting_stage_for_each_piece_2570eccd")}
                value={breakdownTargetStageKey}
                onChange={(event) => setBreakdownTargetStageKey(event.target.value)}
                disabled={!breakdownTargetPipelineId}
                className="h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
              >
                <option value="">{l10n("local.choose_a_stage_15a9299c")}</option>
                {breakdownTargetStages.map((stage) => (
                  <option key={stage.id} value={stage.key}>{stage.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{l10n("local.the_stage_every_new_piece_starts_in_af7d5503")}</p>
            </div>
          </FieldRow>
          <FieldRow label={l10n("local.call_each_piece_a_bc98a4c1")}>
            <div className="space-y-1">
              <Input
                aria-label={l10n("local.call_each_piece_a_bc98a4c1")}
                value={breakdownPieceNoun}
                onChange={(event) => setBreakdownPieceNoun(event.target.value)}
                placeholder={l10n("local.piece_34235a2c")}
                className="h-10 w-full max-w-sm"
              />
              <p className="text-xs text-muted-foreground">
                {l10n("local.drives_copy_on_this_case_e_g_3_of_5_e3d8908b")}{" "}{breakdownPieceNounPlural} {l10n("local.finished_89269f0e")}</p>
            </div>
          </FieldRow>
          <FieldRow label={l10n("local.carry_over_585af0c1")}>
            <div className="space-y-2">
              <div className="space-y-1 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs">
                <p className="text-muted-foreground">
                  {l10n("local.values_are_copied_from_this_item_and_its_ance_184a0537")}</p>
                {breakdownTargetPipelineId ? (
                  <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                    <span>{l10n("local.destination_validation_9ece9648")}</span>
                    <span className="font-medium text-foreground">
                      {breakdownTargetPipeline?.name ?? l10n("local.selected_pipeline_e3efb28b")}
                    </span>
                    {breakdownIntakeStageName ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="font-medium text-foreground">{breakdownIntakeStageName}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {breakdownIntakeSettingsHref ? (
                  <Link
                    to={breakdownIntakeSettingsHref}
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    {l10n("local.review_destination_fields_aa31913e")}<ArrowUpRight className="h-3 w-3" />
                  </Link>
                ) : null}
                {breakdownTargetArchived ? (
                  <p className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
                    <Archive className="h-3 w-3 shrink-0" />
                    {l10n("local.this_destination_pipeline_is_archived_so_its_df5ba304")}</p>
                ) : null}
              </div>
              {breakdownCarryOverFieldGroups.length > 0 ? (
                <div className="space-y-3">
                  {breakdownCarryOverFieldGroups.map((group) => (
                    <div key={group.id} className="space-y-1.5">
                      <div className="text-xs font-medium text-muted-foreground">
                        {group.label}
                        {group.description ? (
                          <span className="ml-1 font-normal">· {group.description}</span>
                        ) : null}
                      </div>
                      <div className="space-y-1.5">
                        {group.fields.map((field) => {
                          const checked = isCarryOverFieldEnabled(breakdownCarryOverPolicy, field.key);
                          const targetField = breakdownTargetFieldByKey.get(field.key);
                          return (
                            <label
                              key={`${group.id}:${field.key}`}
                              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  setBreakdownCarryOverPolicy((current) =>
                                    toggleCarryOverField(
                                      current,
                                      breakdownCarryOverFieldOptions,
                                      field.key,
                                      event.target.checked,
                                    ),
                                  );
                                }}
                              />
                              <span className="flex-1">{field.label}</span>
                              {targetField?.required ? (
                                <span className="text-xs text-muted-foreground">
                                  {l10n("local.required_by_9bab66cb")}{" "}{breakdownTargetPipeline?.name ?? l10n("local.destination_b5c755aa")}
                                </span>
                              ) : targetField ? (
                                <span className="text-xs text-muted-foreground">
                                  {l10n("local.validated_by_0156ee46")}{" "}{breakdownTargetPipeline?.name ?? l10n("local.destination_b5c755aa")}
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {breakdownCarryOverFieldGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {l10n("local.this_pipeline_and_its_ancestors_do_not_define_864a4679")}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {l10n("local.name_and_title_fields_are_kept_unique_for_eac_17ea3976")}{" "}{breakdownPieceNoun.trim() || l10n("local.piece_34235a2c")}.
              </p>
            </div>
          </FieldRow>
          <FieldRow label={l10n("local.then_move_this_case_to_6eb8ce44")}>
            <div className="space-y-1">
              <select
                aria-label={l10n("local.then_move_this_case_to_6eb8ce44")}
                value={breakdownAdvanceTo}
                onChange={(event) => setBreakdownAdvanceTo(event.target.value)}
                className="h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">{l10n("local.stay_on_this_step_d9c0a2a6")}</option>
                {otherStages.map((stage) => (
                  <option key={stage.id} value={stage.key}>{stage.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{l10n("local.as_soon_as_the_pieces_are_created_cc5a44dc")}</p>
            </div>
          </FieldRow>
          <FieldRow label={l10n("local.wait_26b83994")}>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={breakdownWaitForPieces}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setBreakdownWaitForPieces(checked);
                    if (checked && !breakdownWhenFinishedMoveTo) {
                      setBreakdownWhenFinishedMoveTo(breakdownAdvanceTo || defaultAutoAdvanceStage?.key || "");
                    }
                  }}
                />
                <span className="font-medium text-foreground">
                  {l10n("local.wait_until_all_ee422050")}{" "}{breakdownPieceNounPlural} {l10n("local.are_finished_then_move_it_to_c335ae64")}</span>
              </label>
              <select
                aria-label={l10n("local.move_this_case_when_all_pieces_finish_53f2c1bd")}
                value={breakdownWhenFinishedMoveTo}
                onChange={(event) => setBreakdownWhenFinishedMoveTo(event.target.value)}
                disabled={!breakdownWaitForPieces}
                className="h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
              >
                <option value="">{l10n("local.choose_a_stage_15a9299c")}</option>
                {otherStages.map((stage) => (
                  <option key={stage.id} value={stage.key}>{stage.name}</option>
                ))}
              </select>
              {breakdownAdvanceTo ? (
                <p className="text-xs text-muted-foreground">
                  {l10n("local.if_nothing_is_worth_splitting_this_case_still_80d81bd2")}{" "}{breakdownCopyNames.advanceToName}.
                </p>
              ) : null}
            </div>
          </FieldRow>
          {breakdownSummary ? (
            <div className="py-4">
              <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                {breakdownSummary}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <form
        className="border-b border-border pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          savePipelineDetails.mutate();
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <Link to={`/pipelines/${pipeline.id}`} className="text-sm text-muted-foreground hover:text-foreground">
            {l10n("local.back_to_board_b58959bb")}</Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8" title={l10n("local.pipeline_actions_b6de8e33")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isArchived ? (
                <DropdownMenuItem onSelect={() => archivePipeline.mutate(false)}>
                  <Archive className="h-4 w-4" />
                  {l10n("local.restore_pipeline_689140b1")}</DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => setArchiveDialogOpen(true)}>
                  <Archive className="h-4 w-4" />
                  {l10n("local.archive_pipeline_959e7cee")}</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="grid gap-3 md:grid-cols-(--gtc-13) md:items-end">
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span className="sr-only">{l10n("local.pipeline_name_5ba23939")}</span>
              <Input
                aria-label={l10n("local.pipeline_name_5ba23939")}
                value={pipelineName}
                onChange={(event) => setPipelineName(event.target.value)}
                required
                className="h-auto border-0 bg-transparent px-0 py-0 text-2xl font-semibold tracking-normal shadow-none focus-visible:ring-0"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span className="sr-only">{l10n("local.pipeline_description_65e6d866")}</span>
              <Textarea
                aria-label={l10n("local.pipeline_description_65e6d866")}
                value={pipelineDescription}
                onChange={(event) => setPipelineDescription(event.target.value)}
                rows={2}
                placeholder={l10n("local.add_a_description_e707b452")}
                className="min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0"
              />
            </label>
          </div>
          {detailsDirty || savePipelineDetails.isPending ? (
            <Button type="submit" disabled={savePipelineDetails.isPending || !pipelineName.trim()}>
              <Save className="h-4 w-4" />
              {savePipelineDetails.isPending ? l10n("local.saving_dc85af8f") : l10n("local.save_details_bb76faab")}
            </Button>
          ) : null}
        </div>
        {savePipelineDetails.error ? (
          <p className="mt-3 text-sm text-destructive">{savePipelineDetails.error.message}</p>
        ) : null}
      </form>

      <div className="space-y-6">
          {stages.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              message="No stages configured."
              action="Add first stage"
              onAction={() => addStage.mutate(null)}
            />
          ) : (
            <div className="overflow-x-auto border-y border-border py-4">
              <div className="flex min-w-max items-center gap-2">
                {stages.map((stage, index) => {
                  const warningCount = healthWarningsByStage[stage.id]?.length ?? 0;
                  const canInsertAfter = !isPipelineTerminalStageKind(stage.kind);
                  const tone = getPipelineStageColumnTone(stage.kind);
                  return (
                    <div key={stage.id} className="flex items-center gap-2">
                      <div className="flex flex-col items-start gap-1">
                        <button
                          type="button"
                          aria-label={
                            warningCount > 0
                              ? `${stage.name}, ${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`
                              : stage.name
                          }
                          className={cn(
                            "min-h-20 w-48 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                            tone.outer,
                            selectedStage?.id === stage.id
                              ? "ring-2 ring-foreground/25"
                              : "hover:ring-1 hover:ring-foreground/10",
                          )}
                          onClick={() => setSelectedStageId(stage.id)}
                        >
                          <span className="flex items-start justify-between gap-2">
                            <span className="min-w-0 flex-1 font-semibold text-foreground">{stage.name}</span>
                            {warningCount > 0 ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {warningCount} {warningCount === 1 ? l10n("local.warning_4bd9354b") : l10n("local.warnings_227690d7")}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">{l10n("local.step_8e6a6cca")}{" "}{index + 1}</span>
                          {stageNewEntriesDisabled(stage) ? (
                            <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                              <AlertTriangle className="h-3 w-3" />
                              {l10n("local.new_entries_paused_e3c983a1")}</span>
                          ) : null}
                        </button>
                        <Link
                          to={`/pipelines/${pipelineId}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {l10n("local.view_queue_e700ab00")}<ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </div>
                      {canInsertAfter ? (
                        <button
                          type="button"
                          aria-label={l10n("local.insert_stage_after_value_c7361901", {v0: (stage.name)})}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                          onClick={() => addStage.mutate(stage)}
                          disabled={addStage.isPending}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      ) : null}
                      {index === stages.length - 1 ? null : (
                        <span className="h-px w-8 bg-border" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedStage ? (
            <form
              className="space-y-5"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                saveStage.mutate();
              }}
            >
              <div className="flex flex-col gap-5 md:flex-row md:gap-0">
                <StageSubSidebar
                  activeSection={activeStageSection}
                  stageKind={stageKind}
                  onSectionChange={handleStageSectionChange}
                />
                <div className="min-w-0 flex-1 md:px-8">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold text-foreground">
                      {STAGE_SECTION_TITLES[activeStageSection]}
                    </h2>
                    {activeStageSection === "instructions" ? (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className={cn(
                            "h-8 w-8",
                            newEntriesDisabled &&
                              "border-amber-500/50 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300",
                          )}
                          title={newEntriesDisabled ? l10n("local.resume_new_entries_a1c1fec8") : l10n("local.pause_new_entries_dffbb84c")}
                          aria-label={newEntriesDisabled ? l10n("local.resume_new_entries_a1c1fec8") : l10n("local.pause_new_entries_dffbb84c")}
                          onClick={() => setNewEntriesDisabled((value) => !value)}
                        >
                          {newEntriesDisabled ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title={l10n("local.delete_value_cd822e07", {v0: (selectedStage.name)})}
                          aria-label={l10n("local.delete_value_cd822e07", {v0: (selectedStage.name)})}
                          onClick={() => setDeleteStageDialogOpen(true)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <StageHealthWarnings
                    className="mb-4"
                    warnings={healthWarningsByStage[selectedStage.id] ?? []}
                  />

                  {activeStageSection === "instructions" ? (
                    <div className="w-full max-w-3xl">
                      <div className="divide-y divide-border border-b border-border">
                        <FieldRow label={l10n("local.name_dcd1d522")}>
                          <Input value={stageName} onChange={(event) => setStageName(event.target.value)} required />
                        </FieldRow>
                        <FieldRow label={l10n("local.step_type_23d0ef5b")}>
                          <div className="max-w-xl space-y-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label={l10n("local.step_type_23d0ef5b")}
                                  className="h-auto min-h-10 w-full justify-between whitespace-normal px-3 py-2 text-left"
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <SelectedStageKindIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{selectedStageKindOption.label}</span>
                                  </span>
                                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-(--sz-calc-40)">
                                <DropdownMenuRadioGroup value={stageKind} onValueChange={setStageKindWithDefaults}>
                                  {STAGE_KIND_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    return (
                                      <DropdownMenuRadioItem
                                        key={option.value}
                                        value={option.value}
                                        className="items-start gap-3 py-2.5"
                                      >
                                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0">
                                          <span className="block font-medium text-foreground">{option.label}</span>
                                          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                            {option.description}
                                          </span>
                                        </span>
                                      </DropdownMenuRadioItem>
                                    );
                                  })}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <p className="text-sm leading-6 text-muted-foreground">
                              {selectedStageKindOption.description}
                            </p>
                          </div>
                        </FieldRow>

                        {stageKind === "review" ? (
                          <FieldRow label={l10n("local.approver_3ebb5648")}>
                            <InlineEntitySelector
                              value={selectedApproval === "any_human" ? "" : selectedApproval}
                              options={approvalOptions}
                              recentOptionIds={recentAssigneeOptionIds}
                              placeholder={l10n("local.approver_3ebb5648")}
                              noneLabel={l10n("local.any_human_f4ae4736")}
                              searchPlaceholder={l10n("local.search_approvers_14a9f989")}
                              emptyMessage={l10n("local.no_approvers_found_f1a7922d")}
                              onChange={(value) => setSelectedApproval(approverValueFromOption(value))}
                              renderTriggerValue={(option) => {
                                if (!option) return <span className="text-muted-foreground">{l10n("local.any_human_f4ae4736")}</span>;
                                const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
                                return (
                                  <>
                                    {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                                    <span className="truncate">{option.label}</span>
                                  </>
                                );
                              }}
                              renderOption={(option) => {
                                if (!option.id) return <span className="truncate">{option.label}</span>;
                                const agent = option.id.startsWith("agent:") ? agentById.get(option.id.slice("agent:".length)) : null;
                                return (
                                  <>
                                    {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                                    <span className="truncate">{option.label}</span>
                                  </>
                                );
                              }}
                            />
                          </FieldRow>
                        ) : null}

                        {stageKind === "review" ? (
                          <FieldRow label={l10n("local.review_outcomes_c4a2bb75")}>
                            <div className="space-y-2">
                              {([
                                ["Approved items move to", approveTarget, setApproveTarget, "Choose a stage"],
                                ["Declined items move to", rejectTarget, setRejectTarget, "Choose a stage"],
                                ["Items needing changes move to", requestChangesTarget, setRequestChangesTarget, "Stay in review"],
                              ] as const).map(([label, value, setValue, emptyLabel]) => (
                                <div
                                  key={label}
                                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-(--gtc-42)"
                                >
                                  <span className="text-sm font-medium">{label}</span>
                                  <select
                                    aria-label={label}
                                    value={value}
                                    onChange={(event) => setValue(event.target.value)}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                  >
                                    <option value="">{emptyLabel}</option>
                                    {otherStages.map((stage) => (
                                      <option key={stage.id} value={stage.key}>{stage.name}</option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                              <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-(--gtc-42)">
                                <span className="text-sm font-medium">{l10n("local.ask_for_a_note_when_requesting_changes_c2d3b51c")}</span>
                                <div className="sm:justify-self-start">
                                  <ToggleSwitch checked={requireRequestChangesReason} onCheckedChange={setRequireRequestChangesReason} />
                                </div>
                              </div>
                              <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-(--gtc-42)">
                                <span className="text-sm font-medium">{l10n("local.ask_for_a_note_when_declining_3c63a1df")}</span>
                                <div className="sm:justify-self-start">
                                  <ToggleSwitch checked={requireRejectReason} onCheckedChange={setRequireRejectReason} />
                                </div>
                              </div>
                            </div>
                            {reviewTargetsMissing ? (
                              <p className="mt-2 text-sm text-muted-foreground">
                                {l10n("local.pick_where_approved_and_declined_items_should_d7bc4720")}</p>
                            ) : null}
                          </FieldRow>
                        ) : null}

                      </div>
                    </div>
                  ) : null}

                  {activeStageSection === "instructions" && !isPipelineTerminalStageKind(stageKind) ? (
                    <div className="mt-8 w-full max-w-3xl space-y-6">
                      <div className="overflow-x-auto overscroll-x-contain">
                        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                          <span>{l10n("local.when_an_item_enters_this_step_9e82510a")}</span>
                          <InlineEntitySelector
                            value={stageAssigneeOptionId(stageAssigneeAgentId)}
                            options={stageAssigneeOptions}
                            recentOptionIds={recentAssigneeOptionIds}
                            placeholder={l10n("local.pick_agent_867bb608")}
                            noneLabel={l10n("local.no_automation_43b54777")}
                            searchPlaceholder={l10n("local.search_agents_32f4468b")}
                            emptyMessage={l10n("local.no_agents_found_61666542")}
                            onChange={(value) => setStageAssigneeAgentId(stageAssigneeIdFromOption(value))}
                            renderTriggerValue={(option) => {
                              if (!option) return <span className="text-muted-foreground">{l10n("local.pick_agent_867bb608")}</span>;
                              const agent = stageAssigneeIdFromOption(option.id)
                                ? agentById.get(stageAssigneeIdFromOption(option.id))
                                : null;
                              return (
                                <>
                                  {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                                  <span className="truncate">{option.label}</span>
                                </>
                              );
                            }}
                            renderOption={(option) => {
                              if (!option.id) return <span className="truncate">{option.label}</span>;
                              const agentId = stageAssigneeIdFromOption(option.id);
                              const agent = agentId ? agentById.get(agentId) : null;
                              return (
                                <>
                                  {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                                  <span className="truncate">{option.label}</span>
                                </>
                              );
                            }}
                          />
                          <span>{l10n("local.runs_these_instructions_then_moves_the_item_t_8e3a03a2")}</span>
                        </div>
                      </div>

                      {selectedAutomationAgent ? (
                        <>
                          <div className="divide-y divide-border border-y border-border">
                            <FieldRow label={l10n("local.project_context_121099a0")}>
                              <div className="grid gap-2 sm:grid-cols-(--gtc-43)">
                                <InlineEntitySelector
                                  value={stageProjectId}
                                  options={projectOptions}
                                  recentOptionIds={recentProjectIds}
                                  placeholder={l10n("local.project_98595978")}
                                  noneLabel={l10n("local.no_project_f34c2be0")}
                                  searchPlaceholder={l10n("local.search_projects_c59dd5a3")}
                                  emptyMessage={l10n("local.no_projects_found_26e92309")}
                                  onChange={handleAutomationProjectChange}
                                  renderTriggerValue={(option) =>
                                    option && selectedAutomationProject ? (
                                      <>
                                        <span
                                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                                          style={{ backgroundColor: selectedAutomationProject.color ?? "var(--project-seed)" }}
                                        />
                                        <span className="truncate">{option.label}</span>
                                      </>
                                    ) : (
                                      <span className="text-muted-foreground">{l10n("local.project_98595978")}</span>
                                    )
                                  }
                                  renderOption={(option) => {
                                    if (!option.id) return <span className="truncate">{option.label}</span>;
                                    const project = orderedProjects.find((item) => item.id === option.id);
                                    return (
                                      <>
                                        <span
                                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                                          style={{ backgroundColor: project?.color ?? "var(--project-seed)" }}
                                        />
                                        <span className="truncate">{option.label}</span>
                                      </>
                                    );
                                  }}
                                />
                                {selectedAutomationProject ? (
                                  <select
                                    aria-label={l10n("local.project_workspace_ce016e7f")}
                                    value={stageProjectWorkspaceId}
                                    onChange={(event) => handleAutomationProjectWorkspaceChange(event.target.value)}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                  >
                                    <option value="">{l10n("local.project_fallback_19bf89ef")}</option>
                                    {(selectedAutomationProject.workspaces ?? []).map((workspace) => (
                                      <option key={workspace.id} value={workspace.id}>
                                        {workspace.name}{workspace.isPrimary ? (" " + l10n("local._primary_c81587f4")) : ""}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <div className="flex h-10 items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
                                    {l10n("local.project_workspace_ce016e7f")}</div>
                                )}
                              </div>
                              {selectedAutomationProject && !selectedAutomationProjectWorkspace ? (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  {l10n("local.this_project_has_no_saved_workspace_default_p_c6e087a5")}</p>
                              ) : null}
                            </FieldRow>

                            {selectedAutomationProject && selectedProjectSupportsExecutionWorkspace ? (
                              <FieldRow label={l10n("local.execution_workspace_d31c92b6")}>
                                <div className="grid gap-2 sm:grid-cols-(--gtc-43)">
                                  <select
                                    aria-label={l10n("local.execution_workspace_mode_3b50be31")}
                                    value={stageExecutionWorkspacePreference || "shared_workspace"}
                                    onChange={(event) => handleAutomationExecutionWorkspacePreferenceChange(event.target.value)}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                  >
                                    {STAGE_EXECUTION_WORKSPACE_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                  {stageExecutionWorkspacePreference === "reuse_existing" ? (
                                    <select
                                      aria-label={l10n("local.existing_execution_workspace_5f62874c")}
                                      value={stageExecutionWorkspaceId}
                                      onChange={(event) => handleAutomationExecutionWorkspaceIdChange(event.target.value)}
                                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                    >
                                      <option value="">{l10n("local.choose_an_existing_workspace_f8f73210")}</option>
                                      {deduplicatedReusableWorkspaces.map((workspace) => (
                                        <option key={workspace.id} value={workspace.id}>
                                          {workspace.name} · {workspace.status} · {workspace.branchName ?? workspace.cwd ?? workspace.id.slice(0, 8)}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <div className="flex h-10 items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground">
                                      {stageExecutionWorkspacePreference === "isolated_workspace"
                                        ? l10n("local.a_new_workspace_will_be_created_1ca03164")
                                        : l10n("local.project_default_workspace_5c8cc632")}
                                    </div>
                                  )}
                                </div>
                                {stageExecutionWorkspacePreference === "reuse_existing" && selectedReusableExecutionWorkspace ? (
                                  <p className="mt-2 text-xs text-muted-foreground">
                                    {l10n("local.reusing_7f0f95dc")}{" "}{selectedReusableExecutionWorkspace.name} {l10n("local.from_75857a45")}{" "}{selectedReusableExecutionWorkspace.branchName ?? selectedReusableExecutionWorkspace.cwd ?? l10n("local.existing_workspace_63e42d38")}.
                                  </p>
                                ) : null}
                                {!canSaveAutomationWorkspace ? (
                                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                                    {l10n("local.choose_an_existing_workspace_before_saving_re_76e6ba5a")}</p>
                                ) : null}
                              </FieldRow>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <AgentAvatar agent={selectedAutomationAgent} size={16} className="h-4 w-4 shrink-0"/>
                            <span>{selectedAutomationAgent.name} {l10n("local.runs_this_step_automatically_674a7f2f")}</span>
                          </div>
                          <FieldRow label={l10n("local.issue_title_baebb0f7")}>
                            <Input
                              ref={issueTitleTemplateInputRef}
                              aria-label={l10n("local.issue_title_template_512f4624")}
                              value={issueTitleTemplate}
                              onChange={(event) => setIssueTitleTemplate(event.target.value)}
                              placeholder={PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE}
                              className="font-mono text-sm"
                            />
                          </FieldRow>
                          <AutomationVariableTokenHelper
                            groups={automationVariableGroups}
                            onInsert={insertIssueTitleVariableToken}
                            label={l10n("local.issue_title_variables_a589b2df")}
                          />
                          {breakdownEnabled ? (
                            <div className="space-y-1">
                              <h3 className="text-sm font-semibold text-foreground">{l10n("local.what_should_the_agent_decide_249ec530")}</h3>
                              <p className="text-sm text-muted-foreground">
                                {l10n("local.the_mechanics_are_handled_below_write_only_th_4eb413ef")}</p>
                            </div>
                          ) : null}
                          <div data-testid="stage-instructions-editor">
                            <MarkdownEditor
                              ref={instructionsEditorRef}
                              value={instructionsBody}
                              onChange={setInstructionsBody}
                              placeholder={
                                breakdownEnabled
                                  ? l10n("local.describe_the_judgment_the_agent_should_make_w_96fa7259")
                                  : l10n("local.tell_the_agent_exactly_what_to_do_when_an_ite_8d9c6082")
                              }
                              bordered={false}
                              contentClassName="min-h-(--sz-120px) text-sm leading-7"
                              mentions={mentionOptions}
                              onSubmit={() => {
                                if (!saveStage.isPending && stageName.trim() && !reviewTargetsMissing && canSaveAutomationWorkspace) {
                                  saveStage.mutate();
                                }
                              }}
                            />
                          </div>
                          <AutomationVariableTokenHelper
                            groups={automationVariableGroups}
                            onInsert={insertInstructionsVariableToken}
                          />
                          <CarriedFieldTokenHelper
                            groups={incomingCarryOverFieldGroups}
                            onInsert={insertInstructionsVariableToken}
                          />
                        </>
                      ) : (
                        <EmptyState
                          icon={Pause}
                          message="Nothing runs here automatically. Items wait until a person moves them, or you can pick an agent to run this step."
                        />
                      )}
                      <div className="space-y-3">
                        <RoutineVariablesHint />
                        <RoutineVariablesEditor
                          key={selectedStage?.id ?? "stage"}
                          title={issueTitleTemplate}
                          description={instructionsBody}
                          value={instructionsVariables}
                          onChange={setInstructionsVariables}
                        />
                      </div>
                      {breakdownSettingsCard}
                    </div>
                  ) : null}

                  {activeStageSection === "secrets" ? (
                    <div className="w-full max-w-3xl">
                      {(() => {
                        const detail = stageAutomationDetail(selectedStage);
                        const automationAgent = detail.assigneeAgentId
                          ? agentById.get(detail.assigneeAgentId) ?? null
                          : null;
                        return (
                          <StageSecretsPanel
                            hasAutomation={Boolean(detail.routineId && detail.assigneeAgentId)}
                            agentName={automationAgent?.name ?? null}
                            agentIcon={automationAgent?.icon ?? null}
                            agent={automationAgent ?? undefined}
                            secrets={secretsQuery.data ?? []}
                            secretsLoading={secretsQuery.isLoading}
                            value={stageEnv}
                            onChange={setStageEnv}
                            onCreateSecret={async (name, value) => createSecret.mutateAsync({ name, value })}
                            onSetupAutomation={() => setActiveStageSection("instructions")}
                            onSave={() => saveStageEnv.mutate()}
                            saving={saveStageEnv.isPending}
                            dirty={stageEnvDirty}
                          />
                        );
                      })()}
                    </div>
                  ) : null}

                  {activeStageSection === "advanced" ? (
                    <div className="w-full max-w-3xl space-y-8">
                      <div className="divide-y divide-border border-b border-border">
                        <div className="py-3">
                          <h3 className="text-sm font-semibold text-foreground">{l10n("local.transitions_700bb6e8")}</h3>
                        </div>
                        <FieldRow label={l10n("local.strict_mode_9f19fe13")}>
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-3">
                              <ToggleSwitch
                                aria-label={l10n("local.strictly_enforce_transitions_4ee5c089")}
                                checked={strictTransitionsEnabled}
                                disabled={saveStrictTransitions.isPending}
                                onCheckedChange={(checked) => {
                                  setStrictTransitionsEnabled(checked);
                                  saveStrictTransitions.mutate(checked);
                                }}
                              />
                              <span className="text-sm font-medium text-foreground">
                                {l10n("local.strictly_enforce_transitions_4ee5c089")}</span>
                            </div>
                            <p className="max-w-2xl text-sm text-muted-foreground">
                              {strictTransitionsEnabled
                                ? l10n("local.items_can_only_move_to_configured_next_steps_b2437421")
                                : l10n("local.items_can_move_to_any_step_saved_allowed_next_0a4e207d")}
                            </p>
                          </div>
                        </FieldRow>
                        {strictTransitionsEnabled ? transitionTargetsControl : null}
                      </div>
                      {isPipelineTerminalStageKind(stageKind) ? null : breakdownEnabled ? (
                        <EmptyState
                          icon={SlidersHorizontal}
                          message="Advanced child settings are hidden while Break into smaller pieces is enabled. Configure that workflow in Automation."
                        />
                      ) : (
                        <div className="divide-y divide-border border-b border-border">
                          <div className="py-3">
                            <h3 className="text-sm font-semibold text-foreground">{l10n("local.children_3583a358")}</h3>
                          </div>
                          <FieldRow label={l10n("local.block_children_7f9c1c06")}>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-3">
                                <ToggleSwitch
                                  checked={requireChildrenTerminal}
                                  onCheckedChange={setRequireChildrenTerminal}
                                />
                                <span className="text-sm font-medium text-foreground">
                                  {l10n("local.block_until_all_child_items_are_done_or_cance_ec438bc8")}</span>
                              </div>
                              <p className="max-w-2xl text-sm text-muted-foreground">
                                {l10n("local.when_on_this_step_can_t_move_forward_while_an_a7aef544")}</p>
                            </div>
                          </FieldRow>
                          <FieldRow label={l10n("local.advance_children_6031ef68")}>
                            <div className="space-y-3">
                              <div className="flex items-center gap-3">
                                <ToggleSwitch
                                  checked={Boolean(autoAdvanceOnChildrenTerminal)}
                                  onCheckedChange={(checked) => {
                                    setAutoAdvanceOnChildrenTerminal(checked ? autoAdvanceOnChildrenTerminal || defaultAutoAdvanceStage?.key || "" : "");
                                  }}
                                />
                                <span className="text-sm font-medium text-foreground">
                                  {l10n("local.advance_when_the_last_child_is_done_168dc8a7")}</span>
                              </div>
                              <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-(--gtc-44)">
                                <span className="text-sm font-medium text-muted-foreground">{l10n("local.move_to_beb8194b")}</span>
                                <select
                                  aria-label={l10n("local.move_to_stage_when_children_finish_ffd452be")}
                                  value={autoAdvanceOnChildrenTerminal}
                                  onChange={(event) => setAutoAdvanceOnChildrenTerminal(event.target.value)}
                                  disabled={!autoAdvanceOnChildrenTerminal}
                                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                                >
                                  <option value="">{l10n("local.choose_a_stage_15a9299c")}</option>
                                  {otherStages.map((stage) => (
                                    <option key={stage.id} value={stage.key}>{stage.name}</option>
                                  ))}
                                </select>
                              </div>
                              <p className="max-w-2xl text-sm text-muted-foreground">
                                {l10n("local.when_on_and_every_child_is_done_this_step_mov_1166019f")}</p>
                            </div>
                          </FieldRow>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {activeStageSection === "activity" ? (
                    <div className="w-full space-y-3">
                      {stageEventsQuery.isLoading ? (
                        <PageSkeleton variant="list" />
                      ) : (
                        <StageEventsList
                          events={stageEvents}
                          stages={stages}
                          emptyMessage={l10n("local.no_stage_activity_yet_32aadf73")}
                        />
                      )}
                    </div>
                  ) : null}

                  {activeStageSection === "history" ? (
                    <div className="w-full max-w-3xl">
                      {instructionsKey ? (
                        <PipelineStageHistoryPanel
                          pipelineId={pipelineId}
                          documentKey={instructionsKey}
                          currentRevisionId={(instructionsDocument?.document?.latestRevisionId as string | null | undefined) ?? null}
                          hasDocument={Boolean(instructionsDocument)}
                          onRestored={(body, baseRevisionId) => {
                            setInstructionsBody(body);
                            void baseRevisionId;
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {saveStage.error ? <p className="text-sm text-destructive">{saveStage.error.message}</p> : null}

              {stageDirty || saveStage.isPending ? (
                <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
                  <span className="text-sm text-muted-foreground">
                    {saveStage.isPending ? l10n("local.saving_changes_39520758") : l10n("local.you_have_unsaved_changes_4e0a4324")}
                  </span>
                  <Button
                    type="submit"
                    disabled={saveStage.isPending || !stageName.trim() || reviewTargetsMissing || !canSaveAutomationWorkspace}
                  >
                    {saveStage.isPending ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                    {saveStage.isPending ? l10n("local.saving_dc85af8f") : l10n("local.save_stage_954df125")}
                  </Button>
                </div>
              ) : null}
            </form>
          ) : null}
      </div>
      <Dialog
        open={deleteStageDialogOpen}
        onOpenChange={setDeleteStageDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.delete_stage_0e8ac379")}</DialogTitle>
            <DialogDescription>
              {l10n("local.delete_e2d0a549")}{" "}{selectedStage?.name ?? l10n("local.this_stage_c24d9e1e")} {l10n("local.from_this_pipeline_connected_stage_transition_85a944da")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {stages.length > 1 ? (
              <label className="block space-y-1.5 text-sm font-medium">
                <span>{l10n("local.move_existing_items_to_79267c85")}</span>
                <select
                  aria-label={l10n("local.move_existing_items_to_79267c85")}
                  value={deleteMoveTargetStageId}
                  onChange={(event) => setDeleteMoveTargetStageId(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {stages
                    .filter((stage) => stage.id !== selectedStage?.id)
                    .map((stage) => (
                      <option key={stage.id} value={stage.id}>{stage.name}</option>
                    ))}
                </select>
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">
                {l10n("local.this_is_the_only_stage_deletion_succeeds_only_3230b105")}</p>
            )}
            {deleteStage.error ? (
              <p className="text-sm text-destructive">{deleteStage.error.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteStageDialogOpen(false)}
              disabled={deleteStage.isPending}
            >
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteStage.isPending || (stages.length > 1 && !deleteMoveTargetStageId)}
              onClick={() => deleteStage.mutate()}
            >
              <Trash2 className="h-4 w-4" />
              {deleteStage.isPending ? l10n("local.deleting_685ecb98") : l10n("local.delete_stage_0e8ac379")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveDialogOpen}
        onOpenChange={(open) => {
          setArchiveDialogOpen(open);
          if (!open) setArchiveConfirmation("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.archive_pipeline_959e7cee")}</DialogTitle>
            <DialogDescription>
              {l10n("local.archiving_hides_this_pipeline_from_everyday_v_365905aa")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{l10n("local.type_baaddf70")}{" "}{pipeline.name} {l10n("local.to_confirm_83918ed6")}</span>
              <Input
                aria-label={l10n("local.archive_confirmation_d2326f08")}
                value={archiveConfirmation}
                onChange={(event) => setArchiveConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            {archivePipeline.error ? (
              <p className="text-sm text-destructive">{archivePipeline.error.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setArchiveDialogOpen(false)}
              disabled={archivePipeline.isPending}
            >
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!archiveEnabled}
              onClick={() => archivePipeline.mutate(true)}
            >
              <Archive className="h-4 w-4" />
              {archivePipeline.isPending ? l10n("local.archiving_6f340711") : l10n("local.archive_pipeline_959e7cee")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
