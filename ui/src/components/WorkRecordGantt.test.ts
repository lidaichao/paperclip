// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkRecord } from "@paperclipai/shared";
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

describe("WorkRecordGantt date operations", () => {
  it("moves dates atomically across month boundaries", () => {
    expect(shiftGanttDate("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftGanttDate("2026-12-01", -1)).toBe("2026-11-30");
  });

  it("round trips UTC calendar days without timezone drift", () => {
    expect(ganttFromDay(ganttToDay("2026-03-08"))).toBe("2026-03-08");
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

  async function render(records: WorkRecord[], writable = true) {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(WorkRecordGantt, { companyId: "company-1", projectId: "project-1", records, writable, onOpen: open }))));
  }

  it("opens exact date editing on an empty-track click without writing", async () => {
    await render([record("a", "无日期任务")]);
    const track = host.querySelector('[aria-label="无日期任务 空日期轨道"]') as HTMLButtonElement;
    await act(async () => track.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), track);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("anchors empty-track drag at the pointer day and shows a live preview", async () => {
    await render([record("a", "无日期任务"), record("dated", "有日期", { plannedStartDate: "2026-11-10", plannedCompletionDate: "2026-11-12" })]);
    const timeline = host.querySelector('[data-gantt-timeline="a"]') as HTMLElement;
    timeline.getBoundingClientRect = () => ({ left: 100, width: 336, top: 0, right: 436, bottom: 40, height: 40, x: 100, y: 0, toJSON: () => ({}) });
    const track = timeline.querySelector('button') as HTMLButtonElement;
    await act(async () => pointer(track, "pointerdown", 244));
    await act(async () => pointer(timeline.parentElement!, "pointermove", 292));
    expect(host.querySelector('[aria-label^="无日期任务，2026-11-14 至 2026-11-16"]')).not.toBeNull();
    await act(async () => pointer(timeline.parentElement!, "pointerup", 292));
    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", "a", expect.objectContaining({ plannedStartDate: "2026-11-14", plannedCompletionDate: "2026-11-16" }));
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
    const titleButton = [...host.querySelectorAll("button")].find((item) => [...item.querySelectorAll("span")].some((cell) => cell.textContent === "B")) as HTMLButtonElement;
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
