import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkRecord, WorkRecordQualityView } from "@paperclipai/shared";
import { WorkPackageConsole } from "@/components/WorkPackageConsole";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";
const PROJECT_ID = "project-work-package";
const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const REPAIR_ID = "22222222-2222-4222-8222-222222222222";
const QA_ID = "33333333-3333-4333-8333-333333333333";
const DEFECT_ID = "44444444-4444-4444-8444-444444444444";
const CYCLE_ID = "55555555-5555-4555-8555-555555555555";

function record(input: Partial<WorkRecord> & Pick<WorkRecord, "id" | "title">): WorkRecord {
  const { id, title, ...overrides } = input;
  return {
    id, companyId: COMPANY_ID, projectId: PROJECT_ID, kind: "plan", title,
    description: null, descriptionRevision: 1, parentRecordId: null, iterationId: null,
    plannedStartDate: null, plannedCompletionDate: null, defectSeverity: null,
    assigneeAgentId: "agent-developer", qaAssigneeAgentId: "agent-qa", businessStatus: "in_review",
    packageQaRole: null, qaRetestExemptionReason: null, qaCoverageRecordIds: [],
    statusVersion: 2, revision: 2, dispatchState: "linked", dispatchRound: 1, dependencySetRevision: 1, blockedCycle: 0, dependencies: [],
    execution: { issueId: null, issueIdentifier: null, issueStatus: null, issueStatusVersion: null, lastRunId: null, lastRunStatus: null, lastRunAgentId: null, lastRunStartedAt: null, lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: new Date("2026-10-28T08:00:00Z") },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: new Date("2026-10-28T08:00:00Z") },
    delivery: { eventKey: null, deliveryState: null, deliveredAt: null, attemptCount: 0, lastError: null, wakeRequestId: null, wakeStatus: null, acknowledgedAt: null, runId: null, recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null },
    descriptionDelivery: { descriptionRevision: null, intentKey: null, state: null, commentId: null, attemptCount: 0, sourceRunId: null, successorRunId: null, wakeupRequestId: null, stopConfirmedAt: null, queuedAt: null, modelVisibleAt: null, confirmedAt: null, deliveredAt: null, acknowledgedAt: null, acknowledgedByAgentId: null, acknowledgedByRunId: null, lastError: null },
    quality: { cycleId: CYCLE_ID, cycleNumber: 2, cycleRevision: 4, phase: "qa_retest", defectCount: 1 },
    createdAt: new Date("2026-10-27T08:00:00Z"), updatedAt: new Date("2026-10-28T08:00:00Z"),
    ...overrides,
  };
}

const records: WorkRecord[] = [
  record({ id: ROOT_ID, title: "LUN-302 工作包与质量证据界面", assigneeAgentId: "agent-po", execution: { issueId: "issue-root", issueIdentifier: "LUN-302", issueStatus: "in_review", issueStatusVersion: 6, lastRunId: "run-po", lastRunStatus: "succeeded", lastRunAgentId: "agent-po", lastRunStartedAt: new Date("2026-10-28T07:20:00Z"), lastRunEndedAt: new Date("2026-10-28T07:25:00Z"), projectionState: "stale", projectionError: null, projectedAt: new Date("2026-10-28T08:00:00Z") }, recovery: { code: "projection_stale", message: "上次派发结果未确认，请原位核对后安全重试。", canReconcile: true, lastConfirmedAt: new Date("2026-10-28T07:19:00Z") }, delivery: { eventKey: "event-root", deliveryState: "delivered", deliveredAt: new Date("2026-10-28T07:18:00Z"), attemptCount: 1, lastError: null, wakeRequestId: "wake-root", wakeStatus: "completed", acknowledgedAt: new Date("2026-10-28T07:19:00Z"), runId: "run-po", recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null } }),
  record({ id: REPAIR_ID, title: "实现固定工作包行", parentRecordId: ROOT_ID, packageQaRole: "execution", qaCoverageRecordIds: [QA_ID], businessStatus: "in_progress", quality: { cycleId: CYCLE_ID, cycleNumber: 2, cycleRevision: 4, phase: "waiting_fix", defectCount: 1 }, execution: { issueId: "issue-repair", issueIdentifier: "LUN-302-A", issueStatus: "in_progress", issueStatusVersion: 3, lastRunId: "run-repair", lastRunStatus: null, lastRunAgentId: "agent-developer", lastRunStartedAt: new Date("2026-10-28T08:00:00Z"), lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: new Date("2026-10-28T08:00:00Z") } }),
  record({ id: QA_ID, title: "窄屏与离线独立验收：验证刷新、多标签同步、断线恢复与键盘路径", parentRecordId: ROOT_ID, packageQaRole: "qa", businessStatus: "blocked", dispatchState: "blocked", dependencies: [{ predecessorRecordId: REPAIR_ID, title: "实现固定工作包行", businessStatus: "in_progress", dispatchState: "linked", holdReason: "prerequisite_not_completed" }] }),
  record({ id: DEFECT_ID, title: "窄屏详情挤压列表", kind: "defect", parentRecordId: ROOT_ID, businessStatus: "in_review", assigneeAgentId: "agent-developer", qaAssigneeAgentId: "agent-qa" }),
];

