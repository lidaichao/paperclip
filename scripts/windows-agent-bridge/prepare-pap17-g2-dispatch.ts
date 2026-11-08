import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessPap17FixtureReadiness } from "./pap17-g2-fixture-preflight.js";
import { PAP17_G2_IDS } from "./pap17-g2-fixture-ids.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiBase = required("PAP17_API_BASE").replace(/\/$/, "");
const fixtureRoot = path.resolve(required("PAP17_FIXTURE_ROOT"));
const repairToken = required("PAP17_REPAIR_TOKEN");
const qaToken = required("PAP17_QA_TOKEN");
const identity = JSON.parse(await readFile(required("PAP17_FIXTURE_IDS_PATH"), "utf8"));
const receiptsRoot = path.join(fixtureRoot, "http-receipts");

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(receiptsRoot, { recursive: true });
  const target = path.join(receiptsRoot, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function requestJson(
  receiptName: string,
  method: "GET" | "POST",
  requestPath: string,
  body?: unknown,
  token?: string,
): Promise<any> {
  const requestEvidence = { method, path: requestPath, body: body ?? null };
  await writeJson(`${receiptName}.request.json`, requestEvidence);
  const response = await fetch(`${apiBase}${requestPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  const responseEvidence = { status: response.status, body: parsed };
  await writeJson(`${receiptName}.response.json`, responseEvidence);
  if (!response.ok) {
    throw new Error(`${method} ${requestPath} failed with HTTP ${response.status}`);
  }
  return parsed;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const repairIdentity = await requestJson("01-repair-identity", "GET", "/api/agents/me", undefined, repairToken);
const qaIdentity = await requestJson("02-qa-identity", "GET", "/api/agents/me", undefined, qaToken);
if (repairIdentity.id !== PAP17_G2_IDS.repairAgentId || qaIdentity.id !== PAP17_G2_IDS.qaAgentId) {
  throw new Error("Signed member identity did not resolve to the configured repair and QA agents");
}

const createBody = {
  projectId: PAP17_G2_IDS.projectId,
  kind: "defect",
  title: "PAP-17 formal-dispatch live bridge defect",
  description: [
    "This record was created as a draft through the work-record API.",
    `Repair phase: run powershell -NoProfile -File ${path.join(fixtureRoot, "repair-work.ps1")} -EvidenceRoot ${fixtureRoot}, then submit the native defect-repair-handoff contract.`,
    `QA phase: run powershell -NoProfile -File ${path.join(fixtureRoot, "qa-work.ps1")} -EvidenceRoot ${fixtureRoot}, then submit the native defect-qa-verdict contract.`,
    "Do not patch issue status and do not create replacement tasks.",
  ].join("\n"),
  assigneeAgentId: PAP17_G2_IDS.repairAgentId,
  qaAssigneeAgentId: PAP17_G2_IDS.qaAgentId,
  predecessorRecordIds: [],
};
const draft = await requestJson(
  "03-create-draft",
  "POST",
  `/api/companies/${PAP17_G2_IDS.companyId}/work-records`,
  createBody,
);

const scopeBody = {
  workflowVersion: 2,
  projectId: PAP17_G2_IDS.projectId,
  rootRecordId: null,
  scopeKind: "selected_records",
  selectedRecordIds: [draft.id],
};
const preview = await requestJson(
  "04-dispatch-preview",
  "POST",
  `/api/companies/${PAP17_G2_IDS.companyId}/projects/${PAP17_G2_IDS.projectId}/work-package-dispatch/preview`,
  scopeBody,
);
if (!preview.eligibility?.canPrepare) {
  throw new Error("Formal dispatch preview reported assignment gaps");
}

const clientRequestId = "pap17-g2-formal-dispatch-v2";
const prepareBody = {
  ...scopeBody,
  clientRequestId,
  requestPayloadDigest: sha256({ scopeBody, clientRequestId }),
  expectedRootRevision: preview.rootRevision,
  expectedDependencySetRevision: preview.dependencySetRevision,
  expectedScopeDigest: preview.scopeDigest,
};
const prepared = await requestJson(
  "05-dispatch-prepare",
  "POST",
  `/api/companies/${PAP17_G2_IDS.companyId}/projects/${PAP17_G2_IDS.projectId}/work-package-dispatch/prepare`,
  prepareBody,
);

let record: any = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const list = await requestJson(
    "06-record-projection-latest",
    "GET",
    `/api/companies/${PAP17_G2_IDS.companyId}/projects/${PAP17_G2_IDS.projectId}/work-records`,
  );
  record = list.items?.find((item: { id: string }) => item.id === draft.id) ??
    (Array.isArray(list) ? list.find((item: { id: string }) => item.id === draft.id) : null);
  if (record?.dispatchState === "queued" && record.delivery?.deliveryState === "delivered" &&
    record.delivery?.wakeRequestId && record.delivery?.runId) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!record?.delivery?.runId) throw new Error("Formal dispatch did not produce a queued run within 60 seconds");

const batchItem = prepared.items?.find((item: { recordId: string }) => item.recordId === draft.id);
const issueId = record.execution?.issueId ?? null;
const issue = await requestJson("07-native-issue", "GET", `/api/issues/${issueId}`);
const run = await requestJson("08-queued-run", "GET", `/api/heartbeat-runs/${record.delivery.runId}`);
const quality = await requestJson(
  "09-defect-quality-chain",
  "GET",
  `/api/companies/${PAP17_G2_IDS.companyId}/projects/${PAP17_G2_IDS.projectId}/work-records/${draft.id}/quality`,
);
const repairItem = quality.items?.find((item: { role: string }) => item.role === "repair");
const qaItem = quality.items?.find((item: { role: string }) => item.role === "qa");

const snapshot = {
  responsibleUserId: PAP17_G2_IDS.responsibleUserId,
  repairAgentId: PAP17_G2_IDS.repairAgentId,
  repairAgentExecutionMode: repairIdentity.runtimeConfig?.executionMode ?? null,
  membership: identity.identity?.membership ?? null,
  repairKey: identity.identity?.repairKey ?? null,
  draftReceipt: {
    dispatchState: draft.dispatchState,
    issueId: draft.execution?.issueId ?? null,
    wakeRequestId: draft.delivery?.wakeRequestId ?? null,
    runId: draft.delivery?.runId ?? null,
  },
  dispatchReceipt: {
    recordId: draft.id,
    issueId,
    issueLinkId: batchItem?.primaryIssueLinkId ?? null,
    batchId: prepared.batch?.id ?? null,
    clientRequestId,
  },
  queued: {
    recordId: record.id,
    issueId,
    wakeRequestId: record.delivery?.wakeRequestId ?? null,
    runId: record.delivery?.runId ?? null,
    runStatus: run.status ?? null,
    runtimeMode: run.runtimeMode ?? null,
    runAgentId: run.agentId ?? null,
    runResponsibleUserId: run.responsibleUserId ?? null,
    issueResponsibleUserId: issue.responsibleUserId ?? null,
    deliveryState: record.delivery?.deliveryState ?? null,
  },
  quality: {
    cycleId: quality.cycle?.id ?? null,
    cycleKind: quality.cycle?.kind ?? null,
    repairItemId: repairItem?.id ?? null,
    qaItemId: qaItem?.id ?? null,
  },
};
const assessment = assessPap17FixtureReadiness(snapshot);
const preflight = { schemaVersion: 1, checkedAt: new Date().toISOString(), ...assessment, snapshot };
await writeJson("fixture-preflight.json", preflight);
if (!assessment.ready) throw new Error(`Fixture preflight failed: ${assessment.failures.join(", ")}`);

const output = {
  schemaVersion: 1,
  recordId: draft.id,
  issueId,
  issueIdentifier: issue.identifier ?? null,
  issueLinkId: batchItem.primaryIssueLinkId,
  dispatchBatchId: prepared.batch.id,
  dispatchClientRequestId: clientRequestId,
  repairWakeRequestId: record.delivery.wakeRequestId,
  repairRunId: record.delivery.runId,
  cycleId: quality.cycle.id,
  repairItemId: repairItem.id,
  qaItemId: qaItem.id,
  repairRunState: run.status,
  qaRunId: null,
  qaState: "created only after repair stop acknowledgement",
};
await writeJson("fixture-dispatch.json", output);
process.stdout.write(`${JSON.stringify(output)}\n`);
