// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkPackageDispatchPreview, WorkRecord, WorkRecordQualityView } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { queryKeys } from "@/lib/queryKeys";
import { WorkPackageConsole } from "./WorkPackageConsole";

const liveRunsMock = vi.hoisted(() => vi.fn());
const qualityMock = vi.hoisted(() => vi.fn());
const previewMock = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());
const capabilitiesMock = vi.hoisted(() => vi.fn());
const escalateMock = vi.hoisted(() => vi.fn());
const latestEscalationMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: liveRunsMock } }));
vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    quality: qualityMock,
    previewPackage: previewMock,
    capabilities: capabilitiesMock,
    escalateAssignmentGaps: escalateMock,
    latestAssignmentGapEscalation: latestEscalationMock,
    packageBatch: vi.fn(),
    preparePackage: prepareMock,
    reconcilePackage: vi.fn(),
    reconcile: vi.fn(),
    recordPoVerdict: vi.fn(),
    recordQaVerdict: vi.fn(),
    linkDefect: vi.fn(),
  },
}));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const DEFECT_ID = "33333333-3333-4333-8333-333333333333";
const CYCLE_ID = "44444444-4444-4444-8444-444444444444";
const CREATE_ID = "55555555-5555-4555-8555-555555555555";
const REUSE_ID = "66666666-6666-4666-8666-666666666666";
const COMPLETE_ID = "77777777-7777-4777-8777-777777777777";
const BLOCKED_ID = "88888888-8888-4888-8888-888888888888";

function record(overrides: Partial<WorkRecord> & Pick<WorkRecord, "id" | "title">): WorkRecord {
  const { id, title, ...rest } = overrides;
  return {
    id, title, companyId: "company-1", projectId: "project-1", kind: "plan", description: null,
    descriptionRevision: 1, parentRecordId: null, iterationId: null, assigneeAgentId: "agent-po", qaAssigneeAgentId: "agent-qa",
    businessStatus: "in_review", statusVersion: 1, revision: 1, dispatchState: "linked", dispatchRound: 1, dependencySetRevision: 1,
    blockedCycle: 0, dependencies: [],
    execution: { issueId: "issue-1", issueIdentifier: "LUN-1", issueStatus: "in_progress", issueStatusVersion: 1, lastRunId: "run-1", lastRunStatus: null, lastRunAgentId: "agent-po", lastRunStartedAt: new Date(), lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: new Date() },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: new Date() },
    delivery: { eventKey: "event-1", deliveryState: "delivered", deliveredAt: new Date(), attemptCount: 1, lastError: null, wakeRequestId: "wake-1", wakeStatus: "completed", acknowledgedAt: new Date(), runId: "run-1", recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null },
    quality: { cycleId: CYCLE_ID, cycleNumber: 1, cycleRevision: 1, phase: "po_acceptance", defectCount: 1 },
    createdAt: new Date(), updatedAt: new Date(), ...rest,
  };
}

const records = [
  record({ id: ROOT_ID, title: "发布工作包" }),
  record({ id: CHILD_ID, title: "实现子项", parentRecordId: ROOT_ID, dependencies: [{ predecessorRecordId: ROOT_ID, title: "发布工作包", businessStatus: "in_progress", dispatchState: "linked", holdReason: "prerequisite_not_completed" }] }),
  record({ id: DEFECT_ID, title: "回归缺陷", kind: "defect", parentRecordId: ROOT_ID }),
];

