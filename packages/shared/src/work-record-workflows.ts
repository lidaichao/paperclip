import { z } from "zod";

/**
 * Workflow v2 is an additive orchestration contract. It does not replace the
 * seven work-record business statuses, native issue statuses, or heartbeat run
 * statuses. Consumers must keep those three state families separate.
 */
export const WORK_RECORD_WORKFLOW_VERSION_LEGACY = 1 as const;
export const WORK_RECORD_WORKFLOW_VERSION = 2 as const;
export const WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT = false;

export const WORK_PACKAGE_MAX_RECORDS = 200;
export const WORK_PACKAGE_MAX_DEPTH = 8;
export const WORK_PACKAGE_MAX_EDGES = 2_000;

export const WORK_PACKAGE_SCOPE_KINDS = ["whole_package", "selected_records"] as const;
export const WORK_PACKAGE_BATCH_STATES = [
  "preparing",
  "prepared",
  "blocked",
  "failed",
  "superseded",
] as const;
export const WORK_PACKAGE_ITEM_MATERIALIZATION_STATES = [
  "pending",
  "materialized",
  "reused",
  "blocked",
  "failed",
] as const;

/** Quality phases are a business-quality projection, not work or run status. */
export const WORK_RECORD_QUALITY_PHASES = [
  "not_started",
  "waiting_children",
  "qa_initial",
  "waiting_fix",
  "qa_retest",
  "po_acceptance",
  "impact_review",
  "approval_wait",
  "accepted",
  "attention_required",
] as const;
export const WORK_RECORD_QUALITY_CYCLE_KINDS = [
  "package_acceptance",
  "package_rework",
  "qa_initial",
  "qa_retest",
  "independent_defect",
  "impact_review",
] as const;
export const WORK_RECORD_QUALITY_CYCLE_STATES = [
  "open",
  "accepted",
  "superseded",
  "cancelled",
] as const;
export const WORK_RECORD_QUALITY_ITEM_ROLES = ["repair", "qa", "po"] as const;
export const WORK_RECORD_QUALITY_ITEM_STATES = [
  "waiting",
  "blocked",
  "ready",
  "active",
  "submitted",
  "accepted",
  "rejected",
  "superseded",
  "cancelled",
] as const;
export const WORK_RECORD_QUALITY_VERDICT_OUTCOMES = [
  "pass",
  "return",
  "approve",
  "reject",
] as const;

/** Execution-intent state is logical admission state, never a heartbeat run state. */
export const WORK_RECORD_EXECUTION_INTENT_KINDS = [
  "initial_release",
  "rework_release",
  "qa_retest_release",
  "po_acceptance_release",
] as const;
export const WORK_RECORD_EXECUTION_INTENT_STATES = [
  "pending",
  "waiting_dependencies",
  "waiting_governance",
  "ready",
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
] as const;
export const WORK_RECORD_WORKFLOW_EVENT_TYPES = [
  "initial_release",
  "rework_release",
  "qa_retest_release",
  "po_acceptance_release",
  "projection_reconcile",
] as const;

export const WORK_RECORD_WORKFLOW_ERROR_CODES = [
  "work_record_workflow_unknown_version",
  "work_record_workflow_unknown_event",
  "work_package_scope_too_large",
  "work_package_depth_too_large",
  "work_package_dependency_snapshot_too_large",
  "work_record_workflow_idempotency_conflict",
  "work_record_workflow_invalid_transition",
  "work_record_workflow_stale_revision",
  "work_record_workflow_company_boundary",
  "work_record_workflow_project_boundary",
  "work_record_workflow_role_denied",
  "work_record_workflow_active_cycle_conflict",
  "work_record_workflow_active_intent_conflict",
  "work_record_quality_assignment_required",
  "work_record_quality_target_invalid",
  "work_record_quality_not_ready",
  "work_record_quality_review_round_limit",
  "work_record_workflow_v2_disabled",
  "work_package_assignment_required",
  "work_package_dependency_cycle",
] as const;

