import { z } from "zod";
import type {
  WorkPackageBatchState,
  WorkPackageScopeKind,
  WorkRecordQualityCycleKind,
  WorkRecordQualityCycleState,
  WorkRecordQualityItemRole,
  WorkRecordQualityItemState,
  WorkRecordQualityPhase,
} from "./work-record-workflows.js";

export const WORK_RECORD_KINDS = ["plan", "defect"] as const;
export const WORK_RECORD_DEFECT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const WORK_RECORD_BUSINESS_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
// These seven values remain business status only. Package/quality phase,
// execution intent, and heartbeat run state use separate contracts.
export const WORK_RECORD_DISPATCH_STATES = [
  "not_dispatched",
  "preparing",
  "blocked",
  "linked",
  "queued",
  "failed",
] as const;
export const WORK_RECORD_HOLD_REASONS = [
  "prerequisite_not_dispatched",
  "prerequisite_not_completed",
  "delivery_sync_pending",
  "native_dependency_pending",
  "release_pending",
  "release_failed",
  "prerequisite_cancelled_impact_pending",
  "quality_gate_pending",
  "approval_pending",
] as const;

export type WorkRecordKind = (typeof WORK_RECORD_KINDS)[number];
export type WorkRecordDefectSeverity = (typeof WORK_RECORD_DEFECT_SEVERITIES)[number];
export type WorkRecordBusinessStatus = (typeof WORK_RECORD_BUSINESS_STATUSES)[number];
export type WorkRecordDispatchState = (typeof WORK_RECORD_DISPATCH_STATES)[number];
export type WorkRecordHoldReason = (typeof WORK_RECORD_HOLD_REASONS)[number];

export interface ProjectVersion {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  targetDate: string | null;
  revision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectIteration {
  id: string;
  companyId: string;
  projectId: string;
  versionId: string | null;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  revision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
}

export const WORK_RECORD_VIEW_KINDS = ["plan", "defect"] as const;
export const WORK_RECORD_VIEW_DENSITIES = ["compact", "comfortable", "spacious"] as const;
export const WORK_RECORD_PLAN_VIEW_FIELDS = [
  "id", "title", "description", "iteration", "plannedStartDate", "plannedCompletionDate",
  "assignee", "qaAssignee", "businessStatus", "dispatchState", "dependencies",
] as const;
export const WORK_RECORD_DEFECT_VIEW_FIELDS = [
  ...WORK_RECORD_PLAN_VIEW_FIELDS,
  "defectSeverity",
] as const;

export type WorkRecordViewKind = (typeof WORK_RECORD_VIEW_KINDS)[number];
export type WorkRecordViewDensity = (typeof WORK_RECORD_VIEW_DENSITIES)[number];
export type WorkRecordViewField = (typeof WORK_RECORD_DEFECT_VIEW_FIELDS)[number];
export type WorkRecordViewFilterOperator = "is" | "is_not" | "contains" | "before" | "after";

export interface WorkRecordViewConfig {
  schemaVersion: 2;
  containerId: string | null;
  visibleFields: WorkRecordViewField[];
  columnOrder: WorkRecordViewField[];
  columnWidths: Partial<Record<WorkRecordViewField, number>>;
  density: WorkRecordViewDensity;
  filters: Array<{ field: WorkRecordViewField; operator: WorkRecordViewFilterOperator; value: string }>;
  search: string;
  sort: Array<{ field: WorkRecordViewField; direction: "asc" | "desc" }>;
  groupBy: WorkRecordViewField | null;
  frozenFields: WorkRecordViewField[];
}

export interface WorkRecordViewPreference {
  id: string;
  companyId: string;
  projectId: string;
  userId: string;
  viewKind: WorkRecordViewKind;
  name: string;
  isBuiltin: boolean;
  config: WorkRecordViewConfig;
  revision: number;
  updatedAt: Date | null;
}

const workRecordViewFieldSchema = z.enum(WORK_RECORD_DEFECT_VIEW_FIELDS);
export const workRecordViewConfigSchema = z.object({
  schemaVersion: z.literal(2),
  containerId: z.string().guid().nullable(),
  visibleFields: z.array(workRecordViewFieldSchema).max(WORK_RECORD_DEFECT_VIEW_FIELDS.length),
  columnOrder: z.array(workRecordViewFieldSchema).max(WORK_RECORD_DEFECT_VIEW_FIELDS.length),
  columnWidths: z.partialRecord(workRecordViewFieldSchema, z.number().int().min(64).max(1200)),
  density: z.enum(WORK_RECORD_VIEW_DENSITIES),
  filters: z.array(z.object({
    field: workRecordViewFieldSchema,
    operator: z.enum(["is", "is_not", "contains", "before", "after"]),
    value: z.string().max(500),
  }).strict()).max(20),
  search: z.string().max(500),
  sort: z.array(z.object({ field: workRecordViewFieldSchema, direction: z.enum(["asc", "desc"]) }).strict()).max(5),
  groupBy: workRecordViewFieldSchema.nullable(),
  frozenFields: z.array(workRecordViewFieldSchema).max(WORK_RECORD_DEFECT_VIEW_FIELDS.length),
}).strict();

export const putWorkRecordViewPreferenceSchema = z.object({
  expectedRevision: z.number().int().min(0),
  config: workRecordViewConfigSchema,
}).strict();

export const createWorkRecordViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  config: workRecordViewConfigSchema,
}).strict();