const quality: WorkRecordQualityView = {
  aggregate: records[0],
  cycle: { id: CYCLE_ID, aggregateRecordId: ROOT_ID, cycleNumber: 1, kind: "package_acceptance", state: "open", qualityPhase: "po_acceptance", reason: "等待整体验收", scopeDigest: "scope-1", revision: 1, openedByAgentId: "agent-po", openedByUserId: null, closedByAgentId: null, closedByUserId: null, closedAt: null, createdAt: new Date("2026-10-28T00:00:00Z"), updatedAt: new Date("2026-10-28T00:00:00Z") },
  items: [], verdicts: [],
  links: [{ id: "link-1", linkKind: "package_defect", defectRecordId: DEFECT_ID, packageRecordId: ROOT_ID, repairRecordId: CHILD_ID, qaRecordId: ROOT_ID, validFromCycleNumber: 1, createdAt: new Date() }],
  history: {
    cycles: [{ id: CYCLE_ID, aggregateRecordId: ROOT_ID, cycleNumber: 1, kind: "package_acceptance", state: "open", qualityPhase: "po_acceptance", reason: "等待整体验收", scopeDigest: "scope-1", revision: 1, openedByAgentId: "agent-po", openedByUserId: null, closedByAgentId: null, closedByUserId: null, closedAt: null, createdAt: new Date("2026-10-28T00:00:00Z"), updatedAt: new Date("2026-10-28T00:00:00Z") }],
    items: [],
    verdicts: [{ id: "verdict-1", cycleId: CYCLE_ID, itemId: "item-1", defectRecordId: DEFECT_ID, outcome: "return", reason: "窄屏回归", evidenceRefs: ["artifact://narrow-screen"], actorAgentId: "agent-po", actorUserId: null, actorRunId: null, createdAt: new Date("2026-10-28T00:01:00Z") }],
  },
};

const preview: WorkPackageDispatchPreview = {
  workflowVersion: 2, projectId: "project-1", rootRecordId: ROOT_ID, scopeKind: "whole_package", scopeDigest: "scope-digest", rootRevision: 1, dependencySetRevision: 1,
  recordCount: 3, edgeCount: 1, maxDepth: 1,
  records: records.map((item, index) => ({ id: item.id, title: item.title, revision: item.revision, dependencySetRevision: item.dependencySetRevision, parentRecordId: item.parentRecordId, assigneeAgentId: item.assigneeAgentId, qaAssigneeAgentId: item.qaAssigneeAgentId, depth: index === 0 ? 0 : 1 })),
  edges: [{ predecessorRecordId: ROOT_ID, successorRecordId: CHILD_ID }],
  eligibility: { canPrepare: true, blockers: [], escalation: null },
};

