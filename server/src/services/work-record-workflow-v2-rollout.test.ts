import { describe, expect, it } from "vitest";
import { resolveWorkRecordWorkflowV2Rollout } from "./work-record-workflow-v2-rollout.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

describe("workflow-v2 rollout", () => {
  it("stays off by default and fails closed when the cohort is absent or malformed", () => {
    expect(resolveWorkRecordWorkflowV2Rollout({ env: {} }).decision(companyId, projectId))
      .toMatchObject({ scopeEnabled: false, reason: "global_disabled" });
    expect(resolveWorkRecordWorkflowV2Rollout({ env: {
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "true",
    } }).decision(companyId, projectId)).toMatchObject({ scopeEnabled: false, reason: "cohort_missing" });
    expect(resolveWorkRecordWorkflowV2Rollout({ env: {
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "true",
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS: "not-json",
    } }).decision(companyId, projectId)).toMatchObject({ scopeEnabled: false, reason: "cohort_invalid" });
  });

  it("admits only the exact approved company/project pair", () => {
    const rollout = resolveWorkRecordWorkflowV2Rollout({ env: {
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED: "true",
      PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS: JSON.stringify([{ companyId, projectIds: [projectId] }]),
    } });
    expect(rollout.decision(companyId, projectId)).toMatchObject({ scopeEnabled: true, reason: "enabled" });
    expect(rollout.decision(companyId, "33333333-3333-4333-8333-333333333333"))
      .toMatchObject({ scopeEnabled: false, reason: "scope_not_approved" });
    expect(rollout.decision("44444444-4444-4444-8444-444444444444", projectId))
      .toMatchObject({ scopeEnabled: false, reason: "scope_not_approved" });
  });

  it("keeps an explicit service override for isolated tests", () => {
    expect(resolveWorkRecordWorkflowV2Rollout({ writesEnabled: true }).decision(companyId, projectId))
      .toMatchObject({ scopeEnabled: true, source: "service_override" });
  });
});
