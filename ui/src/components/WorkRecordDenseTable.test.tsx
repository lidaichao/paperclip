// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultWorkRecordViewConfig, type WorkRecord, type WorkRecordViewKind } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkRecordDenseTable } from "./WorkRecordDenseTable";

const viewsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    views: viewsMock,
    createView: vi.fn(),
    updateView: vi.fn(),
    deleteView: vi.fn(),
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(id: string, title: string, overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-10T00:00:00Z");
  return {
    id, companyId: "company-1", projectId: "project-1", kind: "plan", title,
    description: null, descriptionRevision: 1, parentRecordId: null, iterationId: null, iterationAssignmentMode: "independent",
    plannedStartDate: null, plannedCompletionDate: null, defectSeverity: null,
    assigneeAgentId: null, qaAssigneeAgentId: null, userResponsibilities: [], packageQaRole: null,
    qaRetestExemptionReason: null, qaCoverageRecordIds: [], businessStatus: "backlog",
    statusVersion: 1, revision: 1, dispatchState: "not_dispatched", dispatchRound: 0,
    dependencySetRevision: 1, blockedCycle: 0, dependencies: [],
    execution: { issueId: null, issueIdentifier: null, issueStatus: null, issueStatusVersion: null, lastRunId: null, lastRunStatus: null, lastRunAgentId: null, lastRunStartedAt: null, lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: now },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: now },
    delivery: { eventKey: null, deliveryState: null, deliveredAt: null, attemptCount: 0, lastError: null, wakeRequestId: null, wakeStatus: null, acknowledgedAt: null, runId: null, recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null },
    descriptionDelivery: { descriptionRevision: null, intentKey: null, state: null, commentId: null, attemptCount: 0, sourceRunId: null, successorRunId: null, wakeupRequestId: null, stopConfirmedAt: null, queuedAt: null, modelVisibleAt: null, confirmedAt: null, deliveredAt: null, acknowledgedAt: null, acknowledgedByAgentId: null, acknowledgedByRunId: null, lastError: null },
    quality: { cycleId: null, cycleNumber: null, cycleRevision: null, phase: "not_started", defectCount: 0 },
    createdAt: now, updatedAt: now, ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setNativeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkRecordDenseTable WBS", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    viewsMock.mockImplementation(async (_companyId: string, _projectId: string, kind: WorkRecordViewKind) => [{
      id: `builtin:${kind}`, companyId: "company-1", projectId: "project-1", userId: "user-1",
      viewKind: kind, name: "全部", isBuiltin: true, config: defaultWorkRecordViewConfig(kind), revision: 0, updatedAt: null,
    }]);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render(kind: WorkRecordViewKind, records: WorkRecord[], onChecked = vi.fn(), iterationLabels: Record<string, string> = {}) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <WorkRecordDenseTable companyId="company-1" projectId="project-1" kind={kind} records={records} agentNames={{}} iterationLabels={iterationLabels} selectedId={null} checked={[]} onSelect={vi.fn()} onChecked={onChecked} beforeViewSwitch={async () => true} />
      </QueryClientProvider>,
    ));
    await flush();
  }

  it("renders an accessible plan hierarchy and collapses every descendant", async () => {
    const rootRecord = record("root", "工作包");
    const child = record("child", "程序开发", { parentRecordId: rootRecord.id });
    const grandchild = record("qa", "QA 复测", { parentRecordId: child.id });
    await render("plan", [rootRecord, child, grandchild]);

    expect(container.querySelector('[data-record-id="root"]')?.getAttribute("data-tree-depth")).toBe("0");
    expect(container.querySelector('[data-record-id="qa"]')?.getAttribute("data-tree-depth")).toBe("2");
    const toggle = container.querySelector('button[aria-label="收起 工作包"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => toggle.click());

    expect(container.querySelector('[data-record-id="root"]')).not.toBeNull();
    expect(container.querySelector('[data-record-id="child"]')).toBeNull();
    expect(container.querySelector('[data-record-id="qa"]')).toBeNull();
  });

  it("shows unmatched ancestors as disabled context rows", async () => {
    const rootRecord = record("root", "工作包");
    const child = record("child", "程序开发", { parentRecordId: rootRecord.id });
    const grandchild = record("qa", "唯一复测目标", { parentRecordId: child.id });
    await render("plan", [rootRecord, child, grandchild]);
    const search = container.querySelector('input[aria-label="搜索记录"]') as HTMLInputElement;

    await act(async () => {
      setNativeValue(search, "唯一复测目标");
    });

    expect(container.querySelector('[data-record-id="root"]')?.getAttribute("data-context-only")).toBe("true");
    expect((container.querySelector('input[aria-label="选择 工作包"]') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('input[aria-label="选择 程序开发"]') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('input[aria-label="选择 唯一复测目标"]') as HTMLInputElement).disabled).toBe(false);
    expect(container.textContent).toContain("另含 2 条父级上下文");
  });

  it("keeps defect rows flat even when legacy data contains parent ids", async () => {
    const parent = record("defect-parent", "父缺陷", { kind: "defect" });
    const child = record("defect-child", "子缺陷", { kind: "defect", parentRecordId: parent.id });
    await render("defect", [parent, child]);

    expect(container.querySelector('[data-record-id="defect-child"]')?.getAttribute("data-tree-depth")).toBe("0");
    expect(container.querySelector('button[aria-label^="收起 "]')).toBeNull();
  });

  it("marks inherited iteration values without combining them with other fields", async () => {
    const inherited = record("child", "程序开发", {
      parentRecordId: "root",
      iterationId: "iteration-a",
      iterationAssignmentMode: "inherit_parent",
    });
    const rootRecord = record("root", "工作包", { iterationId: "iteration-a" });
    await render("plan", [rootRecord, inherited], vi.fn(), { "iteration-a": "V1 / 迭代 A" });

    const childRow = container.querySelector('[data-record-id="child"]');
    expect(childRow?.textContent).toContain("继承 · V1 / 迭代 A");
    expect(childRow?.textContent).not.toContain("程序开发 · V1");
  });
});
