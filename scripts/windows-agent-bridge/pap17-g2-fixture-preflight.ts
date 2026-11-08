export interface Pap17FixtureReadinessSnapshot {
  responsibleUserId: string;
  repairAgentId: string;
  repairAgentExecutionMode: string | null;
  membership: { principalId: string; status: string } | null;
  repairKey: { responsibleUserId: string | null } | null;
  draftReceipt: {
    dispatchState: string;
    issueId: string | null;
    wakeRequestId: string | null;
    runId: string | null;
  };
  dispatchReceipt: {
    recordId: string | null;
    issueId: string | null;
    issueLinkId: string | null;
    batchId: string | null;
    clientRequestId: string | null;
  };
  queued: {
    recordId: string | null;
    issueId: string | null;
    wakeRequestId: string | null;
    runId: string | null;
    runStatus: string | null;
    runtimeMode: string | null;
    runAgentId: string | null;
    runResponsibleUserId: string | null;
    issueResponsibleUserId: string | null;
    deliveryState: string | null;
  };
  quality: {
    cycleId: string | null;
    cycleKind: string | null;
    repairItemId: string | null;
    qaItemId: string | null;
  };
}

export function assessPap17FixtureReadiness(input: Pap17FixtureReadinessSnapshot) {
  const failures: string[] = [];
  if (!input.membership || input.membership.principalId !== input.responsibleUserId ||
    input.membership.status !== "active") {
    failures.push("responsible_user_membership_inactive");
  }
  if (!input.repairKey?.responsibleUserId) {
    failures.push("repair_key_responsible_user_missing");
  } else if (input.repairKey.responsibleUserId !== input.responsibleUserId) {
    failures.push("repair_key_responsible_user_mismatch");
  }
  if (input.draftReceipt.dispatchState !== "not_dispatched" ||
    input.draftReceipt.issueId || input.draftReceipt.wakeRequestId || input.draftReceipt.runId) {
    failures.push("draft_had_dispatch_side_effects");
  }
  if (!input.dispatchReceipt.recordId || !input.dispatchReceipt.issueId ||
    !input.dispatchReceipt.issueLinkId || !input.dispatchReceipt.batchId ||
    !input.dispatchReceipt.clientRequestId) {
    failures.push("formal_dispatch_receipt_incomplete");
  }
  if (!input.queued.wakeRequestId || !input.queued.runId ||
    input.queued.deliveryState !== "delivered") {
    failures.push("dispatch_event_chain_incomplete");
  }
  if (input.queued.recordId !== input.dispatchReceipt.recordId ||
    input.queued.issueId !== input.dispatchReceipt.issueId) {
    failures.push("dispatch_identity_mismatch");
  }
  if (input.repairAgentExecutionMode !== "client_pull") {
    failures.push("repair_agent_not_client_pull");
  }
  if (input.queued.runStatus !== "queued" ||
    !["legacy", "client_pull"].includes(input.queued.runtimeMode ?? "")) {
    failures.push("repair_run_not_claimable_queued");
  }
  if (input.queued.runResponsibleUserId !== input.responsibleUserId ||
    input.queued.issueResponsibleUserId !== input.responsibleUserId) {
    failures.push("dispatch_responsible_user_mismatch");
  }
  if (input.queued.runAgentId !== input.repairAgentId) {
    failures.push("repair_run_agent_mismatch");
  }
  if (!input.quality.cycleId || input.quality.cycleKind !== "independent_defect" ||
    !input.quality.repairItemId || !input.quality.qaItemId) {
    failures.push("independent_defect_quality_chain_incomplete");
  }
  return { ready: failures.length === 0, failures };
}
