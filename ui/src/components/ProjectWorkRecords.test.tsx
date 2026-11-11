// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkRecord } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { ApiError } from "@/api/client";
import { MemoryRouter } from "@/lib/router";
import { ProjectWorkRecords } from "./ProjectWorkRecords";

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const agentsMock = vi.hoisted(() => vi.fn());
const iterationsMock = vi.hoisted(() => vi.fn());
const versionsMock = vi.hoisted(() => vi.fn());
const capabilitiesMock = vi.hoisted(() => vi.fn());
const accountIdentityMock = vi.hoisted(() => ({ value: { userId: "user-1" as string | null, settled: true, failed: false } }));

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    list: listMock,
    create: createMock,
    update: updateMock,
    iterations: iterationsMock,
    versions: versionsMock,
    capabilities: capabilitiesMock,
  },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: agentsMock } }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => accountIdentityMock.value }));
vi.mock("@/components/WorkPackageConsole", () => ({
  WorkPackageConsole: ({ visibleKind, records, onReopenRecord, onEditRecord, onEditCoverage }: {
    visibleKind: "plan" | "defect";
    records: WorkRecord[];
    onReopenRecord?: (record: WorkRecord) => void;
    onEditRecord?: (record: WorkRecord, source: HTMLElement) => void;
    onEditCoverage?: (record: WorkRecord) => void;
  }) => (
    <div data-testid="console" data-kind={visibleKind}>
      {records.filter((record) => record.kind === visibleKind).map((record) => (
        <div key={record.id}>
          {record.title}
          {onReopenRecord ? <button onClick={() => onReopenRecord(record)}>重新打开测试</button> : null}
          {onEditRecord ? <button onClick={(event) => onEditRecord(record, event.currentTarget)}>编辑测试</button> : null}
          {onEditCoverage && record.packageQaRole === "execution" ? <button onClick={() => onEditCoverage(record)}>QA 覆盖测试</button> : null}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("@/components/WorkRecordContainerTree", () => ({
  WorkRecordContainerTree: ({ mode = "navigation", selectedScope = "pool", onSelectScope, onManageContainers, onCloseManagement }: {
    mode?: "navigation" | "management";
    selectedScope?: string;
    onSelectScope?: (scopeId: string) => void;
    onManageContainers?: () => void;
    onCloseManagement?: () => void;
  }) => mode === "management" ? (
    <section data-testid="container-admin-view">
      <h2>版本与迭代管理</h2>
      <button onClick={onCloseManagement}>返回需求池</button>
    </section>
  ) : (
    <aside data-testid="version-iteration-tree" data-selected-scope={selectedScope}>
      <button onClick={() => onSelectScope?.("pool")}>需求池</button>
      <button onClick={() => onSelectScope?.("version-1")}>V1</button>
      <button onClick={() => onSelectScope?.("iteration-1")}>迭代一</button>
      <button aria-label="版本与迭代管理" onClick={onManageContainers}>管理</button>
    </aside>
  ),
}));
vi.mock("@/components/WorkRecordGantt", () => ({
  WorkRecordGantt: () => <div data-testid="work-record-gantt" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(kind: "plan" | "defect", overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-02T00:00:00Z");
  return {
    id: `${kind}-1`, recordNumber: 1, recordIdentifier: kind === "plan" ? "PT-1" : "PC-1",
    companyId: "company-1", projectId: "project-1", kind,
    title: kind === "plan" ? "发布计划" : "窄屏缺陷", priority: "medium", description: null,
    descriptionRevision: 1, parentRecordId: null, iterationId: null, iterationAssignmentMode: "independent",
    plannedStartDate: null, plannedCompletionDate: null, defectSeverity: null, foundInVersionId: null,
    assigneeAgentId: null, qaAssigneeAgentId: null, userResponsibilities: [], packageQaRole: null,
    qaRetestExemptionReason: null, qaCoverageRecordIds: [],
    businessStatus: kind === "plan" ? "backlog" : "done",
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

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function button(text: string) {
  const match = [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match as HTMLButtonElement;
}

function buttonByLabel(label: string) {
  const match = [...document.body.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button not found by label: ${label}`);
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
    localStorage.clear();
    accountIdentityMock.value = { userId: "user-1", settled: true, failed: false };
    listMock.mockResolvedValue([plan, defect]);
    agentsMock.mockResolvedValue([]);
    iterationsMock.mockResolvedValue([
      { id: "iteration-a", versionId: "version-1", name: "迭代 A", archivedAt: null },
      { id: "iteration-b", versionId: "version-1", name: "迭代 B", archivedAt: null },
    ]);
    versionsMock.mockResolvedValue([{ id: "version-1", name: "V1" }]);
    capabilitiesMock.mockResolvedValue({ editRecords: { allowed: true }, manageContainers: { allowed: true } });
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
    localStorage.clear();
    await i18n.changeLanguage("zh-CN");
  });

  async function render(kind: "plan" | "defect", viewMode: "table" | "gantt" = "table", railProps: {
    railOpen?: boolean;
    onRailOpenChange?: (open: boolean) => void;
  } = {}) {
    await act(async () => root.render(
      <MemoryRouter initialEntries={[`/projects/project-1/${kind === "plan" ? "plans" : "defects"}`]}>
        <QueryClientProvider client={client}>
          <ProjectWorkRecords companyId="company-1" projectId="project-1" kind={kind} viewMode={viewMode} {...railProps} />
        </QueryClientProvider>
      </MemoryRouter>,
    ));
    await flush();
  }

  it("keeps the version and iteration rail mounted in gantt mode", async () => {
    await render("plan", "gantt");
    expect(container.querySelector('[data-testid="version-iteration-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="work-record-gantt"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="console"]')).toBeNull();
    expect(container.querySelector('[data-testid="work-record-workspace-grid"]')).not.toBeNull();
  });

  it("collapses the rail without unmounting business content", async () => {
    await render("plan");
    const toggle = container.querySelector('[data-testid="work-record-rail-toggle"]') as HTMLButtonElement;
    const workspace = container.querySelector('[data-testid="work-record-workspace-grid"]');
    const panel = container.querySelector(".work-record-rail-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(workspace?.getAttribute("data-rail-open")).toBe("true");

    await act(async () => toggle.click());

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(workspace?.getAttribute("data-rail-open")).toBe("false");
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-testid="version-iteration-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="console"]')).not.toBeNull();
  });

  it("reports rail state changes to a controlling project page", async () => {
    const onRailOpenChange = vi.fn();
    await render("plan", "table", { railOpen: false, onRailOpenChange });
    const toggle = container.querySelector('[data-testid="work-record-rail-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle.click());

    expect(onRailOpenChange).toHaveBeenCalledWith(true);
  });

  it("keeps the rail navigation mounted while the gear replaces only the main content with the container admin", async () => {
    await render("plan");

    await act(async () => (container.querySelector('button[aria-label="版本与迭代管理"]') as HTMLButtonElement).click());
    await flush();

    expect(container.querySelector('[data-testid="version-iteration-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="container-admin-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="console"]')).toBeNull();
    expect(container.querySelector('[data-testid="work-record-workspace-content"]')?.textContent).toContain("版本与迭代管理");

    await act(async () => button("返回需求池").click());
    expect(container.querySelector('[data-testid="container-admin-view"]')).toBeNull();
    expect(container.querySelector('[data-testid="console"]')).not.toBeNull();
  });

  it("filters plan records by the selected version or iteration without changing the record kind", async () => {
    const inIteration = record("plan", { id: "plan-in", title: "迭代内任务", iterationId: "iteration-1" });
    const outsideIteration = record("plan", { id: "plan-out", title: "其他迭代任务", iterationId: "iteration-2" });
    listMock.mockResolvedValue([inIteration, outsideIteration, defect]);
    iterationsMock.mockResolvedValue([
      { id: "iteration-1", versionId: "version-1", name: "迭代一", progress: { completed: 0, total: 1, percent: 0 } },
      { id: "iteration-2", versionId: "version-2", name: "迭代二", progress: { completed: 0, total: 1, percent: 0 } },
    ]);
    await render("plan");
    expect(container.textContent).toContain("迭代内任务");
    expect(container.textContent).toContain("其他迭代任务");

    await act(async () => button("V1").click());
    expect(container.querySelector('[data-testid="version-iteration-tree"]')?.getAttribute("data-selected-scope")).toBe("version-1");
    expect(container.textContent).toContain("迭代内任务");
    expect(container.textContent).not.toContain("其他迭代任务");

    await act(async () => button("需求池").click());
    expect(container.textContent).toContain("迭代内任务");
    expect(container.textContent).toContain("其他迭代任务");
  });

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

  it("defaults a new child to its parent iteration and submits inheritance explicitly", async () => {
    const parent = record("plan", { id: "parent-a", title: "工作包 A", iterationId: "iteration-a" });
    listMock.mockResolvedValue([parent]);
    await render("plan");
    await act(async () => button("新建计划").click());
    const title = document.body.querySelector('input[placeholder="例如：完成发布说明"]') as HTMLInputElement;
    const parentSelect = [...document.body.querySelectorAll("select")].find((node) => node.parentElement?.textContent?.includes("上级计划")) as HTMLSelectElement;
    await act(async () => {
      setNativeValue(title, "程序开发");
      setSelectValue(parentSelect, parent.id);
    });

    const assignment = document.body.querySelector('select[aria-label="迭代归属"]') as HTMLSelectElement;
    const iteration = document.body.querySelector('select[aria-label="迭代"]') as HTMLSelectElement;
    expect(assignment.value).toBe("inherit_parent");
    expect(iteration.disabled).toBe(true);
    expect(iteration.value).toBe("iteration-a");
    expect(document.body.textContent).toContain("跟随父任务：V1 / 迭代 A");

    await act(async () => button("保存计划").click());
    await flush();
    expect(createMock).toHaveBeenCalledWith("company-1", expect.objectContaining({
      parentRecordId: parent.id,
      iterationAssignmentMode: "inherit_parent",
      iterationId: null,
    }));
  });

  it("previews a new parent iteration and freezes it when an inherited child detaches", async () => {
    const firstParent = record("plan", { id: "parent-a", title: "工作包 A", iterationId: "iteration-a" });
    const secondParent = record("plan", { id: "parent-b", title: "工作包 B", iterationId: "iteration-b" });
    const child = record("plan", {
      id: "child",
      title: "程序开发",
      parentRecordId: firstParent.id,
      iterationId: "iteration-a",
      iterationAssignmentMode: "inherit_parent",
    });
    listMock.mockResolvedValue([child, firstParent, secondParent]);
    updateMock.mockImplementation(async (_companyId, _projectId, _recordId, patch) => ({ ...child, ...patch, iterationId: patch.iterationAssignmentMode === "inherit_parent" ? "iteration-b" : patch.iterationId, revision: 2 }));
    await render("plan");
    await act(async () => button("编辑测试").click());
    const parentSelect = [...document.body.querySelectorAll("select")].find((node) => node.parentElement?.textContent?.includes("上级计划")) as HTMLSelectElement;
    const assignment = document.body.querySelector('select[aria-label="迭代归属"]') as HTMLSelectElement;
    const iteration = document.body.querySelector('select[aria-label="迭代"]') as HTMLSelectElement;

    await act(async () => setSelectValue(parentSelect, secondParent.id));
    expect(assignment.value).toBe("inherit_parent");
    expect(iteration.value).toBe("iteration-b");
    expect(document.body.textContent).toContain("跟随父任务：V1 / 迭代 B");

    await act(async () => setSelectValue(parentSelect, ""));
    expect(assignment.value).toBe("independent");
    expect(assignment.disabled).toBe(true);
    expect(iteration.disabled).toBe(false);
    expect(iteration.value).toBe("iteration-b");
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

  it("keeps the defect editor focused on defect fields without losing hidden legacy data", async () => {
    const predecessor = record("defect", { id: "defect-predecessor", title: "历史前置缺陷" });
    const historical = record("defect", {
      id: "defect-history",
      title: "历史缺陷",
      plannedStartDate: "2026-11-01",
      plannedCompletionDate: "2026-11-12",
      iterationId: "iteration-a",
      dependencies: [{ predecessorRecordId: predecessor.id, title: predecessor.title, businessStatus: "done", dispatchState: "linked", holdReason: null }],
    });
    listMock.mockResolvedValue([historical, predecessor]);
    updateMock.mockImplementation(async (_companyId, _projectId, _recordId, patch) => ({ ...historical, ...patch, revision: 2 }));
    await render("defect");
    await act(async () => button("编辑测试").click());

    expect(document.body.textContent).not.toContain("计划开始");
    expect(document.body.textContent).not.toContain("前置记录");
    expect(document.body.textContent).toContain("计划完成");
    expect(document.body.querySelector('select[aria-label="迭代"]')).not.toBeNull();

    const title = document.body.querySelector('input[maxlength="500"]') as HTMLInputElement;
    vi.useFakeTimers();
    try {
      await act(async () => setNativeValue(title, "历史缺陷（已核对）"));
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    } finally {
      vi.useRealTimers();
    }
    const payload = updateMock.mock.calls.at(-1)?.[3];
    expect(payload.title).toBe("历史缺陷（已核对）");
    expect(payload).not.toHaveProperty("plannedStartDate");
    expect(payload).not.toHaveProperty("predecessorRecordIds");
  });

  it("does not rewrite dependencies when editing another field", async () => {
    const first = record("plan", { id: "plan-a", title: "策划" });
    const second = record("plan", { id: "plan-b", title: "程序" });
    const dependent = record("plan", { id: "plan-c", title: "验收", dependencies: [
      { predecessorRecordId: first.id, title: first.title, businessStatus: "done", dispatchState: "linked", holdReason: null },
      { predecessorRecordId: second.id, title: second.title, businessStatus: "done", dispatchState: "linked", holdReason: null },
    ] });
    listMock.mockResolvedValue([dependent, first, second]);
    updateMock.mockImplementation(async (_companyId, _projectId, _recordId, patch) => ({ ...dependent, ...patch, revision: 2 }));
    await render("plan");
    await act(async () => button("编辑测试").click());
    const predecessorGroup = [...document.body.querySelectorAll("fieldset")].find((node) => node.textContent?.includes("前置"));
    expect(predecessorGroup).toBeTruthy();
    expect([...predecessorGroup!.querySelectorAll('input[type="checkbox"]')].map((node) => (node as HTMLInputElement).checked)).toEqual([true, true]);
    const title = document.body.querySelector('input[maxlength="500"]') as HTMLInputElement;
    vi.useFakeTimers();
    try {
      await act(async () => setNativeValue(title, "验收（已核对）"));
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    } finally {
      vi.useRealTimers();
    }
    const payload = updateMock.mock.calls.at(-1)?.[3];
    expect(payload.title).toBe("验收（已核对）");
    expect(payload).not.toHaveProperty("predecessorRecordIds");
    expect(payload).not.toHaveProperty("dependencySetRevision");
  });

  it("updates QA coverage separately from the dependency form", async () => {
    const parent = record("plan", { id: "package-p", title: "工作包" });
    const execution = record("plan", { id: "task-b", title: "程序开发", parentRecordId: parent.id, packageQaRole: "execution" });
    const qa = record("plan", { id: "task-q", title: "QA 复测", parentRecordId: parent.id, packageQaRole: "qa", assigneeAgentId: "agent-q" });
    listMock.mockResolvedValue([execution, qa, parent]);
    await render("plan");
    await act(async () => button("QA 覆盖测试").click());
    const qaCheckbox = [...document.body.querySelectorAll('input[type="checkbox"]')].find((node) => node.parentElement?.textContent?.includes("QA 复测")) as HTMLInputElement;
    expect(qaCheckbox).toBeTruthy();
    await act(async () => qaCheckbox.click());
    await act(async () => button("保存 QA 覆盖").click());
    await flush();
    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", execution.id, {
      expectedRevision: execution.revision,
      qaCoverageRecordIds: [qa.id],
    });
  });

  it("uses the three-way decision and keeps a failed-save draft in place", async () => {
    await render("plan");
    await act(async () => button("编辑测试").click());
    const title = document.body.querySelector('input[maxlength="500"]') as HTMLInputElement;
    await act(async () => setNativeValue(title, "未保存标题"));

    await act(async () => buttonByLabel("关闭").click());
    await flush();
    expect(document.body.textContent).toContain("保存并继续");
    expect(document.body.textContent).toContain("放弃并继续");
    expect(button("留在此处")).toBe(document.activeElement);

    await act(async () => button("留在此处").click());
    await flush();
    expect((document.body.querySelector('input[maxlength="500"]') as HTMLInputElement).value).toBe("未保存标题");

    updateMock.mockRejectedValueOnce(new Error("数据库暂不可用"));
    await act(async () => buttonByLabel("关闭").click());
    await flush();
    await act(async () => button("保存并继续").click());
    await flush();
    expect((document.body.querySelector('input[maxlength="500"]') as HTMLInputElement).value).toBe("未保存标题");
    expect(document.body.textContent).toContain("数据库暂不可用");

    await act(async () => buttonByLabel("关闭").click());
    await flush();
    await act(async () => button("放弃并继续").click());
    await flush();
    expect(document.body.querySelector('input[maxlength="500"]')).toBeNull();
  });

  it.each(["plan", "defect"] as const)("uses one unified description field for %s records", async (kind) => {
    await render(kind);
    await act(async () => button("编辑测试").click());

    const drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    expect(drawer.querySelectorAll("textarea")).toHaveLength(1);
    expect(drawer.textContent).toContain("描述");
    for (const legacyLabel of ["任务说明", "完成标准", "复现步骤", "预期结果", "实际结果", "环境信息"]) {
      expect(drawer.textContent).not.toContain(legacyLabel);
    }
  });

  it("edits defect-only fields without exposing plan hierarchy controls", async () => {
    await render("defect");
    await act(async () => button("编辑测试").click());

    const drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    expect(drawer.textContent).not.toContain("上级计划");
    expect(drawer.textContent).not.toContain("迭代归属");
    const priority = drawer.querySelector('select[aria-label="优先级"]') as HTMLSelectElement;
    const severity = drawer.querySelector('select[aria-label="严重度"]') as HTMLSelectElement;
    const foundInVersion = drawer.querySelector('select[aria-label="发现版本"]') as HTMLSelectElement;
    await act(async () => {
      setSelectValue(priority, "high");
      setSelectValue(severity, "critical");
      setSelectValue(foundInVersion, "version-1");
    });
    await flush();

    expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", defect.id, expect.objectContaining({
      priority: "high",
      defectSeverity: "critical",
      foundInVersionId: "version-1",
    }));
  });

  it("opens records read-only for viewers and never exposes a save action", async () => {
    capabilitiesMock.mockResolvedValue({
      editRecords: { allowed: false, reason: "需要项目编辑权限；当前 Viewer 仅可查看。" },
      manageContainers: { allowed: false, reason: "需要项目管理权限。" },
    });
    await render("plan");
    await act(async () => button("编辑测试").click());

    const drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    expect(drawer.textContent).toContain("需要项目编辑权限；当前 Viewer 仅可查看。");
    expect([...drawer.querySelectorAll("input, select, textarea")].every((control) => control.matches(":disabled"))).toBe(true);
    expect([...drawer.querySelectorAll("button")].some((node) => node.textContent?.trim() === "保存计划")).toBe(false);
  });

  it("supports save shortcut, dirty Escape, clean Escape, visible save state, and source focus restoration", async () => {
    await render("plan");
    const source = button("编辑测试");
    await act(async () => source.click());
    let drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    expect(drawer.querySelector('[data-testid="work-record-save-state"]')?.textContent).toContain("已保存");

    const title = drawer.querySelector('input[maxlength="500"]') as HTMLInputElement;
    await act(async () => setNativeValue(title, "未保存标题"));
    expect(drawer.querySelector('[data-testid="work-record-save-state"]')?.textContent).toContain("等待自动保存");

    const dirtyEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => drawer.dispatchEvent(dirtyEscape));
    await flush();
    expect(document.body.querySelector('[data-testid="business-draft-decision"]')).not.toBeNull();
    await act(async () => button("留在此处").click());

    drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    const saveShortcut = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => drawer.dispatchEvent(saveShortcut));
    await flush();
    expect(saveShortcut.defaultPrevented).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="work-record-detail-drawer"]')).toBeNull();
    expect(document.activeElement).toBe(source);

    await act(async () => source.click());
    drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    const cleanEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => drawer.dispatchEvent(cleanEscape));
    await flush();
    expect(document.body.querySelector('[data-testid="work-record-detail-drawer"]')).toBeNull();
    expect(document.activeElement).toBe(source);
  });

  it("autosaves an edited record after the text debounce without closing the drawer", async () => {
    updateMock.mockImplementation(async (_companyId, _projectId, _recordId, patch) => ({ ...plan, ...patch, revision: 2 }));
    await render("plan");
    await act(async () => button("编辑测试").click());
    const drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    const title = drawer.querySelector('input[maxlength="500"]') as HTMLInputElement;
    vi.useFakeTimers();
    try {
      await act(async () => setNativeValue(title, "自动保存标题"));
      await act(async () => { await vi.advanceTimersByTimeAsync(899); });
      expect(updateMock).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(updateMock).toHaveBeenCalledWith("company-1", "project-1", plan.id, { expectedRevision: 1, title: "自动保存标题" });
      expect(document.body.querySelector('[data-testid="work-record-detail-drawer"]')).not.toBeNull();
      expect(document.body.querySelector('[data-testid="work-record-save-state"]')?.textContent).toContain("已保存");
      expect(localStorage.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an atomic conflict choice before retrying an overlapping edit", async () => {
    const remote = record("plan", { priority: "critical", revision: 2 });
    listMock.mockResolvedValueOnce([plan, defect]).mockResolvedValueOnce([remote, defect]);
    updateMock
      .mockRejectedValueOnce(new ApiError("conflict", 409, {}))
      .mockResolvedValueOnce(record("plan", { priority: "high", revision: 3 }));
    await render("plan");
    await act(async () => button("编辑测试").click());
    const priority = document.body.querySelector('select[aria-label="优先级"]') as HTMLSelectElement;
    await act(async () => setSelectValue(priority, "high"));
    await flush();

    const conflict = document.body.querySelector('[data-testid="work-record-autosave-conflict"]') as HTMLElement;
    expect(conflict).not.toBeNull();
    expect(conflict.textContent).toContain("优先级");
    await act(async () => button("保留我的").click());
    await flush();
    expect(updateMock).toHaveBeenLastCalledWith("company-1", "project-1", plan.id, { expectedRevision: 2, priority: "high" });
  });

  it("blocks discard while an immediate autosave request is in flight", async () => {
    const pending = deferred<WorkRecord>();
    updateMock.mockReturnValueOnce(pending.promise);
    await render("plan");
    await act(async () => button("编辑测试").click());
    const priority = document.body.querySelector('select[aria-label="优先级"]') as HTMLSelectElement;
    await act(async () => setSelectValue(priority, "high"));
    await flush();
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => buttonByLabel("关闭").click());
    await flush();
    const discard = button("放弃并继续");
    expect(discard.disabled).toBe(true);
    await act(async () => discard.click());
    expect(document.body.querySelector('[data-testid="work-record-detail-drawer"]')).not.toBeNull();

    await act(async () => { pending.resolve(record("plan", { priority: "high", revision: 2 })); await Promise.resolve(); });
    await flush();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor read-only until both capability and account identity are confirmed", async () => {
    const capability = deferred<{ editRecords: { allowed: boolean }; manageContainers: { allowed: boolean } }>();
    capabilitiesMock.mockReturnValueOnce(capability.promise);
    accountIdentityMock.value = { userId: null, settled: false, failed: false };
    await render("plan");
    expect(button("新建计划").disabled).toBe(true);
    await act(async () => button("编辑测试").click());
    const drawer = document.body.querySelector('[data-testid="work-record-detail-drawer"]') as HTMLElement;
    expect([...drawer.querySelectorAll("input, select, textarea")].every((control) => control.matches(":disabled"))).toBe(true);
    const title = drawer.querySelector('input[maxlength="500"]') as HTMLInputElement;
    await act(async () => setNativeValue(title, "不应进入草稿"));
    await flush();
    expect(updateMock).not.toHaveBeenCalled();

    accountIdentityMock.value = { userId: "user-1", settled: true, failed: false };
    await act(async () => capability.resolve({ editRecords: { allowed: true }, manageContainers: { allowed: true } }));
    await render("plan");
    expect((document.body.querySelector('input[maxlength="500"]') as HTMLInputElement).value).toBe(plan.title);
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
    expect(document.body.textContent).not.toContain("Save Plan");
    expect(buttonByLabel("Close")).toBeTruthy();

    await act(async () => buttonByLabel("Close").click());
    await flush();
    await act(async () => button("New Plan").click());
    expect(document.body.textContent).toContain("Save Plan");
  });
});
