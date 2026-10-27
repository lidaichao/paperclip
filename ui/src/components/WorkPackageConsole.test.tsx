// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkPackageDispatchPreview, WorkRecord, WorkRecordQualityView } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { WorkPackageConsole } from "./WorkPackageConsole";

const liveRunsMock = vi.hoisted(() => vi.fn());
const qualityMock = vi.hoisted(() => vi.fn());
const previewMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: liveRunsMock } }));
vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    quality: qualityMock,
    previewPackage: previewMock,
    packageBatch: vi.fn(),
    preparePackage: vi.fn(),
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

function record(overrides: Partial<WorkRecord> & Pick<WorkRecord, "id" | "title">): WorkRecord {
  const { id, title, ...rest } = overrides;
  return {
    id, title, companyId: "company-1", projectId: "project-1", kind: "plan", description: null,
    descriptionRevision: 1, parentRecordId: null, iterationId: null, assigneeAgentId: "agent-po", qaAssigneeAgentId: "agent-qa",
    businessStatus: "in_review", statusVersion: 1, revision: 1, dispatchState: "linked", dispatchRound: 1, dependencySetRevision: 1,
    blockedCycle: 0, dependencies: [],
    execution: { issueId: "issue-1", issueIdentifier: "LUN-1", issueStatus: "in_progress", issueStatusVersion: 1, lastRunId: "run-1", lastRunStatus: null, lastRunAgentId: "agent-po", lastRunStartedAt: new Date(), lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: new Date() },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: new Date() },
    delivery: { eventKey: "event-1", deliveryState: "delivered", deliveredAt: new Date(), attemptCount: 1, lastError: null, wakeRequestId: "wake-1", wakeStatus: "completed", acknowledgedAt: new Date(), runId: "run-1" },
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

  beforeEach(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    localStorage.clear(); sessionStorage.clear();
    liveRunsMock.mockResolvedValue([{ issueId: "issue-1", status: "running" }]);
    qualityMock.mockResolvedValue(quality); previewMock.mockResolvedValue(preview);
    container = document.createElement("div"); document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.liveRuns("company-1"), [{ issueId: "issue-1", status: "running" }]);
    client.setQueryData(queryKeys.workRecords.quality("company-1", "project-1", ROOT_ID), quality);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks();
  });

  async function render(currentRecords = records) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkPackageConsole companyId="company-1" projectId="project-1" records={currentRecords} agentNames={{ "agent-po": "卡罗尔", "agent-qa": "Belle" }} recordsLoading={false} recordsError={null} onRetryRecords={() => undefined} /></QueryClientProvider>));
    await flush(); await flush();
  }

  it("fails closed when a cached running result becomes offline", async () => {
    await render();
    expect(container.querySelector('[data-testid="work-record-status"]')?.getAttribute("data-state")).toBe("running");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    await act(async () => window.dispatchEvent(new Event("offline")));
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