const writableCapabilities = {
  preparePackage: { allowed: true, requiredRole: "Operator", reason: null },
  escalateAssignmentGaps: { allowed: true, requiredRole: "Operator", reason: null },
  recordPoVerdict: { allowed: true, requiredRole: "PO", reason: null },
  recordQaVerdict: { allowed: true, requiredRole: "QA", reason: null },
  linkDefect: { allowed: true, requiredRole: "PO/QA", reason: null },
  reconcile: { allowed: true, requiredRole: "Operator", reason: null },
};

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WorkPackageConsole", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    localStorage.clear(); sessionStorage.clear();
    liveRunsMock.mockResolvedValue([{ issueId: "issue-1", status: "running" }]);
    qualityMock.mockResolvedValue(quality); previewMock.mockResolvedValue(preview);
    capabilitiesMock.mockResolvedValue(writableCapabilities);
    latestEscalationMock.mockResolvedValue(null);
    container = document.createElement("div"); document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.liveRuns("company-1"), [{ issueId: "issue-1", status: "running" }]);
    client.setQueryData(queryKeys.workRecords.quality("company-1", "project-1", ROOT_ID), quality);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
  });

  async function render(currentRecords = records, visibleKind?: "plan" | "defect") {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkPackageConsole companyId="company-1" projectId="project-1" records={currentRecords} visibleKind={visibleKind} agentNames={{ "agent-po": "卡罗尔", "agent-qa": "Belle" }} recordsLoading={false} recordsError={null} onRetryRecords={() => undefined} /></QueryClientProvider>));
    await flush(); await flush();
  }

  it("localizes package status and actions without translating record data", async () => {
    await i18n.changeLanguage("en");
    await render();
    expect(container.textContent).toContain("Work packages and quality evidence");
    expect(container.textContent).toContain("Preview whole work package");
    expect(container.textContent).toContain("In review");
    expect(container.textContent).toContain("发布工作包");
    expect(container.textContent).toContain("等待整体验收");
  });

  it("uses distinct English QA and PO result labels while preserving the recorded reason", async () => {
    await i18n.changeLanguage("en");
    const baseVerdict = quality.history.verdicts[0];
    const verdictHistory = {
      ...quality,
      history: {
        ...quality.history,
        verdicts: [
          { ...baseVerdict, id: "qa-pass", outcome: "pass", reason: "QA 原始结论" },
          { ...baseVerdict, id: "po-approve", outcome: "approve", reason: "PO 原始结论" },
        ],
      },
    };
    qualityMock.mockResolvedValue(verdictHistory);
    client.setQueryData(queryKeys.workRecords.quality("company-1", "project-1", ROOT_ID), verdictHistory);

    await render();

    expect(container.textContent).toContain("Passed · 回归缺陷");
    expect(container.textContent).toContain("Approved · 回归缺陷");
    expect(container.textContent).toContain("QA 原始结论");
    expect(container.textContent).toContain("PO 原始结论");
  });

  it("uses locale-aware singular and plural defect evidence counts", async () => {
    await i18n.changeLanguage("en");
    await render();
    expect(container.textContent).toContain("1 record");
    await render(records.map((item) => item.id === ROOT_ID ? { ...item, quality: { ...item.quality, defectCount: 2 } } : item));
    expect(container.textContent).toContain("2 records");
  });

  it("shows complete empty messages for each work record view", async () => {
    await i18n.changeLanguage("en");
    await render([], "plan");
    expect(container.textContent).toContain("No plans yet. Use New at the top right to add the first plan.");
    await render([], "defect");
    expect(container.textContent).toContain("No defects yet. Use New at the top right to add the first defect.");
    await render([]);
    expect(container.textContent).toContain("No business records yet. Use New at the top right to add the first record.");
  });

  it("fails closed when a cached running result becomes offline", async () => {
    await render();
    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-state")).toBe("running");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-state")).toBe("unknown");
    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-animated")).toBe("false");
    expect(container.textContent).toContain("暂不可确认");
  });

  it("fails closed while the first live query is pending even with cached running data", async () => {
    liveRunsMock.mockReturnValue(new Promise(() => undefined));

    await render();

    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-state")).toBe("unknown");
    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-animated")).toBe("false");
    expect(container.textContent).toContain("暂不可确认");
  });

  it("renders an inspectable package preview instead of counts alone", async () => {
    await render();
    await act(async () => window.dispatchEvent(new Event("online")));
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("预览整个工作包")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await flush();
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("范围记录");
    expect(container.textContent).toContain("前置尚未完成");
    expect(container.textContent).toContain("发布工作包 → 实现子项");
    expect(container.textContent).toContain("范围摘要 scope-digest");
  });

  it("keeps plans and defects isolated without opening details by default", async () => {
    await render(records, "plan");
    expect(container.textContent).toContain("发布工作包");
    expect(container.textContent).not.toContain("回归缺陷");
    expect(container.querySelector('[aria-current="true"]')).toBeNull();

    await render(records, "defect");
    expect(container.textContent).toContain("回归缺陷");
    expect(container.textContent).not.toContain("发布工作包");
    expect(container.textContent).not.toContain("预览整个工作包");
  });

  it("enters the dispatch chain only after explicit confirmation", async () => {
    prepareMock.mockResolvedValueOnce({ batch: { id: "batch-1" }, records });
    await render(records, "plan");
    expect(prepareMock).not.toHaveBeenCalled();

    const rootRow = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("发布工作包")) as HTMLButtonElement;
    await act(async () => rootRow.click());
    const previewButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("预览整个工作包")) as HTMLButtonElement;
    await act(async () => previewButton.click());
    await flush();
    expect(prepareMock).not.toHaveBeenCalled();

    const confirmButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("确认范围并准备派发")) as HTMLButtonElement;
    await act(async () => confirmButton.click());
    await flush();
    expect(prepareMock).toHaveBeenCalledTimes(1);
  });

  it("keeps facts readable while pre-disabling viewer writes with role explanations", async () => {
    capabilitiesMock.mockResolvedValueOnce(Object.fromEntries(Object.entries(writableCapabilities).map(([key, value]) => [key, { ...value, allowed: false, reason: `需要 ${value.requiredRole}；当前 Viewer 仅可读取事实。` }])));
    await render();
    expect(container.textContent).toContain("发布工作包");
    expect(container.textContent).toContain("当前为只读权限");
    expect(container.textContent).toContain("当前 Viewer 仅可读取事实");
    expect([...container.querySelectorAll("button")].find((node) => node.textContent?.includes("PO 验收通过"))?.disabled).toBe(true);
  });

  it("lists every ownership gap, blocks prepare, and records CEO escalation without overwriting owners", async () => {
    const gapPreview = {
      ...preview,
      eligibility: { canPrepare: false, blockers: [
        { code: "missing_po" as const, recordId: ROOT_ID, title: "发布工作包", requiredRole: "PO" as const },
        { code: "missing_assignee" as const, recordId: CHILD_ID, title: "实现子项", requiredRole: "执行人" as const },
      ], escalation: null },
    };
    previewMock.mockResolvedValueOnce(gapPreview);
    escalateMock.mockResolvedValueOnce({ id: "escalation-1", clientRequestId: "gap", scopeDigest: preview.scopeDigest, targetCeoAgentId: "ceo-1", state: "queued", deliveryAttempt: 1, wakeupRequestId: "wake-1", wakeStatus: "queued", runId: null, runStatus: null, deliveryErrorCode: null, deliveredAt: null, acknowledgedAt: null, recordedAt: new Date(), updatedAt: new Date(), missingRecordIds: [ROOT_ID, CHILD_ID], replayed: false });
    await render();
    const previewButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("预览整个工作包")) as HTMLButtonElement;
    await act(async () => previewButton.click()); await flush();
    expect(container.textContent).toContain("发布工作包 · 缺少 PO");
    expect(container.textContent).toContain("实现子项 · 缺少 执行人");
    const prepareButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("确认范围并准备派发")) as HTMLButtonElement;
    expect(prepareButton.disabled).toBe(true);
    const escalationButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("上报 CEO 协调")) as HTMLButtonElement;
    await act(async () => escalationButton.click()); await flush();
    expect(escalateMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("不会覆盖已有负责人");
    expect(container.textContent).toContain("协调通知已入队，尚未送达");
  });

  it("restores the persisted CEO coordination state after a fresh render", async () => {
    latestEscalationMock.mockResolvedValueOnce({
      id: "escalation-1",
      clientRequestId: "gap",
      scopeDigest: preview.scopeDigest,
      targetCeoAgentId: "ceo-1",
      state: "delivered",
      deliveryAttempt: 1,
      wakeupRequestId: "wake-1",
      wakeStatus: "claimed",
      runId: "run-1",
      runStatus: "running",
      deliveryErrorCode: null,
      deliveredAt: new Date(),
      acknowledgedAt: null,
      recordedAt: new Date(),
      updatedAt: new Date(),
      missingRecordIds: [ROOT_ID, CHILD_ID],
      replayed: false,
    });

    await render();

    expect(latestEscalationMock).toHaveBeenCalledWith("company-1", "project-1", ROOT_ID);
    expect(container.textContent).toContain("负责人缺口已上报 CEO，CEO 已接收协调通知，等待确认");
    expect(container.textContent).toContain("不会覆盖已有负责人");
  });

  it("renders CEO confirmation separately from queueing and delivery", async () => {
    latestEscalationMock.mockResolvedValueOnce({
      id: "escalation-1", clientRequestId: "gap", scopeDigest: preview.scopeDigest,
      targetCeoAgentId: "ceo-1", state: "acknowledged", deliveryAttempt: 1,
      wakeupRequestId: "wake-1", wakeStatus: "completed", runId: "run-1", runStatus: "succeeded",
      deliveryErrorCode: null, deliveredAt: new Date(), acknowledgedAt: new Date(),
      recordedAt: new Date(), updatedAt: new Date(), missingRecordIds: [ROOT_ID, CHILD_ID], replayed: false,
    });

    await render();

    expect(container.textContent).toContain("CEO 运行已结束；请核对负责人是否补齐");
  });

  it("offers in-place reconciliation and retry after a persisted CEO delivery failure", async () => {
    const failedReceipt = {
      id: "escalation-1", clientRequestId: "gap", scopeDigest: preview.scopeDigest,
      targetCeoAgentId: "ceo-1", state: "delivery_failed" as const, deliveryAttempt: 1,
      wakeupRequestId: "wake-1", wakeStatus: "failed", runId: "run-1", runStatus: "failed",
      deliveryErrorCode: "ceo_run_failed", deliveredAt: null, acknowledgedAt: null,
      recordedAt: new Date(), updatedAt: new Date(), missingRecordIds: [ROOT_ID, CHILD_ID], replayed: false,
    };
    const gapPreview = {
      ...preview,
      eligibility: { canPrepare: false, blockers: [
        { code: "missing_po" as const, recordId: ROOT_ID, title: "发布工作包", requiredRole: "PO" as const },
      ], escalation: failedReceipt },
    };
    latestEscalationMock.mockResolvedValue(failedReceipt);
    previewMock.mockResolvedValueOnce(gapPreview);
    escalateMock.mockResolvedValueOnce({ ...failedReceipt, state: "queued", deliveryAttempt: 2, wakeStatus: "queued", runId: null, runStatus: null, deliveryErrorCode: null });

    await render();
    const previewButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("预览整个工作包")) as HTMLButtonElement;
    await act(async () => previewButton.click()); await flush();
    const reconcileButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("核对通知状态")) as HTMLButtonElement;
    await act(async () => reconcileButton.click()); await flush();
    const retryButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("重试上报 CEO")) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);
    await act(async () => retryButton.click()); await flush();

    expect(latestEscalationMock).toHaveBeenCalledTimes(2);
    expect(escalateMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("协调通知已入队，尚未送达");
  });

  it("counts create, reuse, completed, and blocked preview records as exclusive categories", async () => {
    const mixedRecords = [
      record({ id: CREATE_ID, title: "新建项", execution: { ...records[0].execution, issueId: null, issueIdentifier: null } }),
      record({ id: REUSE_ID, title: "复用项" }),
      record({ id: COMPLETE_ID, title: "完成项", businessStatus: "done", execution: { ...records[0].execution, issueId: null, issueIdentifier: null } }),
      record({ id: BLOCKED_ID, title: "受阻项", execution: { ...records[0].execution, issueId: null, issueIdentifier: null }, dependencies: [{ predecessorRecordId: CREATE_ID, title: "新建项", businessStatus: "todo", dispatchState: "not_dispatched", holdReason: "prerequisite_not_dispatched" }] }),
    ];
    previewMock.mockResolvedValueOnce({
      ...preview,
      rootRecordId: CREATE_ID,
      recordCount: mixedRecords.length,
      edgeCount: 0,
      records: mixedRecords.map((item) => ({ id: item.id, title: item.title, revision: item.revision, dependencySetRevision: item.dependencySetRevision, parentRecordId: item.parentRecordId, assigneeAgentId: item.assigneeAgentId, qaAssigneeAgentId: item.qaAssigneeAgentId, depth: 0 })),
      edges: [],
    });
    await render(mixedRecords);
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("预览整个工作包")) as HTMLButtonElement;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const countFor = (label: string) => [...container.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling?.textContent;
    expect(countFor("将新建")).toBe("1");
    expect(countFor("将复用")).toBe("1");
    expect(countFor("保持完成")).toBe("1");
    expect(countFor("安全受阻")).toBe("1");
    const previewRows = [...container.querySelectorAll("li")];
    expect(previewRows.find((node) => node.textContent?.includes("父项 · 完成项"))?.textContent).toContain("保持完成");
    expect(previewRows.find((node) => node.textContent?.includes("父项 · 受阻项"))?.textContent).toContain("建立关联并安全受阻");
  });

  it("shows verdict reasons, evidence references, and defect-to-repair lineage", async () => {
    await render();
    expect(container.textContent).toContain("回归缺陷 → 修复 实现子项");
    expect(container.textContent).toContain("窄屏回归");
    expect(container.textContent).toContain("artifact://narrow-screen");
    expect(container.querySelector('[aria-current="true"]')).not.toBeNull();
  });

  it("offers an in-place recovery action without displacing the record list", async () => {
    const recoveryRecords = records.map((item) => item.id === ROOT_ID ? { ...item, recovery: { ...item.recovery, code: "projection_stale" as const, message: "派发结果待核对", canReconcile: true } } : item);
    await render(recoveryRecords);
    expect(container.textContent).toContain("派发结果待核对");
    expect([...container.querySelectorAll("button")].some((node) => node.textContent?.includes("重新核对当前记录"))).toBe(true);
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("发布工作包");
  });
});
