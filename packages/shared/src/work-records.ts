import { z } from "zod";

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
  code: "release_pending" | "release_failed" | "dispatch_failed" | "projection_stale" | "projection_error" | null;
  message: string | null;
  canReconcile: boolean;
  lastConfirmedAt: Date | null;
}

export interface WorkRecord {
  id: string;
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  title: string;
  description: string | null;
  descriptionRevision: number;
  assigneeAgentId: string | null;
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
  createdAt: Date;
  updatedAt: Date;
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
  if (input.liveRunStatus === "running") return { state: terminal ? "conflict" : "running", animated: !terminal };
  if (input.liveRunStatus === "queued") return { state: terminal ? "conflict" : "queued", animated: false };
  if (input.liveRunQueryFailed && input.dispatchState !== "not_dispatched") return { state: "unknown", animated: false };
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