export const updateWorkRecordViewSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  config: workRecordViewConfigSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.config !== undefined, {
  message: "At least one field must be updated",
});

export const deleteWorkRecordViewSchema = z.object({ expectedRevision: z.coerce.number().int().positive() }).strict();

export function defaultWorkRecordViewConfig(viewKind: WorkRecordViewKind): WorkRecordViewConfig {
  const fields = viewKind === "defect" ? WORK_RECORD_DEFECT_VIEW_FIELDS : WORK_RECORD_PLAN_VIEW_FIELDS;
  return {
    schemaVersion: 2,
    containerId: null,
    visibleFields: [...fields],
    columnOrder: [...fields],
    columnWidths: {},
    density: "comfortable",
    filters: [],
    search: "",
    sort: [],
    groupBy: null,
    frozenFields: ["id", "title"],
  };
}

export function validateWorkRecordViewConfig(viewKind: WorkRecordViewKind, config: WorkRecordViewConfig): WorkRecordViewConfig {
  const allowed = new Set<WorkRecordViewField>(
    viewKind === "defect" ? WORK_RECORD_DEFECT_VIEW_FIELDS : WORK_RECORD_PLAN_VIEW_FIELDS,
  );
  const assertUniqueAllowed = (values: WorkRecordViewField[], path: string) => {
    if (new Set(values).size !== values.length || values.some((field) => !allowed.has(field))) {
      throw new Error(`${path} must contain unique fields allowed for the ${viewKind} view`);
    }
  };
  assertUniqueAllowed(config.visibleFields, "visibleFields");
  assertUniqueAllowed(config.columnOrder, "columnOrder");
  assertUniqueAllowed(config.frozenFields, "frozenFields");
  if (!config.visibleFields.includes("id") || !config.visibleFields.includes("title")) {
    throw new Error("Desktop views must keep id and title visible");
  }
  if (!config.columnOrder.includes("id") || !config.columnOrder.includes("title")) {
    throw new Error("columnOrder must contain id and title");
  }
  if (!config.frozenFields.includes("id") || !config.frozenFields.includes("title")) {
    throw new Error("Desktop views must keep id and title frozen");
  }
  if (Object.keys(config.columnWidths).some((field) => !allowed.has(field as WorkRecordViewField))) {
    throw new Error(`columnWidths must contain only fields allowed for the ${viewKind} view`);
  }
  if (config.filters.some((filter) => !allowed.has(filter.field))
    || config.sort.some((sort) => !allowed.has(sort.field))
    || (config.groupBy !== null && !allowed.has(config.groupBy))) {
    throw new Error(`filters, sort and groupBy must contain only fields allowed for the ${viewKind} view`);
  }
  return config;
}