const quality: WorkRecordQualityView = {
  aggregate: records[0],
  cycle: { id: CYCLE_ID, aggregateRecordId: ROOT_ID, cycleNumber: 2, kind: "package_rework", state: "open", qualityPhase: "qa_retest", reason: "修复窄屏列表位移", scopeDigest: "scope-storybook", revision: 4, openedByAgentId: "agent-po", openedByUserId: null, closedByAgentId: null, closedByUserId: null, closedAt: null, createdAt: new Date("2026-10-28T07:00:00Z"), updatedAt: new Date("2026-10-28T08:00:00Z") },
  items: [
    { id: "66666666-6666-4666-8666-666666666666", cycleId: CYCLE_ID, recordId: REPAIR_ID, defectRecordId: DEFECT_ID, role: "repair", required: true, state: "accepted", issueLinkId: "link-repair", revision: 2, createdAt: new Date("2026-10-28T07:00:00Z"), updatedAt: new Date("2026-10-28T07:50:00Z") },
    { id: "77777777-7777-4777-8777-777777777777", cycleId: CYCLE_ID, recordId: QA_ID, defectRecordId: DEFECT_ID, role: "qa", required: true, state: "submitted", issueLinkId: "link-qa", revision: 2, createdAt: new Date("2026-10-28T07:00:00Z"), updatedAt: new Date("2026-10-28T08:00:00Z") },
    { id: "88888888-8888-4888-8888-888888888888", cycleId: CYCLE_ID, recordId: ROOT_ID, defectRecordId: null, role: "po", required: true, state: "waiting", issueLinkId: "link-po", revision: 1, createdAt: new Date("2026-10-28T07:00:00Z"), updatedAt: new Date("2026-10-28T07:00:00Z") },
  ],
  verdicts: [], links: [],
  history: { cycles: [
    { id: CYCLE_ID, aggregateRecordId: ROOT_ID, cycleNumber: 2, kind: "package_rework", state: "open", qualityPhase: "qa_retest", reason: "修复窄屏列表位移", scopeDigest: "scope-storybook", revision: 4, openedByAgentId: "agent-po", openedByUserId: null, closedByAgentId: null, closedByUserId: null, closedAt: null, createdAt: new Date("2026-10-28T07:00:00Z"), updatedAt: new Date("2026-10-28T08:00:00Z") },
    { id: "99999999-9999-4999-8999-999999999999", aggregateRecordId: ROOT_ID, cycleNumber: 1, kind: "package_acceptance", state: "superseded", qualityPhase: "po_acceptance", reason: "PO 发现窄屏回归", scopeDigest: "scope-storybook", revision: 3, openedByAgentId: "agent-po", openedByUserId: null, closedByAgentId: "agent-po", closedByUserId: null, closedAt: new Date("2026-10-28T06:55:00Z"), createdAt: new Date("2026-10-28T06:00:00Z"), updatedAt: new Date("2026-10-28T06:55:00Z") },
  ], items: [], verdicts: [{ id: "verdict-one", cycleId: "99999999-9999-4999-8999-999999999999", itemId: "item-one", defectRecordId: null, outcome: "return", reason: "窄屏列表发生位移", evidenceRefs: ["artifact://narrow-screen"], actorAgentId: "agent-po", actorUserId: null, actorRunId: null, createdAt: new Date("2026-10-28T06:55:00Z") }] },
};