export type WorkPackageScopeKind = (typeof WORK_PACKAGE_SCOPE_KINDS)[number];
export type WorkPackageBatchState = (typeof WORK_PACKAGE_BATCH_STATES)[number];
export type WorkRecordQualityPhase = (typeof WORK_RECORD_QUALITY_PHASES)[number];
export type WorkRecordQualityCycleKind = (typeof WORK_RECORD_QUALITY_CYCLE_KINDS)[number];
export type WorkRecordQualityCycleState = (typeof WORK_RECORD_QUALITY_CYCLE_STATES)[number];
export type WorkRecordQualityItemRole = (typeof WORK_RECORD_QUALITY_ITEM_ROLES)[number];
export type WorkRecordQualityItemState = (typeof WORK_RECORD_QUALITY_ITEM_STATES)[number];
export type WorkRecordQualityVerdictOutcome = (typeof WORK_RECORD_QUALITY_VERDICT_OUTCOMES)[number];
export type WorkRecordExecutionIntentKind = (typeof WORK_RECORD_EXECUTION_INTENT_KINDS)[number];
export type WorkRecordExecutionIntentState = (typeof WORK_RECORD_EXECUTION_INTENT_STATES)[number];
export type WorkRecordWorkflowEventType = (typeof WORK_RECORD_WORKFLOW_EVENT_TYPES)[number];
export type WorkRecordWorkflowErrorCode = (typeof WORK_RECORD_WORKFLOW_ERROR_CODES)[number];

const requestIdSchema = z.string().trim().min(1).max(255);
const digestSchema = z.string().trim().min(1).max(255);
const evidenceRefsSchema = z.array(z.string().trim().min(1).max(2_000)).max(100).default([]);

const workPackageScopeSchema = z
  .object({
    workflowVersion: z.literal(WORK_RECORD_WORKFLOW_VERSION).default(WORK_RECORD_WORKFLOW_VERSION),
    projectId: z.string().guid(),
    rootRecordId: z.string().guid().nullable(),
    scopeKind: z.enum(WORK_PACKAGE_SCOPE_KINDS),
    selectedRecordIds: z.array(z.string().guid()).max(WORK_PACKAGE_MAX_RECORDS).default([]),
  })
  .superRefine((value, context) => {
    if (value.scopeKind === "whole_package" && value.rootRecordId === null) {
      context.addIssue({
        code: "custom",
        path: ["rootRecordId"],
        message: "whole_package scope requires rootRecordId",
      });
    }
    if (value.scopeKind === "selected_records" && value.selectedRecordIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["selectedRecordIds"],
        message: "selected_records scope requires at least one record",
      });
    }
    if (new Set(value.selectedRecordIds).size !== value.selectedRecordIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedRecordIds"],
        message: "selectedRecordIds must be unique",
      });
    }
  });

export const previewWorkPackageDispatchSchema = workPackageScopeSchema;

export const prepareWorkPackageDispatchSchema = z
  .intersection(workPackageScopeSchema, z.object({
    clientRequestId: requestIdSchema,
    requestPayloadDigest: digestSchema,
    expectedRootRevision: z.number().int().positive(),
    expectedDependencySetRevision: z.number().int().positive(),
    expectedScopeDigest: digestSchema.optional(),
  }));

const qualityVerdictBaseSchema = z.object({
  workflowVersion: z.literal(WORK_RECORD_WORKFLOW_VERSION).default(WORK_RECORD_WORKFLOW_VERSION),
  clientRequestId: requestIdSchema,
  requestPayloadDigest: digestSchema,
  cycleId: z.string().guid(),
  itemId: z.string().guid(),
  expectedCycleRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(100_000),
  evidenceRefs: evidenceRefsSchema,
});

/** PO uses a dedicated command bound to the current cycle revision. */
export const recordPoQualityVerdictSchema = qualityVerdictBaseSchema.extend({
  outcome: z.enum(["approve", "return"]),
  targetRecordIds: z.array(z.string().guid()).max(WORK_PACKAGE_MAX_RECORDS).default([]),
}).superRefine((value, context) => {
  if (value.outcome === "return" && value.targetRecordIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["targetRecordIds"],
      message: "PO return requires at least one original target record",
    });
  }
});

/** QA uses a dedicated command and cannot select an unrelated repair task. */
export const recordQaQualityVerdictSchema = qualityVerdictBaseSchema.extend({
  outcome: z.enum(["pass", "return"]),
  defectRecordId: z.string().guid(),
  repairRecordId: z.string().guid().nullable(),
}).superRefine((value, context) => {
  if (value.outcome === "return" && value.repairRecordId === null) {
    context.addIssue({
      code: "custom",
      path: ["repairRecordId"],
      message: "QA return requires the permanently linked original repair record",
    });
  }
});