const workRecordDateFields = {
  plannedStartDate: z.string().date().optional().nullable(),
  plannedCompletionDate: z.string().date().optional().nullable(),
};

const workRecordDefectFields = {
  defectSeverity: z.enum(WORK_RECORD_DEFECT_SEVERITIES).optional().nullable(),
};

export const createWorkRecordSchema = z.object({
  projectId: z.string().guid(),
  kind: z.enum(WORK_RECORD_KINDS),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).optional().nullable(),
  parentRecordId: z.string().guid().optional().nullable(),
  iterationId: z.string().guid().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  qaAssigneeAgentId: z.string().guid().optional().nullable(),
  packageQaRole: z.enum(["execution", "qa"]).optional(),
  qaRetestExemptionReason: z.string().trim().min(1).max(2_000).optional().nullable(),
  predecessorRecordIds: z.array(z.string().guid()).max(100).optional().default([]),
  ...workRecordDateFields,
  ...workRecordDefectFields,
}).superRefine((value, context) => {
  if (value.plannedStartDate && value.plannedCompletionDate && value.plannedStartDate > value.plannedCompletionDate) {
    context.addIssue({ code: "custom", message: "Planned start date must not be after planned completion date", path: ["plannedCompletionDate"] });
  }
  if (value.kind !== "defect" && Object.keys(workRecordDefectFields).some((field) => value[field as keyof typeof value] != null)) {
    context.addIssue({ code: "custom", message: "Defect fields require a defect record", path: ["kind"] });
  }
});

export const updateWorkRecordSchema = z.object({
  expectedRevision: z.number().int().positive(),
  dependencySetRevision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100_000).optional().nullable(),
  businessStatus: z.enum(WORK_RECORD_BUSINESS_STATUSES).optional(),
  parentRecordId: z.string().guid().optional().nullable(),
  iterationId: z.string().guid().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  qaAssigneeAgentId: z.string().guid().optional().nullable(),
  packageQaRole: z.enum(["execution", "qa"]).optional(),
  qaRetestExemptionReason: z.string().trim().min(1).max(2_000).optional().nullable(),
  qaCoverageRecordIds: z.array(z.string().guid()).max(100).optional(),
  predecessorRecordIds: z.array(z.string().guid()).max(100).optional(),
  ...workRecordDateFields,
  ...workRecordDefectFields,
}).refine((value) => Object.keys(value).some((key) => !["expectedRevision", "dependencySetRevision"].includes(key)), {
  message: "At least one field must be updated",
}).refine((value) => !value.plannedStartDate || !value.plannedCompletionDate || value.plannedStartDate <= value.plannedCompletionDate, {
  message: "Planned start date must not be after planned completion date",
  path: ["plannedCompletionDate"],
});

export const dispatchWorkRecordSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(255),
  expectedRevision: z.number().int().positive(),
});

export const acknowledgeWorkRecordDescriptionSchema = z.object({
  descriptionRevision: z.number().int().positive(),
  intentKey: z.string().trim().min(1).max(255),
});

export const createProjectVersionSchema = z.object({
  name: z.string().trim().min(1).max(255),
  targetDate: z.string().date().optional().nullable(),
});

export const updateProjectVersionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(255).optional(),
  targetDate: z.string().date().optional().nullable(),
}).refine((value) => value.name !== undefined || value.targetDate !== undefined, {
  message: "At least one field must be updated",
});

export const mutateProjectContainerSchema = z.object({
  expectedRevision: z.number().int().positive(),
});

export const createProjectIterationSchema = z.object({
  versionId: z.string().guid().optional().nullable(),
  name: z.string().trim().min(1).max(255),
  startsOn: z.string().date().optional().nullable(),
  endsOn: z.string().date().optional().nullable(),
}).refine((value) => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn, {
  message: "Iteration start date must not be after its end date",
  path: ["endsOn"],
});