type Scenario = "success" | "viewer" | "pending" | "error";

function Harness({ scenario = "success" }: { scenario?: Scenario }) {
  const queryClient = useQueryClient();
  const storyWindow = window as typeof window & { __workPackageOriginalFetch?: typeof window.fetch };
  storyWindow.__workPackageOriginalFetch ??= window.fetch.bind(window);
  const fixtureFetch = storyWindow.__workPackageOriginalFetch;
  window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.pathname.endsWith(`/work-records/${ROOT_ID}/quality`)) return Promise.resolve(Response.json(quality));
      if (url.pathname.endsWith("/work-record-capabilities")) {
        const allowed = scenario !== "viewer";
        const capability = (requiredRole: string) => ({ allowed, requiredRole, reason: allowed ? null : `需要 ${requiredRole}；当前 Viewer 仅可读取事实。` });
        return Promise.resolve(Response.json({
          preparePackage: capability("公司 Operator、Admin 或 Owner"),
          escalateAssignmentGaps: capability("公司 Operator、Admin 或 Owner"),
          recordPoVerdict: capability("PO，或公司 Operator、Admin、Owner"),
          recordQaVerdict: capability("QA，或公司 Operator、Admin、Owner"),
          linkDefect: capability("PO/QA，或公司 Operator、Admin、Owner"),
          reconcile: capability("公司 Operator、Admin 或 Owner"),
        }));
      }
      if (url.pathname.endsWith("/live-runs")) {
        if (scenario === "pending") return new Promise(() => undefined);
        if (scenario === "error") return Promise.resolve(Response.json({ error: "fixture failure" }, { status: 503 }));
        return Promise.resolve(Response.json([{ issueId: "issue-repair", status: "running" }, { issueId: "issue-root", status: "queued" }]));
      }
      if (url.pathname.endsWith("/work-package-dispatch/preview")) return Promise.resolve(Response.json({
        workflowVersion: 2, projectId: PROJECT_ID, rootRecordId: ROOT_ID, scopeKind: "whole_package",
        scopeDigest: "storybook-scope-digest", rootRevision: 2, dependencySetRevision: 1,
        recordCount: records.length, edgeCount: 1, maxDepth: 1,
        records: records.map((item, index) => ({ id: item.id, title: item.title, revision: item.revision, dependencySetRevision: 1, parentRecordId: item.parentRecordId, assigneeAgentId: item.assigneeAgentId, qaAssigneeAgentId: item.qaAssigneeAgentId, packageQaRole: item.packageQaRole, qaRetestExemptionReason: item.qaRetestExemptionReason, qaCoverageRecordIds: item.qaCoverageRecordIds, depth: index === 0 ? 0 : 1 })),
        edges: [{ predecessorRecordId: REPAIR_ID, successorRecordId: QA_ID }],
        qaCoverage: [{ executionRecordId: REPAIR_ID, qaRecordId: QA_ID }], qaCoverageIssues: [],
        eligibility: { canPrepare: true, blockers: [] },
      }));
      return fixtureFetch(input, init);
  };
  queryClient.setQueryData(queryKeys.workRecords.quality(COMPANY_ID, PROJECT_ID, ROOT_ID), quality);
  return <main className="min-h-screen bg-background p-4 text-foreground"><WorkPackageConsole companyId={COMPANY_ID} projectId={PROJECT_ID} records={records} agentNames={{ "agent-po": "卡罗尔", "agent-developer": "Rabbit", "agent-qa": "Belle" }} recordsLoading={false} recordsError={null} onRetryRecords={() => undefined} /></main>;
}

const meta: Meta<typeof Harness> = { title: "Projects/Work Package Console", component: Harness, parameters: { layout: "fullscreen" } };
export default meta;
type Story = StoryObj<typeof Harness>;
export const Desktop: Story = {};
export const Narrow: Story = { parameters: { viewport: { defaultViewport: "mobile" } } };
export const Viewer: Story = { args: { scenario: "viewer" } };
export const Pending: Story = { args: { scenario: "pending" } };
export const Error: Story = { args: { scenario: "error" } };