/**
 * Package defects are business evidence. They point back to the package,
 * original repair record and original QA record; they never mint a parallel
 * repair issue. A null repair target deliberately routes ownership to the PO.
 */
export const linkWorkPackageDefectSchema = z.object({
  workflowVersion: z.literal(WORK_RECORD_WORKFLOW_VERSION).default(WORK_RECORD_WORKFLOW_VERSION),
  clientRequestId: requestIdSchema,
  requestPayloadDigest: digestSchema,
  cycleId: z.string().guid(),
  expectedCycleRevision: z.number().int().positive(),
  defectRecordId: z.string().guid(),
  packageRecordId: z.string().guid(),
  repairRecordId: z.string().guid().nullable(),
  qaRecordId: z.string().guid(),
  reason: z.string().trim().min(1).max(100_000),
  evidenceRefs: evidenceRefsSchema,
});

/** CEO may fill an empty assignment; replacing an existing owner is not this command. */
export const fillWorkRecordAssignmentGapSchema = z.object({
  workflowVersion: z.literal(WORK_RECORD_WORKFLOW_VERSION).default(WORK_RECORD_WORKFLOW_VERSION),
  clientRequestId: requestIdSchema,
  requestPayloadDigest: digestSchema,
  recordId: z.string().guid(),
  assigneeAgentId: z.string().guid(),
  expectedRecordRevision: z.number().int().positive(),
  expectedAssigneeAgentId: z.null(),
});

export type PrepareWorkPackageDispatch = z.infer<typeof prepareWorkPackageDispatchSchema>;
export type PreviewWorkPackageDispatch = z.infer<typeof previewWorkPackageDispatchSchema>;
export type RecordPoQualityVerdict = z.infer<typeof recordPoQualityVerdictSchema>;
export type RecordQaQualityVerdict = z.infer<typeof recordQaQualityVerdictSchema>;
export type LinkWorkPackageDefect = z.infer<typeof linkWorkPackageDefectSchema>;
export type FillWorkRecordAssignmentGap = z.infer<typeof fillWorkRecordAssignmentGapSchema>;

export type WorkPackageBoundaryResult =
  | { ok: true }
  | {
      ok: false;
      status: 422;
      code:
        | "work_package_scope_too_large"
        | "work_package_depth_too_large"
        | "work_package_dependency_snapshot_too_large";
      limit: number;
      actual: number;
    };

export function validateWorkPackageBoundaries(input: {
  recordCount: number;
  depth: number;
  edgeCount: number;
}): WorkPackageBoundaryResult {
  if (input.recordCount > WORK_PACKAGE_MAX_RECORDS) {
    return { ok: false, status: 422, code: "work_package_scope_too_large", limit: WORK_PACKAGE_MAX_RECORDS, actual: input.recordCount };
  }
  if (input.depth > WORK_PACKAGE_MAX_DEPTH) {
    return { ok: false, status: 422, code: "work_package_depth_too_large", limit: WORK_PACKAGE_MAX_DEPTH, actual: input.depth };
  }
  if (input.edgeCount > WORK_PACKAGE_MAX_EDGES) {
    return { ok: false, status: 422, code: "work_package_dependency_snapshot_too_large", limit: WORK_PACKAGE_MAX_EDGES, actual: input.edgeCount };
  }
  return { ok: true };
}

export type WorkRecordCommandReplay =
  | { outcome: "replay" }
  | { outcome: "conflict"; status: 409; code: "work_record_workflow_idempotency_conflict" };

export function classifyWorkRecordCommandReplay(
  existingPayloadDigest: string,
  incomingPayloadDigest: string,
): WorkRecordCommandReplay {
  return existingPayloadDigest === incomingPayloadDigest
    ? { outcome: "replay" }
    : { outcome: "conflict", status: 409, code: "work_record_workflow_idempotency_conflict" };
}

export class WorkRecordWorkflowContractError extends Error {
  constructor(
    readonly code: WorkRecordWorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkRecordWorkflowContractError";
  }
}