export const updateProjectIterationSchema = z.object({
  expectedRevision: z.number().int().positive(),
  versionId: z.string().guid().optional().nullable(),
  name: z.string().trim().min(1).max(255).optional(),
  startsOn: z.string().date().optional().nullable(),
  endsOn: z.string().date().optional().nullable(),
}).refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
  message: "At least one field must be updated",
}).refine((value) => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn, {
  message: "Iteration start date must not be after its end date",
  path: ["endsOn"],
});

export type CreateWorkRecord = z.infer<typeof createWorkRecordSchema>;
export type UpdateWorkRecord = z.infer<typeof updateWorkRecordSchema>;
export type DispatchWorkRecord = z.infer<typeof dispatchWorkRecordSchema>;
export type AcknowledgeWorkRecordDescription = z.infer<typeof acknowledgeWorkRecordDescriptionSchema>;
export type CreateProjectVersion = z.infer<typeof createProjectVersionSchema>;
export type UpdateProjectVersion = z.infer<typeof updateProjectVersionSchema>;
export type CreateProjectIteration = z.infer<typeof createProjectIterationSchema>;
export type UpdateProjectIteration = z.infer<typeof updateProjectIterationSchema>;

export interface WorkRecordDependencyView {
  predecessorRecordId: string;
  title: string;
  businessStatus: WorkRecordBusinessStatus;
  dispatchState: WorkRecordDispatchState;
  holdReason: WorkRecordHoldReason | null;
}

export interface WorkRecordExecutionView {
  issueId: string | null;
  issueIdentifier: string | null;
  issueStatus: string | null;
  issueStatusVersion: number | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunAgentId: string | null;
  lastRunStartedAt: Date | null;
  lastRunEndedAt: Date | null;
  projectionState: "none" | "current" | "stale" | "error";
  projectionError: string | null;
  projectedAt: Date | null;
}

export interface WorkRecordRecoveryView {
  code: "release_pending" | "release_failed" | "release_dead_letter" | "dispatch_failed" | "projection_stale" | "projection_error" | null;
  message: string | null;
  canReconcile: boolean;
  lastConfirmedAt: Date | null;
}

export interface WorkRecordDeliveryView {
  eventKey: string | null;
  deliveryState: string | null;
  deliveredAt: Date | null;
  attemptCount: number;
  recoveryCount: number;
  deadLetteredAt: Date | null;
  lastRecoveredAt: Date | null;
  lastError: string | null;
  wakeRequestId: string | null;
  wakeStatus: string | null;
  acknowledgedAt: Date | null;
  runId: string | null;
}

export interface WorkRecordDescriptionDeliveryView {
  descriptionRevision: number | null;
  intentKey: string | null;
  state: "pending" | "stopping" | "queued" | "retry" | "confirmed" | null;
  commentId: string | null;
  attemptCount: number;
  sourceRunId: string | null;
  successorRunId: string | null;
  wakeupRequestId: string | null;
  stopConfirmedAt: Date | null;
  queuedAt: Date | null;
  modelVisibleAt: Date | null;
  confirmedAt: Date | null;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedByAgentId: string | null;
  acknowledgedByRunId: string | null;
  lastError: string | null;
}

export interface WorkRecordQualitySummaryView {
  cycleId: string | null;
  cycleNumber: number | null;
  cycleRevision: number | null;
  phase: WorkRecordQualityPhase;
  defectCount: number;
}

