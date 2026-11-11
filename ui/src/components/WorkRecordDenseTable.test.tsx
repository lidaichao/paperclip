// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultWorkRecordViewConfig, type WorkRecord, type WorkRecordViewKind } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { WorkRecordDenseTable } from "./WorkRecordDenseTable";

const viewsMock = vi.hoisted(() => vi.fn());
const mutateDependencyMock = vi.hoisted(() => vi.fn());
const updateRecordMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    views: viewsMock,
    createView: vi.fn(),
    updateView: vi.fn(),
    deleteView: vi.fn(),
    mutateDependency: mutateDependencyMock,
    update: updateRecordMock,
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(id: string, title: string, overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-10T00:00:00Z");
  return {
    id, companyId: "company-1", projectId: "project-1", kind: "plan", recordNumber: 1,
    recordIdentifier: "PT-1", title, priority: "medium",
    description: null, descriptionRevision: 1, parentRecordId: null, iterationId: null, iterationAssignmentMode: "independent",
    plannedStartDate: null, plannedCompletionDate: null, defectSeverity: null, foundInVersionId: null,
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
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

  async function render(kind: WorkRecordViewKind, records: WorkRecord[], onChecked = vi.fn(), iterationLabels: Record<string, string> = {}, options: {
    checked?: string[];
    versionLabels?: Record<string, string>;
    iterationVersionIds?: Record<string, string>;
    batchActions?: {
      dispatch: { label: string; onInvoke: () => void; disabled: boolean; reason: string | null; pending: boolean };
      assignOwner: { label: string; onInvoke?: () => void; disabled: boolean; reason: string | null; pending: boolean };
    };
    writable?: boolean;
    currentUserId?: string | null;
    liveRunStatusByIssue?: ReadonlyMap<string, "queued" | "running">;
    liveRunQueryFailed?: boolean;
    agentNames?: Record<string, string>;
  } = {}) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <WorkRecordDenseTable companyId="company-1" projectId="project-1" kind={kind} records={records} agentNames={options.agentNames ?? {}} iterationLabels={iterationLabels} versionLabels={options.versionLabels} iterationVersionIds={options.iterationVersionIds} liveRunStatusByIssue={options.liveRunStatusByIssue} liveRunQueryFailed={options.liveRunQueryFailed} selectedId={null} checked={options.checked ?? []} onSelect={vi.fn()} onChecked={onChecked} writable={options.writable} currentUserId={options.currentUserId} batchActions={options.batchActions} beforeViewSwitch={async () => true} />
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

  it("updates status, assignee, priority and dates inline without opening the record drawer", async () => {
    const task = record("task", "行内编辑任务");
    updateRecordMock.mockResolvedValue(task);
    await render("plan", [task], vi.fn(), {}, { writable: true, agentNames: { "agent-1": "Rabbit" } });

    const status = container.querySelector('select[aria-label="行内编辑任务 状态"]') as HTMLSelectElement;
    await act(async () => setSelectValue(status, "in_progress"));
    await flush();
    expect(updateRecordMock).toHaveBeenCalledWith("company-1", "project-1", "task", { expectedRevision: 1, businessStatus: "in_progress" });

    updateRecordMock.mockClear();
    const assignee = container.querySelector('select[aria-label="行内编辑任务 负责人"]') as HTMLSelectElement;
    await act(async () => setSelectValue(assignee, "agent-1"));
    await flush();
    expect(updateRecordMock).toHaveBeenCalledWith("company-1", "project-1", "task", { expectedRevision: 1, assigneeAgentId: "agent-1" });

    updateRecordMock.mockClear();
    const priority = container.querySelector('select[aria-label="行内编辑任务 优先级"]') as HTMLSelectElement;
    await act(async () => setSelectValue(priority, "high"));
    await flush();
    expect(updateRecordMock).toHaveBeenCalledWith("company-1", "project-1", "task", { expectedRevision: 1, priority: "high" });

    updateRecordMock.mockClear();
    const plannedStart = container.querySelector('input[aria-label="行内编辑任务 开始日期"]') as HTMLInputElement;
    await act(async () => setNativeValue(plannedStart, "2026-11-12"));
    await flush();
    expect(updateRecordMock).toHaveBeenCalledWith("company-1", "project-1", "task", { expectedRevision: 1, plannedStartDate: "2026-11-12" });

    updateRecordMock.mockClear();
    const plannedCompletion = container.querySelector('input[aria-label="行内编辑任务 完成日期"]') as HTMLInputElement;
    await act(async () => setNativeValue(plannedCompletion, "2026-11-14"));
    await flush();
    expect(updateRecordMock).toHaveBeenCalledWith("company-1", "project-1", "task", { expectedRevision: 1, plannedCompletionDate: "2026-11-14" });
  });

  it("keeps a failed inline draft and offers recoverable conflict actions", async () => {
    const task = record("task", "冲突任务");
    updateRecordMock.mockRejectedValueOnce(new ApiError("revision conflict", 409, {}));
    await render("plan", [task], vi.fn(), {}, { writable: true });

    const priority = container.querySelector('select[aria-label="冲突任务 优先级"]') as HTMLSelectElement;
    await act(async () => setSelectValue(priority, "high"));
    await flush();

    expect(priority.value).toBe("high");
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("记录已被其他人修改");
    expect(alert.textContent).toContain("你的修改已保留");
    expect([...alert.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["重试", "使用服务器值"]);

    await act(async () => [...alert.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "使用服务器值")?.click());
    expect(priority.value).toBe("medium");
    expect(container.textContent).not.toContain("记录已被其他人修改");
  });

  it("keeps inline fields read-only when edit capability is denied", async () => {
    const task = record("task", "只读任务");
    await render("plan", [task], vi.fn(), {}, { writable: false, agentNames: { "agent-1": "Rabbit" } });

    const controls = [
      container.querySelector('select[aria-label="只读任务 状态"]'),
      container.querySelector('select[aria-label="只读任务 负责人"]'),
      container.querySelector('select[aria-label="只读任务 优先级"]'),
      container.querySelector('input[aria-label="只读任务 开始日期"]'),
      container.querySelector('input[aria-label="只读任务 完成日期"]'),
    ] as Array<HTMLInputElement | HTMLSelectElement>;
    expect(controls.every((control) => control.disabled)).toBe(true);

    await act(async () => setSelectValue(controls[0] as HTMLSelectElement, "in_progress"));
    expect(updateRecordMock).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain("2 条父级上下文");
  });

  it("keeps defect rows flat even when legacy data contains parent ids", async () => {
    const parent = record("defect-parent", "父缺陷", { kind: "defect" });
    const child = record("defect-child", "子缺陷", { kind: "defect", parentRecordId: parent.id });
    await render("defect", [parent, child]);

    expect(container.querySelector('[data-record-id="defect-child"]')?.getAttribute("data-tree-depth")).toBe("0");
    expect(container.querySelector('button[aria-label^="收起 "]')).toBeNull();
  });

  it("renders the stable work-record identifier instead of a dispatched native issue identifier", async () => {
    const dispatched = record("record-uuid", "已派发任务", {
      recordNumber: 42,
      recordIdentifier: "PT-42",
      execution: {
        issueId: "issue-uuid",
        issueIdentifier: "PAP-999",
        issueStatus: "todo",
        issueStatusVersion: 1,
        lastRunId: null,
        lastRunStatus: null,
        lastRunAgentId: null,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        projectionState: "current",
        projectionError: null,
        projectedAt: new Date("2026-11-10T00:00:00Z"),
      },
    });
    await render("plan", [dispatched]);

    const row = container.querySelector('[data-record-id="record-uuid"]');
    expect(row?.textContent).toContain("PT-42");
    expect(row?.textContent).not.toContain("PAP-999");
    expect(row?.textContent).not.toContain("record-u");
  });

  it("searches, atomically replaces and reverse-lists dependencies from the table cell", async () => {
    const predecessor = record("pred", "策划设计", { recordIdentifier: "PT-10" });
    const replacement = record("next", "程序开发", { recordIdentifier: "PT-20" });
    const successor = record("succ", "QA 测试", {
      recordIdentifier: "PT-30",
      dependencies: [{ predecessorRecordId: predecessor.id, title: predecessor.title, businessStatus: "done", dispatchState: "not_dispatched", holdReason: null }],
    });
    const downstream = record("down", "上线验收", {
      recordIdentifier: "PT-40",
      dependencies: [{ predecessorRecordId: successor.id, title: successor.title, businessStatus: "todo", dispatchState: "not_dispatched", holdReason: null }],
    });
    mutateDependencyMock.mockResolvedValueOnce([{ ...successor, revision: 2, dependencySetRevision: 2, dependencies: [{ predecessorRecordId: replacement.id, title: replacement.title, businessStatus: "backlog", dispatchState: "not_dispatched", holdReason: null }] }]);
    await render("plan", [predecessor, replacement, successor, downstream], vi.fn(), {}, { writable: true });

    await act(async () => (container.querySelector('button[aria-label="编辑 QA 测试 的前置记录"]') as HTMLButtonElement).click());
    await flush();
    expect(document.body.textContent).toContain("PT-40 · 上线验收");
    const replace = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "替换")!;
    await act(async () => replace.click());
    const search = document.querySelector('input[aria-label="搜索 QA 测试 的前置记录"]') as HTMLInputElement;
    await act(async () => setNativeValue(search, "PT-20"));
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes("PT-20"))!;
    await act(async () => option.click());
    await flush();

    expect(mutateDependencyMock).toHaveBeenCalledWith("company-1", "project-1", {
      operation: "replace_source",
      predecessorRecordId: predecessor.id,
      successorRecordId: successor.id,
      replacementPredecessorRecordId: replacement.id,
      expectedRecords: [{ recordId: successor.id, expectedRevision: 1, expectedDependencySetRevision: 1 }],
    });
    expect(document.body.textContent).toContain("撤销");
  });

  it("shows authoritative live execution in the plan row and never animates stale data", async () => {
    const running = record("run", "程序开发", {
      dispatchState: "linked",
      execution: { ...record("seed", "seed").execution, issueId: "issue-1", lastRunStatus: "running" },
    });
    await render("plan", [running], vi.fn(), {}, { liveRunStatusByIssue: new Map([["issue-1", "running"]]) });
    const indicator = container.querySelector('[data-testid="work-record-live-state"]');
    expect(indicator?.getAttribute("data-state")).toBe("running");
    expect(indicator?.getAttribute("data-animated")).toBe("true");
    expect(indicator?.getAttribute("aria-label")).toBe("程序开发：处理中");

    await render("plan", [running], vi.fn(), {}, { liveRunStatusByIssue: new Map(), liveRunQueryFailed: true });
    const unknown = container.querySelector('[data-testid="work-record-live-state"]');
    expect(unknown?.getAttribute("data-state")).toBe("unknown");
    expect(unknown?.getAttribute("data-animated")).toBe("false");
  });

  it("marks inherited iteration values without combining them with other fields", async () => {
    const inherited = record("child", "程序开发", {
      parentRecordId: "root",
      iterationId: "iteration-a",
      iterationAssignmentMode: "inherit_parent",
    });
    const rootRecord = record("root", "工作包", { iterationId: "iteration-a" });
    await render("plan", [rootRecord, inherited], vi.fn(), { "iteration-a": "迭代 A" }, {
      versionLabels: { "version-1": "V1" },
      iterationVersionIds: { "iteration-a": "version-1" },
    });

    const childRow = container.querySelector('[data-record-id="child"]');
    expect(childRow?.textContent).toContain("V1");
    expect(childRow?.textContent).toContain("继承 · 迭代 A");
    expect(childRow?.textContent).not.toContain("程序开发 · V1");
  });

  it("shows defect fields and statuses in Chinese while keeping status filters stable", async () => {
    const defect = record("defect", "登录失败提示", {
      kind: "defect",
      recordIdentifier: "PC-1",
      businessStatus: "todo",
      priority: "high",
      defectSeverity: "critical",
      foundInVersionId: "version-1",
    });
    await render("defect", [defect], vi.fn(), {}, { versionLabels: { "version-1": "V1" } });

    const row = container.querySelector('[data-record-id="defect"]');
    expect(container.textContent).toContain("验收者");
    expect(container.textContent).toContain("发现版本");
    expect(row?.textContent).toContain("待办");
    expect(row?.textContent).toContain("高");
    expect(row?.textContent).toContain("致命");
    expect(row?.textContent).toContain("V1");

    const reviewTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "审查中") as HTMLButtonElement;
    expect(reviewTab).not.toBeNull();
    await act(async () => reviewTab.click());
    expect(container.querySelector('[data-record-id="defect"]')).toBeNull();
    const allTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "全部缺陷") as HTMLButtonElement;
    await act(async () => allTab.click());
    expect(container.querySelector('[data-record-id="defect"]')).not.toBeNull();
  });

  it("adds new defect fields to old personal views without changing their visibility", async () => {
    const legacy = defaultWorkRecordViewConfig("defect");
    legacy.columnOrder = legacy.columnOrder.filter((field) => field !== "priority" && field !== "foundInVersion");
    legacy.visibleFields = legacy.visibleFields.filter((field) => field !== "priority" && field !== "foundInVersion");
    viewsMock.mockResolvedValueOnce([
      { id: "builtin:defect", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "defect", name: "全部", isBuiltin: true, config: defaultWorkRecordViewConfig("defect"), revision: 0, updatedAt: null },
      { id: "legacy-view", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "defect", name: "旧视图", isBuiltin: false, config: legacy, revision: 1, updatedAt: null },
    ]);
    await render("defect", [record("defect", "缺陷", { kind: "defect" })]);
    const legacyView = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="work-record-view-toolbar"] button')].find((button) => button.textContent === "旧视图")!;
    await act(async () => legacyView.click());
    await flush();
    const columnsButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "列") as HTMLButtonElement;
    await act(async () => columnsButton.click());
    await flush();

    const priorityOption = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("优先级"));
    const foundVersionOption = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("发现版本"));
    expect(priorityOption).not.toBeUndefined();
    expect(foundVersionOption).not.toBeUndefined();
    expect((priorityOption?.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect((foundVersionOption?.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });

  it("keeps legacy combined version and iteration filters working after splitting the columns", async () => {
    const legacy = defaultWorkRecordViewConfig("plan");
    legacy.filters = [{ field: "iteration", operator: "is", value: "V1 / 迭代 A" }];
    viewsMock.mockResolvedValueOnce([
      { id: "builtin:plan", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "plan", name: "全部", isBuiltin: true, config: defaultWorkRecordViewConfig("plan"), revision: 0, updatedAt: null },
      { id: "legacy-filter", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "plan", name: "旧迭代筛选", isBuiltin: false, config: legacy, revision: 1, updatedAt: null },
    ]);
    await render("plan", [record("match", "匹配任务", { iterationId: "iteration-a" }), record("miss", "其他任务")], vi.fn(), { "iteration-a": "迭代 A" }, {
      versionLabels: { "version-1": "V1" },
      iterationVersionIds: { "iteration-a": "version-1" },
    });
    const legacyView = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="work-record-view-toolbar"] button')].find((button) => button.textContent === "旧迭代筛选")!;
    await act(async () => legacyView.click());
    await flush();

    expect(container.querySelector('[data-record-id="match"]')).not.toBeNull();
    expect(container.querySelector('[data-record-id="miss"]')).toBeNull();
  });

  it("does not misrepresent a complex status filter as a simple status tab", async () => {
    const complex = defaultWorkRecordViewConfig("defect");
    complex.filters = [{ field: "businessStatus", operator: "is_not", value: "done" }];
    viewsMock.mockResolvedValueOnce([
      { id: "builtin:defect", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "defect", name: "全部", isBuiltin: true, config: defaultWorkRecordViewConfig("defect"), revision: 0, updatedAt: null },
      { id: "complex-filter", companyId: "company-1", projectId: "project-1", userId: "user-1", viewKind: "defect", name: "未完成", isBuiltin: false, config: complex, revision: 1, updatedAt: null },
    ]);
    await render("defect", [
      record("todo", "待办缺陷", { kind: "defect", businessStatus: "todo" }),
      record("done", "完成缺陷", { kind: "defect", businessStatus: "done" }),
    ]);
    const complexView = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="work-record-view-toolbar"] button')].find((button) => button.textContent === "未完成")!;
    await act(async () => complexView.click());
    await flush();

    expect([...container.querySelectorAll('[role="tab"]')].every((tab) => tab.getAttribute("aria-selected") === "false")).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("复杂状态筛选");
    expect(container.querySelector('[data-record-id="todo"]')).not.toBeNull();
    expect(container.querySelector('[data-record-id="done"]')).toBeNull();

    const allTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "全部缺陷") as HTMLButtonElement;
    await act(async () => allTab.click());
    expect(container.querySelector('[data-record-id="todo"]')).not.toBeNull();
    expect(container.querySelector('[data-record-id="done"]')).not.toBeNull();
  });

  it("keeps twenty plan records in compact rows without card-per-record chrome", async () => {
    await render("plan", Array.from({ length: 20 }, (_, index) => record(`plan-${index + 1}`, `计划任务 ${index + 1}`)));

    const rows = [...container.querySelectorAll('[data-testid="work-record-table-row"]')];
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.classList.contains("h-9"))).toBe(true);
    expect(container.querySelector('[data-testid="work-record-view-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="work-record-filter-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="work-record-table-scroller"]')).not.toBeNull();
  });

  it("switches plan presets as tabs and limits 我的任务 to the signed-in human", async () => {
    const onChecked = vi.fn();
    await render("plan", [
      record("backlog", "待规划任务", { businessStatus: "backlog" }),
      record("active", "进行中任务", { businessStatus: "in_progress" }),
      record("review", "待审查任务", { businessStatus: "in_review" }),
      record("mine", "我的任务", { businessStatus: "todo", userResponsibilities: [{ userId: "user-1", role: "execution" }] }),
    ], onChecked, {}, { checked: ["backlog"], currentUserId: "user-1" });

    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "全部任务", "待规划", "进行中", "待审查", "我的任务",
    ]);
    const activeTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "进行中")!;
    await act(async () => activeTab.click());
    expect([...container.querySelectorAll('[data-testid="work-record-table-row"]')].map((row) => row.getAttribute("data-record-id"))).toEqual(["active"]);
    expect(onChecked).toHaveBeenCalledWith([]);

    const mineTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "我的任务")!;
    await act(async () => mineTab.click());
    expect([...container.querySelectorAll('[data-testid="work-record-table-row"]')].map((row) => row.getAttribute("data-record-id"))).toEqual(["mine"]);
  });

  it("matches the compact plan toolbar contract", async () => {
    await render("plan", [record("one", "任务一")]);

    const group = container.querySelector('select[aria-label="分组字段"]') as HTMLSelectElement;
    expect(group.options[0].textContent).toBe("任务层级");
    expect(container.querySelector('button[aria-label="展开或收起任务层级"]')).not.toBeNull();
    expect((container.querySelector('input[aria-label="搜索记录"]') as HTMLInputElement).placeholder).toBe("搜索名称或编号");
    expect(container.querySelector('select[aria-label="业务状态筛选"]')).toBeNull();
    expect([...container.querySelectorAll('select[aria-label="密度"] option')].map((option) => option.textContent)).toEqual(["紧凑", "舒适"]);
  });

  it("sorts from the column header without removing saved-view controls", async () => {
    await render("defect", [
      record("defect-b", "B 缺陷", { kind: "defect" }),
      record("defect-a", "A 缺陷", { kind: "defect" }),
    ]);

    const sort = container.querySelector('button[aria-label="按缺陷排序"]') as HTMLButtonElement;
    expect(sort).not.toBeNull();
    await act(async () => sort.click());

    expect([...container.querySelectorAll('[data-testid="work-record-table-row"]')].map((row) => row.getAttribute("data-record-id"))).toEqual(["defect-a", "defect-b"]);
    expect(sort.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(container.querySelector('[data-testid="work-record-view-toolbar"]')).not.toBeNull();
  });

  it("filters from its own column header", async () => {
    await render("defect", [
      record("todo", "待办缺陷", { kind: "defect", businessStatus: "todo" }),
      record("done", "完成缺陷", { kind: "defect", businessStatus: "done" }),
    ]);

    await act(async () => (container.querySelector('button[aria-label="筛选业务状态"]') as HTMLButtonElement).click());
    const filter = document.querySelector('input[aria-label="业务状态筛选值"]') as HTMLInputElement;
    await act(async () => setNativeValue(filter, "done"));
    expect([...container.querySelectorAll('[data-testid="work-record-table-row"]')].map((row) => row.getAttribute("data-record-id"))).toEqual(["done"]);
  });

  it("hides a column from its own header menu", async () => {
    await render("defect", [record("defect", "缺陷", { kind: "defect" })]);

    const menu = container.querySelector('button[aria-label="优先级列菜单"]') as HTMLButtonElement;
    await act(async () => menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    await flush();
    const hide = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("隐藏优先级列"));
    expect(hide).not.toBeUndefined();
    await act(async () => hide?.click()); await flush();
    expect([...container.querySelectorAll("th")].some((cell) => cell.textContent?.includes("优先级"))).toBe(false);
  });

  it("replaces the filter toolbar in place for selection and exposes honest action boundaries", async () => {
    const onChecked = vi.fn();
    const onDispatch = vi.fn();
    await render("plan", [record("selected", "已选任务")], onChecked, {}, {
      checked: ["selected"],
      batchActions: {
        dispatch: { label: "派发到待办", onInvoke: onDispatch, disabled: false, reason: null, pending: false },
        assignOwner: { label: "设置负责人", disabled: true, reason: "当前后端没有批量设置负责人接口", pending: false },
      },
    });

    const toolbar = container.querySelector('[data-testid="work-record-filter-toolbar"]') as HTMLElement;
    expect(toolbar.getAttribute("data-batch-active")).toBe("true");
    expect(toolbar.textContent).toContain("已选 1 项");
    expect(container.querySelector('input[aria-label="搜索记录"]')).toBeNull();
    expect((container.querySelector('button[aria-label="设置负责人"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('button[aria-label="设置负责人"]')?.getAttribute("title")).toContain("没有批量设置负责人接口");

    expect(container.querySelector('[data-record-id="selected"]')?.classList.contains("bg-primary/5")).toBe(true);
    await act(async () => (container.querySelector('button[aria-label="派发到待办"]') as HTMLButtonElement).click());
    expect(onDispatch).toHaveBeenCalledTimes(1);
    await act(async () => (container.querySelector('button[aria-label="取消选择"]') as HTMLButtonElement).click());
    expect(onChecked).toHaveBeenCalledWith([]);
  });

  it("selects only actionable rows from the header and supports keyboard column resizing", async () => {
    const onChecked = vi.fn();
    await render("plan", [record("one", "任务一"), record("two", "任务二")], onChecked);

    await act(async () => (container.querySelector('input[aria-label="选择当前可操作记录"]') as HTMLInputElement).click());
    expect(onChecked).toHaveBeenCalledWith(["one", "two"]);

    const resize = container.querySelector('[role="separator"][aria-label="任务调整列宽"]') as HTMLElement;
    const header = resize.closest("th") as HTMLTableCellElement;
    const widthBefore = header.style.width;
    await act(async () => resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(header.style.width).not.toBe(widthBefore);
  });
});
