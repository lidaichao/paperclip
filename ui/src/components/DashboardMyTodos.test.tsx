// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkRecordKind, WorkRecordMyTodo } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardMyTodos } from "./DashboardMyTodos";

const myTodosMock = vi.hoisted(() => vi.fn());
const myTodoPreferenceMock = vi.hoisted(() => vi.fn());
const putMyTodoPreferenceMock = vi.hoisted(() => vi.fn());
const projectsListMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    myTodos: (...args: unknown[]) => myTodosMock(...args),
    myTodoPreference: (...args: unknown[]) => myTodoPreferenceMock(...args),
    putMyTodoPreference: (...args: unknown[]) => putMyTodoPreferenceMock(...args),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: (...args: unknown[]) => projectsListMock(...args) },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function todo(kind: WorkRecordKind, index: number): WorkRecordMyTodo {
  return {
    id: `${kind}-${index}`,
    recordNumber: index,
    recordIdentifier: `${kind === "plan" ? "PT" : "PC"}-${index}`,
    companyId: "company-1",
    projectId: "project-1",
    projectName: "星海计划",
    kind,
    title: `${kind === "plan" ? "任务" : "缺陷"}-${index}`,
    priority: "high",
    businessStatus: kind === "plan" ? "todo" : "in_progress",
    plannedCompletionDate: "2026-11-11",
    roles: kind === "plan" ? ["execution"] : ["qa"],
    executionState: "idle",
    updatedAt: new Date("2026-11-10T00:00:00Z"),
  };
}

describe("DashboardMyTodos", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    myTodoPreferenceMock.mockResolvedValue({
      config: { visibleFields: ["due", "status"], columnOrder: ["due", "status", "project", "roles"], density: "compact", sort: "due", defaultProjectId: null },
      revision: 0,
      updatedAt: null,
    });
    projectsListMock.mockResolvedValue([]);
    myTodosMock.mockImplementation((_companyId: string, filter: { kind: WorkRecordKind }) => Promise.resolve({
      items: Array.from({ length: filter.kind === "plan" ? 20 : 3 }, (_, index) => todo(filter.kind, index + 1)),
      nextCursor: null,
    }));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={client}><DashboardMyTodos companyId="company-1" /></QueryClientProvider>));
    await flushReact();
  }

  it("keeps task and defect status filters independent", async () => {
    await render();
    const planSelect = container.querySelector<HTMLSelectElement>('[data-testid="my-todos-plan"] select');
    const defectSelect = container.querySelector<HTMLSelectElement>('[data-testid="my-todos-defect"] select');
    expect(planSelect).not.toBeNull();
    expect(defectSelect).not.toBeNull();

    await act(async () => {
      planSelect!.value = "blocked";
      planSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(myTodosMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "plan", status: "blocked" }));
    expect(defectSelect!.value).toBe("");
    expect(myTodosMock).not.toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "defect", status: "blocked" }));
  });

  it("renders twenty assigned tasks as compact rows instead of cards", async () => {
    await render();
    const taskGroup = container.querySelector('[data-testid="my-todos-plan"]');
    const rows = taskGroup?.querySelectorAll("li") ?? [];
    expect(rows).toHaveLength(20);
    expect(rows[0]?.querySelector("a")?.className).toContain("my-todo-row");
    expect(taskGroup?.querySelector(".my-todo-columns")).not.toBeNull();
    expect(container.querySelector('[data-testid="my-todo-groups"]')).not.toBeNull();
    expect(taskGroup?.querySelectorAll("article")).toHaveLength(0);
  });
});