export interface WorkRecord {
  id: string;
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  title: string;
  description: string | null;
  descriptionRevision: number;
  parentRecordId: string | null;
  iterationId: string | null;
  plannedStartDate: string | null;
  plannedCompletionDate: string | null;
  defectSeverity: WorkRecordDefectSeverity | null;
  assigneeAgentId: string | null;
  qaAssigneeAgentId: string | null;
  packageQaRole: "execution" | "qa" | null;
  qaRetestExemptionReason: string | null;
  qaCoverageRecordIds: string[];
  businessStatus: WorkRecordBusinessStatus;
  statusVersion: number;
  revision: number;
  dispatchState: WorkRecordDispatchState;
  dispatchRound: number;
  dependencySetRevision: number;
  blockedCycle: number;
  dependencies: WorkRecordDependencyView[];
  execution: WorkRecordExecutionView;
  recovery: WorkRecordRecoveryView;
  delivery: WorkRecordDeliveryView;
  descriptionDelivery: WorkRecordDescriptionDeliveryView;
  quality: WorkRecordQualitySummaryView;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkPackageDispatchPreview {
  workflowVersion: 2;
  projectId: string;
  rootRecordId: string | null;
  scopeKind: WorkPackageScopeKind;
  scopeDigest: string;
  rootRevision: number;
  dependencySetRevision: number;
  recordCount: number;
  edgeCount: number;
  maxDepth: number;
  records: Array<{
    id: string;
    title: string;
    revision: number;
    dependencySetRevision: number;
    parentRecordId: string | null;
    assigneeAgentId: string | null;
    qaAssigneeAgentId: string | null;
    packageQaRole: "execution" | "qa" | null;
    qaRetestExemptionReason: string | null;
    qaCoverageRecordIds: string[];
    depth: number;
  }>;
  edges: Array<{
    predecessorRecordId: string;
    successorRecordId: string;
  }>;
  qaCoverage: Array<{ executionRecordId: string; qaRecordId: string }>;
  qaCoverageIssues: Array<{ recordId: string; qaRecordId: string | null; reason: string }>;
  eligibility: {
    canPrepare: boolean;
    blockers: Array<{
      code: "missing_po" | "missing_assignee" | "missing_qa";
      recordId: string;
      title: string;
      requiredRole: "PO" | "执行人" | "QA";
    }>;
    escalation: WorkPackageAssignmentEscalationReceipt | null;
  };
}

export interface WorkRecordActionCapability {
  allowed: boolean;
  requiredRole: string;
  reason: string | null;
}

export interface WorkRecordConsoleCapabilities {
  manageContainers: WorkRecordActionCapability;
  editRecords: WorkRecordActionCapability;
  preparePackage: WorkRecordActionCapability;
  escalateAssignmentGaps: WorkRecordActionCapability;
  recordPoVerdict: WorkRecordActionCapability;
  recordQaVerdict: WorkRecordActionCapability;
  linkDefect: WorkRecordActionCapability;
  reconcile: WorkRecordActionCapability;
}

export interface WorkPackageAssignmentEscalationReceipt {
  id: string;
  clientRequestId: string;
  scopeDigest: string;
  targetCeoAgentId: string | null;
  state: "pending" | "delivering" | "queued" | "delivered" | "acknowledged" | "ceo_unavailable" | "delivery_failed";
  deliveryAttempt: number;
  wakeupRequestId: string | null;
  wakeStatus: string | null;
  runId: string | null;
  runStatus: string | null;
  deliveryErrorCode: string | null;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  recordedAt: Date;
  updatedAt: Date;
  missingRecordIds: string[];
  replayed: boolean;
}

export interface WorkPackageDispatchBatch {
  id: string;
  companyId: string;
  projectId: string;
  rootRecordId: string | null;
  clientRequestId: string;
  scopeKind: WorkPackageScopeKind;
  scopeDigest: string;
  rootRecordRevision: number;
  dependencySetRevision: number;
  workflowVersion: number;
  state: WorkPackageBatchState;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkPackageDispatchBatchItem {
  id: string;
  recordId: string;
  recordRevision: number;
  inclusionReason: string;
  materializationState: string;
  primaryIssueLinkId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkPackageDispatchBatchView {
  batch: WorkPackageDispatchBatch;
  items: WorkPackageDispatchBatchItem[];
  replayed?: boolean;
  recovered?: boolean;
}

export interface WorkRecordQualityCycleView {
  id: string;
  aggregateRecordId: string;
  cycleNumber: number;
  kind: WorkRecordQualityCycleKind;
  state: WorkRecordQualityCycleState;
  qualityPhase: WorkRecordQualityPhase;
  reason: string | null;
  scopeDigest: string;
  revision: number;
  openedByAgentId: string | null;
  openedByUserId: string | null;
  closedByAgentId: string | null;
  closedByUserId: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkRecordQualityItemView {
  id: string;
  cycleId: string;
  recordId: string;
  defectRecordId: string | null;
  role: WorkRecordQualityItemRole;
  required: boolean;
  state: WorkRecordQualityItemState;
  issueLinkId: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkRecordQualityVerdictView {
  id: string;
  cycleId: string;
  itemId: string;
  defectRecordId: string | null;
  outcome: string;
  reason: string | null;
  evidenceRefs: string[];
  actorAgentId: string | null;
  actorUserId: string | null;
  actorRunId: string | null;
  createdAt: Date;
}

export interface WorkRecordQualityLinkView {
  id: string;
  linkKind: string;
  defectRecordId: string;
  packageRecordId: string | null;
  repairRecordId: string | null;
  qaRecordId: string | null;
  validFromCycleNumber: number;
  createdAt: Date;
}

export type WorkRecordQualityAggregateView = Pick<
  WorkRecord,
  | "id" | "companyId" | "projectId" | "kind" | "title" | "description"
  | "descriptionRevision" | "parentRecordId" | "iterationId" | "assigneeAgentId"
  | "qaAssigneeAgentId" | "businessStatus" | "dispatchState" | "dispatchRound"
  | "statusVersion" | "revision" | "createdAt" | "updatedAt"
>;

export interface WorkRecordQualityView {
  aggregate: WorkRecordQualityAggregateView;
  cycle: WorkRecordQualityCycleView | null;
  items: WorkRecordQualityItemView[];
  verdicts: WorkRecordQualityVerdictView[];
  links: WorkRecordQualityLinkView[];
  history: {
    cycles: WorkRecordQualityCycleView[];
    items: WorkRecordQualityItemView[];
    verdicts: WorkRecordQualityVerdictView[];
  };
}

export interface WorkRecordQualityCommandResult {
  replayed: boolean;
  escalated?: boolean;
  quality: WorkRecordQualityView;
}

export interface WorkRecordDispatchResult {
  record: WorkRecord;
  issueId: string;
  issueIdentifier: string | null;
  issueLinkId: string;
  commandId: string;
  replayed: boolean;
}

export interface WorkRecordDispatchRequestResult {
  clientRequestId: string;
  commandId: string;
  state: string;
  error: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueLinkId: string | null;
  record: WorkRecord;
}

export interface WorkRecordDisplayState {
  state: "running" | "unknown" | "preparing" | "failed" | "blocked" | "queued" | "linked" | "not_dispatched" | "conflict" | "done" | "cancelled" | "ended" | "stale" | "error";
  animated: boolean;
}

export function deriveWorkRecordDisplayState(input: {
  businessStatus: WorkRecordBusinessStatus;
  dispatchState: WorkRecordDispatchState;
  liveRunStatus?: string | null;
  liveRunQueryFailed?: boolean;
  projectionState?: WorkRecordExecutionView["projectionState"];
  lastRunStatus?: string | null;
}): WorkRecordDisplayState {
  const terminal = input.businessStatus === "done" || input.businessStatus === "cancelled";
  // A cached live run is not authoritative once the live query is unavailable.
  // Fail closed before consulting liveRunStatus so offline/error states never
  // keep animating an old "running" result.
  if (input.liveRunQueryFailed && input.dispatchState !== "not_dispatched") return { state: "unknown", animated: false };
  if (input.liveRunStatus === "running") return { state: terminal ? "conflict" : "running", animated: !terminal };
  if (input.liveRunStatus === "queued") return { state: terminal ? "conflict" : "queued", animated: false };
  if (input.projectionState === "error") return { state: "error", animated: false };
  if (input.projectionState === "stale") return { state: "stale", animated: false };
  if (input.businessStatus === "done") return { state: "done", animated: false };
  if (input.businessStatus === "cancelled") return { state: "cancelled", animated: false };
  if (input.lastRunStatus && !["queued", "running"].includes(input.lastRunStatus)) {
    return { state: "ended", animated: false };
  }
  if (input.dispatchState === "queued") return { state: "linked", animated: false };
  return { state: input.dispatchState, animated: false };
}
