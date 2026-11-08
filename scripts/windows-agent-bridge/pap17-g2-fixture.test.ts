import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAP17_G2_IDS } from "./pap17-g2-fixture-ids.js";
import { assessPap17FixtureReadiness } from "./pap17-g2-fixture-preflight.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("PAP-17 G2 live fixture", () => {
  const evidenceIds = {
    defectRecordId: "27000000-0000-4000-8000-000000000801",
    issueId: "27000000-0000-4000-8000-000000000601",
    issueLinkId: "27000000-0000-4000-8000-000000000901",
    dispatchBatchId: "27000000-0000-4000-8000-000000000902",
    repairWakeRequestId: "27000000-0000-4000-8000-000000000702",
    repairRunId: "27000000-0000-4000-8000-000000000701",
    cycleId: "27000000-0000-4000-8000-000000001001",
    repairItemId: "27000000-0000-4000-8000-000000001101",
    qaItemId: "27000000-0000-4000-8000-000000001102",
  } as const;
  const readySnapshot = {
    responsibleUserId: PAP17_G2_IDS.responsibleUserId,
    repairAgentId: PAP17_G2_IDS.repairAgentId,
    membership: { principalId: PAP17_G2_IDS.responsibleUserId, status: "active" },
    repairKey: { responsibleUserId: PAP17_G2_IDS.responsibleUserId },
    draftReceipt: {
      dispatchState: "not_dispatched",
      issueId: null,
      wakeRequestId: null,
      runId: null,
    },
    dispatchReceipt: {
      recordId: evidenceIds.defectRecordId,
      issueId: evidenceIds.issueId,
      issueLinkId: evidenceIds.issueLinkId,
      batchId: evidenceIds.dispatchBatchId,
      clientRequestId: "pap17-g2-formal-dispatch-v2",
    },
    queued: {
      recordId: evidenceIds.defectRecordId,
      issueId: evidenceIds.issueId,
      wakeRequestId: evidenceIds.repairWakeRequestId,
      runId: evidenceIds.repairRunId,
      runStatus: "queued",
      runtimeMode: "client_pull",
      runAgentId: PAP17_G2_IDS.repairAgentId,
      runResponsibleUserId: PAP17_G2_IDS.responsibleUserId,
      issueResponsibleUserId: PAP17_G2_IDS.responsibleUserId,
      deliveryState: "delivered",
    },
    quality: {
      cycleId: evidenceIds.cycleId,
      cycleKind: "independent_defect",
      repairItemId: evidenceIds.repairItemId,
      qaItemId: evidenceIds.qaItemId,
    },
  } as const;

  it("refuses readiness when the signed member identity has no responsible user", () => {
    const result = assessPap17FixtureReadiness({
      ...readySnapshot,
      repairKey: { responsibleUserId: null },
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toContain("repair_key_responsible_user_missing");
  });

  it("refuses readiness when formal dispatch has no event-to-wake-to-run chain", () => {
    const result = assessPap17FixtureReadiness({
      ...readySnapshot,
      queued: { ...readySnapshot.queued, wakeRequestId: null, runId: null },
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toContain("dispatch_event_chain_incomplete");
  });

  it("accepts only a draft followed by formal dispatch, queued client-pull run and defect QA chain", () => {
    expect(assessPap17FixtureReadiness(readySnapshot)).toEqual({ ready: true, failures: [] });
  });

  it("uses stable native IDs for evidence rebinding", () => {
    expect(new Set(Object.values(PAP17_G2_IDS)).size).toBe(Object.keys(PAP17_G2_IDS).length);
    expect(PAP17_G2_IDS.repairAgentId).toBe("17000000-0000-4000-8000-000000000301");
    expect(PAP17_G2_IDS.qaKeyId).toBe("17000000-0000-4000-8000-000000000402");
  });

  it("prepares only the isolated service and leaves both bridge phases to the outer driver", async () => {
    const script = await readFile(path.join(here, "prepare-pap17-g2-fixture.ps1"), "utf8");
    const dispatch = await readFile(path.join(here, "prepare-pap17-g2-dispatch.ts"), "utf8");
    expect(script).toContain("bridgeStartedByPrepare = $false");
    expect(script).toContain("modelStartedByPrepare = $false");
    expect(script).toContain("HEARTBEAT_SCHEDULER_ENABLED = 'false'");
    expect(script).not.toMatch(/192\.168\.72\.157:3100/);
    expect(script).toContain("-Phase repair");
    expect(script).toContain("-Phase qa");
    expect(dispatch).toContain("/work-records`");
    expect(dispatch).toContain("/work-package-dispatch/preview`");
    expect(dispatch).toContain("/work-package-dispatch/prepare`");
    expect(dispatch).toContain('writeJson("fixture-preflight.json"');
  });

  it("seeds identity prerequisites only and never fabricates a dispatched record or run", async () => {
    const script = await readFile(path.join(here, "seed-pap17-g2-fixture.ts"), "utf8");
    expect(script).toContain("companyMemberships");
    expect(script).toContain("responsibleUserId: ids.responsibleUserId");
    expect(script).not.toMatch(/heartbeatRuns|workRecords|workRecordIssueLinks|workRecordQuality/);
    expect(script).not.toContain('dispatchState: "dispatched"');
  });

  it("requires a confirmed service and PostgreSQL stop before cleanup", async () => {
    const stop = await readFile(path.join(here, "stop-pap17-g2-fixture.ps1"), "utf8");
    const remove = await readFile(path.join(here, "remove-pap17-g2-fixture.ps1"), "utf8");
    expect(stop).toContain("databasePortClosed");
    expect(stop).toContain("serviceProcessAbsent");
    expect(remove).toContain("$stopped.confirmed -ne $true");
    expect(remove).toContain("(Split-Path -Leaf $root) -ne 'g2-formal-dispatch-fixture'");
  });
});
