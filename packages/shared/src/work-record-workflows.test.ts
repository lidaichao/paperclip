import { describe, expect, it } from "vitest";
import {
  WORK_PACKAGE_MAX_DEPTH,
  WORK_PACKAGE_MAX_EDGES,
  WORK_PACKAGE_MAX_RECORDS,
  WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT,
  WorkRecordWorkflowContractError,
  classifyWorkRecordCommandReplay,
  classifyWorkRecordWorkflowEvent,
  classifyWorkRecordWorkflowVersion,
  fillWorkRecordAssignmentGapSchema,
  prepareWorkPackageDispatchSchema,
  recordPoQualityVerdictSchema,
  recordQaQualityVerdictSchema,
  transitionWorkRecordExecutionIntent,
  transitionWorkRecordQualityCycle,
  transitionWorkRecordQualityItem,
  transitionWorkPackageBatch,
  validateWorkPackageBoundaries,
} from "./work-record-workflows.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  root: "00000000-0000-4000-8000-000000000002",
  selected: "00000000-0000-4000-8000-000000000003",
  cycle: "00000000-0000-4000-8000-000000000004",
  item: "00000000-0000-4000-8000-000000000005",
  defect: "00000000-0000-4000-8000-000000000006",
  repair: "00000000-0000-4000-8000-000000000007",
  assignee: "00000000-0000-4000-8000-000000000008",
};

describe("work-record workflow v2 contract", () => {
  it("keeps writes disabled by default and fails closed on unknown workflow versions", () => {
    expect(WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT).toBe(false);
    expect(classifyWorkRecordWorkflowVersion(1)).toBe("legacy");
    expect(classifyWorkRecordWorkflowVersion(2)).toBe("v2");
    expect(() => classifyWorkRecordWorkflowVersion(3)).toThrowError(
      expect.objectContaining({ code: "work_record_workflow_unknown_version" }),
    );
  });

  it("fails closed on unknown workflow-v2 event types without reclassifying legacy events", () => {
    expect(classifyWorkRecordWorkflowEvent(1, "release")).toBe("legacy");
    expect(classifyWorkRecordWorkflowEvent(2, "qa_retest_release")).toBe("qa_retest_release");
    expect(() => classifyWorkRecordWorkflowEvent(2, "release")).toThrowError(
      expect.objectContaining({ code: "work_record_workflow_unknown_event" }),
    );
  });

  it("freezes inclusive package limits and returns 422 without truncating excess scope", () => {
    expect(validateWorkPackageBoundaries({
      recordCount: WORK_PACKAGE_MAX_RECORDS,
      depth: WORK_PACKAGE_MAX_DEPTH,
      edgeCount: WORK_PACKAGE_MAX_EDGES,
    })).toEqual({ ok: true });
    expect(validateWorkPackageBoundaries({
      recordCount: WORK_PACKAGE_MAX_RECORDS + 1,
      depth: 1,
      edgeCount: 0,
    })).toEqual({
      ok: false,
      status: 422,
      code: "work_package_scope_too_large",
      limit: 200,
      actual: 201,
    });
    expect(validateWorkPackageBoundaries({ recordCount: 1, depth: 9, edgeCount: 0 })).toMatchObject({
      ok: false,
      status: 422,
      code: "work_package_depth_too_large",
    });
    expect(validateWorkPackageBoundaries({ recordCount: 1, depth: 1, edgeCount: 2_001 })).toMatchObject({
      ok: false,
      status: 422,
      code: "work_package_dependency_snapshot_too_large",
    });
  });

  it("treats an idempotency key with another payload as a 409 conflict", () => {
    expect(classifyWorkRecordCommandReplay("same", "same")).toEqual({ outcome: "replay" });
    expect(classifyWorkRecordCommandReplay("old", "new")).toEqual({
      outcome: "conflict",
      status: 409,
      code: "work_record_workflow_idempotency_conflict",
    });
  });

  it("validates whole and partial dispatch without widening selected scope", () => {
    expect(prepareWorkPackageDispatchSchema.safeParse({
      clientRequestId: "package-1",
      requestPayloadDigest: "digest-1",
      projectId: ids.project,
      rootRecordId: ids.root,
      scopeKind: "whole_package",
      expectedRootRevision: 1,
      expectedDependencySetRevision: 1,
    }).success).toBe(true);
    expect(prepareWorkPackageDispatchSchema.safeParse({
      clientRequestId: "partial-1",
      requestPayloadDigest: "digest-2",
      projectId: ids.project,
      rootRecordId: null,
      scopeKind: "selected_records",
      selectedRecordIds: [ids.selected],
      expectedRootRevision: 1,
      expectedDependencySetRevision: 1,
    }).success).toBe(true);
    expect(prepareWorkPackageDispatchSchema.safeParse({
      clientRequestId: "partial-empty",
      requestPayloadDigest: "digest-3",
      projectId: ids.project,
      rootRecordId: null,
      scopeKind: "selected_records",
      selectedRecordIds: [],
      expectedRootRevision: 1,
      expectedDependencySetRevision: 1,
    }).success).toBe(false);
  });

  it("requires current-cycle evidence and original targets for PO and QA returns", () => {
    expect(recordPoQualityVerdictSchema.safeParse({
      clientRequestId: "po-return",
      requestPayloadDigest: "digest-po",
      cycleId: ids.cycle,
      itemId: ids.item,
      expectedCycleRevision: 2,
      reason: "Needs correction",
      outcome: "return",
      targetRecordIds: [],
    }).success).toBe(false);
    expect(recordQaQualityVerdictSchema.safeParse({
      clientRequestId: "qa-return",
      requestPayloadDigest: "digest-qa",
      cycleId: ids.cycle,
      itemId: ids.item,
      expectedCycleRevision: 2,
      reason: "Regression remains",
      outcome: "return",
      defectRecordId: ids.defect,
      repairRecordId: null,
    }).success).toBe(false);
  });

  it("freezes CEO gap filling as null-to-agent compare-and-set", () => {
    expect(fillWorkRecordAssignmentGapSchema.safeParse({
      clientRequestId: "fill-gap",
      requestPayloadDigest: "digest-gap",
      recordId: ids.root,
      assigneeAgentId: ids.assignee,
      expectedRecordRevision: 1,
      expectedAssigneeAgentId: null,
    }).success).toBe(true);
    expect(fillWorkRecordAssignmentGapSchema.safeParse({
      clientRequestId: "replace-owner",
      requestPayloadDigest: "digest-replace",
      recordId: ids.root,
      assigneeAgentId: ids.assignee,
      expectedRecordRevision: 1,
      expectedAssigneeAgentId: ids.repair,
    }).success).toBe(false);
  });

  it("allows only declared batch, cycle, item, and intent transitions", () => {
    expect(transitionWorkPackageBatch("preparing", "prepared")).toBe("prepared");
    expect(transitionWorkRecordQualityCycle("open", "accepted")).toBe("accepted");
    expect(transitionWorkRecordQualityItem("waiting", "ready")).toBe("ready");
    expect(transitionWorkRecordExecutionIntent("pending", "waiting_governance")).toBe("waiting_governance");

    for (const transition of [
      () => transitionWorkPackageBatch("prepared", "preparing"),
      () => transitionWorkRecordQualityCycle("accepted", "open"),
      () => transitionWorkRecordQualityItem("accepted", "active"),
      () => transitionWorkRecordExecutionIntent("succeeded", "running"),
    ]) {
      expect(transition).toThrowError(WorkRecordWorkflowContractError);
      expect(transition).toThrowError(expect.objectContaining({ code: "work_record_workflow_invalid_transition" }));
    }
  });
});
