// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkRecord } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { ProjectWorkRecords } from "./ProjectWorkRecords";

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const agentsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: { list: listMock, create: createMock, update: updateMock },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: agentsMock } }));
vi.mock("@/components/WorkPackageConsole", () => ({
  WorkPackageConsole: ({ visibleKind, records, onReopenRecord, onEditRecord }: {
    visibleKind: "plan" | "defect";
    records: WorkRecord[];
    onReopenRecord?: (record: WorkRecord) => void;
    onEditRecord?: (record: WorkRecord) => void;
  }) => (
    <div data-testid="console" data-kind={visibleKind}>
      {records.filter((record) => record.kind === visibleKind).map((record) => (
        <div key={record.id}>
          {record.title}
          {onReopenRecord ? <button onClick={() => onReopenRecord(record)}>重新打开测试</button> : null}
          {onEditRecord ? <button onClick={() => onEditRecord(record)}>编辑测试</button> : null}
        </div>
      ))}
    </div>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(kind: "plan" | "defect", overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-02T00:00:00Z");
  return {
    id: `${kind}-1`, companyId: "company-1", projectId: "project-1", kind,
    title: kind === "plan" ? "发布计划" : "窄屏缺陷", description: null,
    descriptionRevision: 1, parentRecordId: null, iterationId: null,
    assigneeAgentId: null, qaAssigneeAgentId: null, packageQaRole: null,
    qaRetestExemptionReason: null, qaCoverageRecordIds: [],
    businessStatus: kind === "plan" ? "backlog" : "done",
    statusVersion: 1, revision: 1, dispatchState: "not_dispatched", dispatchRound: 0,
    dependencySetRevision: 1, blockedCycle: 0, dependencies: [],
    execution: { issueId: null, issueIdentifier: null, issueStatus: null, issueStatusVersion: null, lastRunId: null, lastRunStatus: null, lastRunAgentId: null, lastRunStartedAt: null, lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: now },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: now },
    delivery: { eventKey: null, deliveryState: null, deliveredAt: null, attemptCount: 0, lastError: null, wakeRequestId: null, wakeStatus: null, acknowledgedAt: null, runId: null, recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null },
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

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(text: string) {
  const match = [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match as HTMLButtonElement;
}

describe("ProjectWorkRecords", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const plan = record("plan");
  const defect = record("defect");

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    listMock.mockResolvedValue([plan, defect]);
    agentsMock.mockResolvedValue([]);
    createMock.mockResolvedValue(plan);
    updateMock.mockResolvedValue(defect);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(async () => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
  });

  async function render(kind: "plan" | "defect") {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <ProjectWorkRecords companyId="company-1" projectId="project-1" kind={kind} />
      </QueryClientProvider>,
    ));
    await flush();
  }

  it("saves a plan without creating any execution object", async () => {
    await render("plan");
    expect(container.querySelector('[data-testid="console"]')?.getAttribute("data-kind")).toBe("plan");
    expect(container.textContent).toContain("发布计划");
    expect(container.textContent).not.toContain("窄屏缺陷");

    await act(async () => button("新建计划").click());
    const title = document.body.querySelector('input[placeholder="例如：完成发布说明"]') as HTMLInputElement;
    const description = document.body.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(title, "Demo 发布说明");
      setNativeValue(description, "只保存，不派发");
    });
    await act(async () => button("保存计划").click());
    await flush();

    expect(createMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      projectId: "project-1", kind: "plan", title: "Demo 发布说明", description: "只保存，不派发",
    }));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reopens the same defect record in place", async () => {
    await render("defect");
    expect(container.querySelector('[data-testid="console"]')?.getAttribute("data-kind")).toBe("defect");
    expect(container.textContent).toContain("窄屏缺陷");
    expect(container.textContent).not.toContain("发布计划");

    await act(async () => button("重新打开测试").click());
    await flush();

    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", defect.id, {
      expectedRevision: defect.revision,
      businessStatus: "todo",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("preserves all existing predecessors when editing another field", async () => {
    const first = record("plan", { id: "plan-a", title: "策划" });
    const second = record("plan", { id: "plan-b", title: "程序" });
    const dependent = record("plan", { id: "plan-c", title: "验收", dependencies: [
      { predecessorRecordId: first.id, title: first.title, businessStatus: "done", dispatchState: "linked", holdReason: null },
      { predecessorRecordId: second.id, title: second.title, businessStatus: "done", dispatchState: "linked", holdReason: null },
    ] });
    listMock.mockResolvedValue([dependent, first, second]);
    await render("plan");
    await act(async () => button("编辑测试").click());
    const predecessorGroup = [...document.body.querySelectorAll("fieldset")].find((node) => node.textContent?.includes("前置"));
    expect(predecessorGroup).toBeTruthy();
    expect([...predecessorGroup!.querySelectorAll('input[type="checkbox"]')].map((node) => (node as HTMLInputElement).checked)).toEqual([true, true]);
    await act(async () => button("保存计划").click());
    await flush();
    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", dependent.id, expect.objectContaining({
      predecessorRecordIds: [first.id, second.id],
    }));
  });

  it("switches fixed form and status copy to English while preserving record titles", async () => {
    await i18n.changeLanguage("en");
    await render("plan");
    expect(container.textContent).toContain("发布计划");
    await act(async () => button("编辑测试").click());
    expect(document.body.textContent).toContain("Edit Plan");
    expect(document.body.textContent).toContain("Business status");
    const statusSelect = [...document.body.querySelectorAll("select")].find((node) => node.value === "backlog");
    expect(statusSelect?.textContent).toContain("Backlog");
    expect((document.body.querySelector('input[maxlength="500"]') as HTMLInputElement)?.value).toBe("发布计划");
    expect(document.body.textContent).toContain("Save Plan");
  });
});
