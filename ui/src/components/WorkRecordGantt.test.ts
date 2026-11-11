// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkRecord } from "@paperclipai/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ganttFromDay, ganttToDay, shiftGanttDate } from "./WorkRecordGantt";
import { WorkRecordGantt } from "./WorkRecordGantt";

const updateMock = vi.hoisted(() => vi.fn());
const mutateDependencyMock = vi.hoisted(() => vi.fn());
const viewsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/work-records", () => ({ workRecordsApi: { update: updateMock, mutateDependency: mutateDependencyMock, views: viewsMock, createView: vi.fn(), updateView: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(id: string, title: string, overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-02T00:00:00Z");
  return {
    id, recordNumber: 1, recordIdentifier: "PT-1", title,
    companyId: "company-1", projectId: "project-1", kind: "plan", priority: "medium", description: null,
    descriptionRevision: 1, parentRecordId: null, iterationId: null, iterationAssignmentMode: "independent", plannedStartDate: null,
    plannedCompletionDate: null, defectSeverity: null, foundInVersionId: null, assigneeAgentId: null, qaAssigneeAgentId: null, userResponsibilities: [],
    packageQaRole: null, qaRetestExemptionReason: null, qaCoverageRecordIds: [], businessStatus: "backlog",
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

function pointer(target: Element, type: string, clientX: number) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 1 } });
  target.dispatchEvent(event);
}

function setNativeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("WorkRecordGantt date operations", () => {
  it("moves dates atomically across month boundaries", () => {
    expect(shiftGanttDate("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftGanttDate("2026-12-01", -1)).toBe("2026-11-30");
  });

  it("round trips UTC calendar days without timezone drift", () => {
    expect(ganttFromDay(ganttToDay("2026-03-08"))).toBe("2026-03-08");
  });
});

describe("WorkRecordGantt structural colors", () => {
  it("uses Paperclip neutral tokens instead of the legacy green-tinted structure", () => {
    const css = readFileSync(resolve(process.cwd(), "ui/src/index.css"), "utf8");
    const ganttStructure = css.slice(css.indexOf(".work-record-gantt-viewport"), css.indexOf(".my-todo-group"));
    expect(ganttStructure).not.toMatch(/#(?:e2e9e5|f5f8f6|5a6a64|edf1ee|596d62|172820|557064|b8d5c5|e7f3ec|145b43|465d53|74837d|adbbb0|63756a|fff)\b/i);
    expect(ganttStructure).toContain("background: var(--card)");
    expect(ganttStructure).toContain("border-color: var(--border)");
  });
});

describe("WorkRecordGantt interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const open = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    updateMock.mockResolvedValue({});
    viewsMock.mockResolvedValue([]);
    mutateDependencyMock.mockImplementation(async (_companyId, _projectId, input) => input.expectedRecords.map((item: { recordId: string; expectedRevision: number; expectedDependencySetRevision: number }) => record(item.recordId, item.recordId, { revision: item.expectedRevision + 1, dependencySetRevision: item.expectedDependencySetRevision + 1 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    vi.clearAllMocks();
  });

  async function render(records: WorkRecord[], writable = true, state: { loading?: boolean; loadError?: Error | null; onRetry?: () => void } = {}) {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(WorkRecordGantt, { companyId: "company-1", projectId: "project-1", records, writable, onOpen: open, ...state }))));
  }

  it("distinguishes loading, request failure and a real empty result", async () => {
    await render([], true, { loading: true });
    expect(host.querySelector('[data-testid="work-record-gantt"]')?.getAttribute("data-state")).toBe("loading");
    expect(host.textContent).toContain("正在加载甘特排期");

    const retry = vi.fn();
    await render([], true, { loadError: new Error("网络不可用"), onRetry: retry });
    expect(host.querySelector('[data-testid="work-record-gantt"]')?.getAttribute("data-state")).toBe("error");
    expect(host.querySelector('[data-testid="gantt-load-error"]')?.textContent).toContain("网络不可用");
    await act(async () => (host.querySelector('[data-testid="gantt-load-error"] button') as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalledTimes(1);

    await render([]);
    expect(host.querySelector('[data-testid="work-record-gantt"]')?.getAttribute("data-state")).toBe("empty");
    expect(host.querySelector('[data-testid="gantt-empty-state"]')?.textContent).toContain("暂无计划任务");
  });

  it("counts scheduled and unscheduled tasks and opens an unscheduled task", async () => {
    await render([
      record("scheduled", "已排期", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" }),
      record("unscheduled", "待排期", { recordIdentifier: "PT-36" }),
    ]);

    expect(host.querySelector('[data-testid="gantt-schedule-counts"]')?.textContent).toBe("已排期 1 · 未排期 1");
    const entry = [...host.querySelectorAll('[data-testid="gantt-unscheduled-records"] button')].find((button) => button.textContent?.includes("PT-36")) as HTMLButtonElement;
    expect(entry).not.toBeNull();
    await act(async () => entry.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "unscheduled" }), entry);
  });

  it("opens exact date editing on an empty-track click without writing", async () => {
    await render([record("a", "无日期任务")]);
    const track = host.querySelector('[aria-label="无日期任务 空日期轨道"]') as HTMLButtonElement;
    await act(async () => track.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), track);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("matches the demo toolbar and filters rows without changing records", async () => {
    await render([
      record("backlog", "待规划任务", { recordIdentifier: "PT-10", businessStatus: "backlog", plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" }),
      record("done", "完成任务", { recordIdentifier: "PT-20", businessStatus: "done", plannedStartDate: "2026-12-01", plannedCompletionDate: "2026-12-03" }),
    ]);

    expect((host.querySelector('input[aria-label="搜索甘特任务"]') as HTMLInputElement).placeholder).toBe("名称或编号");
    expect([...host.querySelectorAll('select[aria-label="时间粒度"] option')].map((option) => option.textContent)).toEqual(["日", "周（紧凑）", "适应排期"]);
    expect(host.querySelector('button[aria-label="适应排期范围"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="定位今天"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="gantt-month-header"]')).not.toBeNull();

    await act(async () => setSelectValue(host.querySelector('select[aria-label="甘特状态筛选"]') as HTMLSelectElement, "done"));
    expect([...host.querySelectorAll('[data-gantt-record-id]')].map((row) => row.getAttribute("data-gantt-record-id"))).toEqual(["done"]);
    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => setNativeValue(host.querySelector('input[aria-label="搜索甘特任务"]') as HTMLInputElement, "PT-10"));
    expect(host.querySelectorAll('[data-gantt-record-id]')).toHaveLength(0);
  });

  it("changes time scale and can center a real today range", async () => {
    await render([record("dated", "有日期", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" })]);
    const gantt = host.querySelector('[data-testid="work-record-gantt"]') as HTMLElement;
    await act(async () => setSelectValue(host.querySelector('select[aria-label="时间粒度"]') as HTMLSelectElement, "week"));
    expect(gantt.getAttribute("data-time-scale")).toBe("week");
    await act(async () => (host.querySelector('button[aria-label="定位今天"]') as HTMLButtonElement).click());
    expect(gantt.getAttribute("data-range-mode")).toBe("today");
    await act(async () => (host.querySelector('button[aria-label="适应排期范围"]') as HTMLButtonElement).click());
    expect(gantt.getAttribute("data-range-mode")).toBe("fit");
  });

  it("keeps work-package hierarchy visible and collapsible", async () => {
    const parent = record("parent", "工作包", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-15" });
    const child = record("child", "程序开发", { parentRecordId: parent.id, plannedStartDate: "2026-11-11", plannedCompletionDate: "2026-11-13" });
    const grandchild = record("qa", "QA 复测", { parentRecordId: child.id, plannedStartDate: "2026-11-14", plannedCompletionDate: "2026-11-15" });
    await render([parent, child, grandchild]);

    expect(host.querySelector('[data-gantt-record-id="qa"]')?.getAttribute("data-tree-depth")).toBe("2");
    const collapse = host.querySelector('button[aria-label="收起 工作包"]') as HTMLButtonElement;
    expect(collapse).not.toBeNull();
    await act(async () => collapse.click());
    expect(host.querySelector('[data-gantt-record-id="parent"]')).not.toBeNull();
    expect(host.querySelector('[data-gantt-record-id="child"]')).toBeNull();
    expect(host.querySelector('[data-gantt-record-id="qa"]')).toBeNull();
  });

  it("completes dependency creation with a keyboard target picker", async () => {
    const a = record("a", "策划", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-11" });
    const b = record("b", "开发", { plannedStartDate: "2026-11-12", plannedCompletionDate: "2026-11-13" });
    await render([a, b]);
    const handle = host.querySelector('[aria-label="从 策划 建立依赖"]') as HTMLElement;
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const target = host.querySelector('select[aria-label="依赖拖拽目标"]') as HTMLSelectElement;
    expect(target).not.toBeNull();
    await act(async () => setSelectValue(target, "b"));
    await act(async () => (host.querySelector('button[aria-label="确认依赖改连"]') as HTMLButtonElement).click());
    expect(mutateDependencyMock).toHaveBeenCalledWith("company-1", "project-1", expect.objectContaining({
      operation: "add", predecessorRecordId: "a", successorRecordId: "b",
    }));
  });

  it("does not bubble a resize key into the whole-bar move", async () => {
    await render([record("a", "排期任务", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" })]);
    const handle = host.querySelector('[aria-label="调整开始日期"]') as HTMLElement;
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", "a", expect.objectContaining({ plannedStartDate: "2026-11-11", plannedCompletionDate: "2026-11-12" }));
  });

  it("anchors empty-track drag at the pointer day and shows a live preview", async () => {
    await render([record("a", "无日期任务"), record("dated", "有日期", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" })]);
    const timeline = host.querySelector('[data-gantt-timeline="a"]') as HTMLElement;
    timeline.getBoundingClientRect = () => ({ left: 100, width: 336, top: 0, right: 436, bottom: 40, height: 40, x: 100, y: 0, toJSON: () => ({}) });
    const track = timeline.querySelector('button') as HTMLButtonElement;
    await act(async () => pointer(track, "pointerdown", 244));
    await act(async () => pointer(timeline.parentElement!, "pointermove", 292));
    expect(host.querySelector('[aria-label^="无日期任务，"]')?.getAttribute("aria-label")).toBe("无日期任务，2026-11-13 至 2026-11-15");
    await act(async () => pointer(timeline.parentElement!, "pointerup", 292));
    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", "a", expect.objectContaining({ plannedStartDate: "2026-11-13", plannedCompletionDate: "2026-11-15" }));
  });

  it("cancels drag with Escape and disables every mutation path for readers", async () => {
    await render([record("a", "只读任务", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" })], false);
    const bar = host.querySelector('[role="button"]') as HTMLElement;
    await act(async () => pointer(bar, "pointerdown", 100));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(updateMock).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("button")].filter((item) => item.textContent?.includes("撤销") || item.getAttribute("aria-label")?.startsWith("调整")).every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
  });

  it("reconnects one predecessor while preserving the other", async () => {
    const a = record("a", "A"); const c = record("c", "C"); const d = record("d", "D");
    const b = record("b", "B", { dependencies: [
      { predecessorRecordId: "a", title: "A", businessStatus: "backlog", dispatchState: "not_dispatched", holdReason: null },
      { predecessorRecordId: "c", title: "C", businessStatus: "backlog", dispatchState: "not_dispatched", holdReason: null },
    ] });
    await render([a, b, c, d]);
    expect(host.querySelector('[aria-label="A 到 B 的依赖线"]')?.tagName.toLowerCase()).toBe("path");
    expect(host.querySelector('[aria-label="C 到 B 的依赖线"]')?.tagName.toLowerCase()).toBe("path");
    const titleButton = host.querySelector('[data-gantt-record-id="b"] button') as HTMLButtonElement;
    await act(async () => titleButton.click());
    const reconnect = host.querySelector('[aria-label="改连 a"]') as HTMLSelectElement;
    await act(async () => { reconnect.value = "d"; reconnect.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mutateDependencyMock).toHaveBeenCalledWith("company-1", "project-1", {
      operation: "replace_source", predecessorRecordId: "a", successorRecordId: "b",
      replacementPredecessorRecordId: "d",
      expectedRecords: [{ recordId: "b", expectedRevision: 1, expectedDependencySetRevision: 1 }],
    });
  });
});
