import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentApiKeys,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  localAgentDeviceBindings,
  projects,
  workRecordIssueLinks,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecords,
} from "../../packages/db/src/index.js";
import { normalizeIssueExecutionPolicy } from "../../server/src/services/issue-execution-policy.js";
import { PAP17_G2_IDS } from "./pap17-g2-fixture-ids.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const databaseUrl = required("DATABASE_URL");
const repairToken = required("PAP17_REPAIR_TOKEN");
const qaToken = required("PAP17_QA_TOKEN");
const outputPath = path.resolve(required("PAP17_FIXTURE_IDS_PATH"));
const commandRoot = path.resolve(required("PAP17_FIXTURE_ROOT"));
const db = createDb(databaseUrl);
const ids = PAP17_G2_IDS;

try {
  await db.insert(companies).values({
    id: ids.companyId,
    name: "PAP-17 G2 isolated live fixture",
    issuePrefix: "G2F",
  });
  await db.insert(projects).values({
    id: ids.projectId,
    companyId: ids.companyId,
    name: "PAP-17 isolated bridge proof",
  });
  await db.insert(agents).values([
    {
      id: ids.repairAgentId,
      companyId: ids.companyId,
      name: "Rabbit",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    },
    {
      id: ids.qaAgentId,
      companyId: ids.companyId,
      name: "Luna",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    },
  ]);
  await db.insert(agentApiKeys).values([
    {
      id: ids.repairKeyId,
      companyId: ids.companyId,
      agentId: ids.repairAgentId,
      name: "PAP-17 Rabbit repair bridge",
      keyHash: tokenHash(repairToken),
    },
    {
      id: ids.qaKeyId,
      companyId: ids.companyId,
      agentId: ids.qaAgentId,
      name: "PAP-17 Luna QA bridge",
      keyHash: tokenHash(qaToken),
    },
  ]);
  await db.insert(localAgentDeviceBindings).values([
    {
      companyId: ids.companyId,
      agentId: ids.repairAgentId,
      keyId: ids.repairKeyId,
      deviceId: ids.repairDeviceId,
    },
    {
      companyId: ids.companyId,
      agentId: ids.qaAgentId,
      keyId: ids.qaKeyId,
      deviceId: ids.qaDeviceId,
    },
  ]);
  const executionPolicy = normalizeIssueExecutionPolicy({
    mode: "normal",
    commentRequired: true,
    maxReviewRounds: 3,
    stages: [{
      id: ids.reviewStageId,
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: ids.reviewParticipantId, type: "agent", agentId: ids.qaAgentId }],
    }],
  });
  await db.insert(issues).values({
    id: ids.issueId,
    companyId: ids.companyId,
    projectId: ids.projectId,
    title: "PAP-17 fixed independent defect bridge proof",
    description: [
      "This is the fixed-ID PAP-17 G2 live bridge fixture.",
      `Repair phase: run powershell -NoProfile -File ${path.join(commandRoot, "repair-work.ps1")} -EvidenceRoot ${commandRoot}, inspect its JSON output, then submit the native defect-repair-handoff contract.`,
      `QA phase: run powershell -NoProfile -File ${path.join(commandRoot, "qa-work.ps1")} -EvidenceRoot ${commandRoot}, verify the repair marker, then submit the native defect-qa-verdict contract with the context IDs.`,
      "Do not patch the issue status and do not create replacement tasks.",
    ].join("\n"),
    status: "todo",
    assigneeAgentId: ids.repairAgentId,
    executionPolicy,
  });
  await db.insert(heartbeatRuns).values({
    id: ids.repairRunId,
    companyId: ids.companyId,
    agentId: ids.repairAgentId,
    status: "queued",
    runtimeMode: "client_pull",
    contextSnapshot: { issueId: ids.issueId, wakeReason: "issue_assigned" },
  });
  await db.insert(workRecords).values({
    id: ids.defectRecordId,
    companyId: ids.companyId,
    projectId: ids.projectId,
    kind: "defect",
    title: "PAP-17 fixed live bridge defect",
    description: "Repair and independently retest the local fixture marker chain.",
    assigneeAgentId: ids.repairAgentId,
    qaAssigneeAgentId: ids.qaAgentId,
    dispatchState: "dispatched",
    dispatchRound: 1,
    businessStatus: "in_progress",
  });
  await db.insert(workRecordIssueLinks).values({
    id: ids.issueLinkId,
    companyId: ids.companyId,
    projectId: ids.projectId,
    recordId: ids.defectRecordId,
    issueId: ids.issueId,
    purpose: "primary",
    dispatchRound: 1,
  });
  await db.insert(workRecordQualityCycles).values({
    id: ids.cycleId,
    companyId: ids.companyId,
    projectId: ids.projectId,
    aggregateRecordId: ids.defectRecordId,
    cycleNumber: 1,
    kind: "independent_defect",
    state: "open",
    qualityPhase: "waiting_fix",
    scopeDigest: randomBytes(32).toString("hex"),
  });
  await db.insert(workRecordQualityItems).values([
    {
      id: ids.repairItemId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      cycleId: ids.cycleId,
      recordId: ids.defectRecordId,
      defectRecordId: ids.defectRecordId,
      role: "repair",
      state: "ready",
      issueLinkId: ids.issueLinkId,
    },
    {
      id: ids.qaItemId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      cycleId: ids.cycleId,
      recordId: ids.defectRecordId,
      defectRecordId: ids.defectRecordId,
      role: "qa",
      state: "blocked",
      issueLinkId: ids.issueLinkId,
    },
  ]);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    fixed: true,
    ids,
    queue: {
      repairRunId: ids.repairRunId,
      repairState: "queued",
      qaRunId: null,
      qaState: "created only after repair stop acknowledgement",
      qaAgentId: ids.qaAgentId,
      qaItemId: ids.qaItemId,
    },
  }, null, 2)}\n`, "utf8");
} finally {
  await db.$client.end();
}