export function classifyWorkRecordWorkflowVersion(version: number): "legacy" | "v2" {
  if (version === WORK_RECORD_WORKFLOW_VERSION_LEGACY) return "legacy";
  if (version === WORK_RECORD_WORKFLOW_VERSION) return "v2";
  throw new WorkRecordWorkflowContractError(
    "work_record_workflow_unknown_version",
    `Unsupported work-record workflow version: ${version}`,
  );
}

export function classifyWorkRecordWorkflowEvent(
  workflowVersion: number,
  eventType: string,
): "legacy" | WorkRecordWorkflowEventType {
  const version = classifyWorkRecordWorkflowVersion(workflowVersion);
  if (version === "legacy") return "legacy";
  if ((WORK_RECORD_WORKFLOW_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return eventType as WorkRecordWorkflowEventType;
  }
  throw new WorkRecordWorkflowContractError(
    "work_record_workflow_unknown_event",
    `Unsupported work-record workflow v2 event: ${eventType}`,
  );
}

const packageBatchTransitions: Readonly<
  Record<WorkPackageBatchState, readonly WorkPackageBatchState[]>
> = {
  preparing: ["prepared", "blocked", "failed", "superseded"],
  prepared: ["superseded"],
  blocked: ["preparing", "failed", "superseded"],
  failed: ["preparing", "superseded"],
  superseded: [],
};

const qualityCycleTransitions: Readonly<Record<WorkRecordQualityCycleState, readonly WorkRecordQualityCycleState[]>> = {
  open: ["accepted", "superseded", "cancelled"],
  accepted: [],
  superseded: [],
  cancelled: [],
};

const qualityItemTransitions: Readonly<Record<WorkRecordQualityItemState, readonly WorkRecordQualityItemState[]>> = {
  waiting: ["blocked", "ready", "superseded", "cancelled"],
  blocked: ["waiting", "ready", "superseded", "cancelled"],
  ready: ["active", "superseded", "cancelled"],
  active: ["submitted", "superseded", "cancelled"],
  submitted: ["accepted", "rejected", "superseded"],
  accepted: [],
  rejected: ["waiting", "superseded", "cancelled"],
  superseded: [],
  cancelled: [],
};

const executionIntentTransitions: Readonly<Record<WorkRecordExecutionIntentState, readonly WorkRecordExecutionIntentState[]>> = {
  pending: ["waiting_dependencies", "waiting_governance", "ready", "superseded", "cancelled"],
  waiting_dependencies: ["waiting_governance", "ready", "superseded", "cancelled"],
  waiting_governance: ["waiting_dependencies", "ready", "superseded", "cancelled"],
  ready: ["queued", "waiting_dependencies", "waiting_governance", "superseded", "cancelled"],
  queued: ["running", "waiting_dependencies", "waiting_governance", "failed", "superseded", "cancelled"],
  running: ["succeeded", "failed", "superseded", "cancelled"],
  succeeded: [],
  failed: ["ready", "superseded", "cancelled"],
  superseded: [],
  cancelled: [],
};

function requireTransition<State extends string>(
  machine: Readonly<Record<State, readonly State[]>>,
  current: State,
  next: State,
): State {
  if (machine[current].includes(next)) return next;
  throw new WorkRecordWorkflowContractError(
    "work_record_workflow_invalid_transition",
    `Illegal workflow transition: ${current} -> ${next}`,
  );
}

export function transitionWorkPackageBatch(
  current: WorkPackageBatchState,
  next: WorkPackageBatchState,
): WorkPackageBatchState {
  return requireTransition(packageBatchTransitions, current, next);
}

export function transitionWorkRecordQualityCycle(
  current: WorkRecordQualityCycleState,
  next: WorkRecordQualityCycleState,
): WorkRecordQualityCycleState {
  return requireTransition(qualityCycleTransitions, current, next);
}

export function transitionWorkRecordQualityItem(
  current: WorkRecordQualityItemState,
  next: WorkRecordQualityItemState,
): WorkRecordQualityItemState {
  return requireTransition(qualityItemTransitions, current, next);
}

export function transitionWorkRecordExecutionIntent(
  current: WorkRecordExecutionIntentState,
  next: WorkRecordExecutionIntentState,
): WorkRecordExecutionIntentState {
  return requireTransition(executionIntentTransitions, current, next);
}
