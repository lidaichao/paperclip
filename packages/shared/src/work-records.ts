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
export type WorkRecordBusinessStatus = (typeof WORK_RECORD_BUSINESS_STATUSES)[number];
export type WorkRecordDispatchState = (typeof WORK_RECORD_DISPATCH_STATES)[number];
export type WorkRecordHoldReason = (typeof WORK_RECORD_HOLD_REASONS)[number];

export const createWorkRecordSchema = z.object({
  projectId: z.string().guid(),
  kind: z.enum(WORK_RECORD_KINDS),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).optional().nullable(),
  parentRecordId: z.string().guid().optional().nullable(),
  iterationId: z.string().guid().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  qaAssigneeAgentId: z.string().guid().optional().nullable(),
  predecessorRecordIds: z.array(z.string().guid()).max(100).optional().default([]),
});

export const updateWorkRecordSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100_000).optional().nullable(),
  businessStatus: z.enum(WORK_RECORD_BUSINESS_STATUSES).optional(),
  parentRecordId: z.string().guid().optional().nullable(),
  iterationId: z.string().guid().optional().nullable(),
  assigneeAgentId: z.string().guid().optional().nullable(),
  qaAssigneeAgentId: z.string().guid().optional().nullable(),
  predecessorRecordIds: z.array(z.string().guid()).max(100).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
  message: "At least one field must be updated",
});

export const dispatchWorkRecordSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(255),
  expectedRevision: z.number().int().positive(),
});

export const createProjectVersionSchema = z.object({
  name: z.string().trim().min(1).max(255),
  targetDate: z.string().date().optional().nullable(),
});

export const createProjectIterationSchema = z.object({
  versionId: z.string().guid().optional().nullable(),
  name: z.string().trim().min(1).max(255),
  startsOn: z.string().date().optional().nullable(),
  endsOn: z.string().date().optional().nullable(),
});

export type CreateWorkRecord = z.infer<typeof createWorkRecordSchema>;
export type UpdateWorkRecord = z.infer<typeof updateWorkRecordSchema>;
export type DispatchWorkRecord = z.infer<typeof dispatchWorkRecordSchema>;

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
  assigneeAgentId: string | null;
  qaAssigneeAgentId: string | null;
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
    depth: number;
  }>;
  edges: Array<{
    predecessorRecordId: string;
    successorRecordId: string;
  }>;
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
