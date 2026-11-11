// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectIteration, ProjectVersion } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { WorkRecordContainerTree } from "./WorkRecordContainerTree";

const versionsMock = vi.hoisted(() => vi.fn());
const iterationsMock = vi.hoisted(() => vi.fn());
const createVersionMock = vi.hoisted(() => vi.fn());
const createIterationMock = vi.hoisted(() => vi.fn());
const updateVersionMock = vi.hoisted(() => vi.fn());
const updateIterationMock = vi.hoisted(() => vi.fn());
const mutateVersionMock = vi.hoisted(() => vi.fn());
const mutateIterationMock = vi.hoisted(() => vi.fn());
const deleteVersionMock = vi.hoisted(() => vi.fn());
const deleteIterationMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    versions: versionsMock,
    iterations: iterationsMock,
    createVersion: createVersionMock,
    createIteration: createIterationMock,
    updateVersion: updateVersionMock,
    updateIteration: updateIterationMock,
    mutateVersion: mutateVersionMock,
    mutateIteration: mutateIterationMock,
    deleteVersion: deleteVersionMock,
    deleteIteration: deleteIterationMock,
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const version: ProjectVersion = {
  id: "version-1", companyId: "company-1", projectId: "project-1", name: "V1", targetDate: "2026-11-30",
  revision: 1, archivedAt: null, createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"),
};
const iteration: ProjectIteration = {
  id: "iteration-1", companyId: "company-1", projectId: "project-1", versionId: version.id, name: "迭代一",
  startsOn: "2026-11-01", endsOn: "2026-11-15", revision: 1, archivedAt: null,
  createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"), progress: { completed: 2, total: 5, percent: 40 },
};
const archivedVersion: ProjectVersion = {
  ...version,
  id: "version-archived",
  name: "V0 已归档",
  archivedAt: new Date("2026-10-31"),
};
const archivedIteration: ProjectIteration = {
  ...iteration,
  id: "iteration-archived",
  name: "迭代归档",
  archivedAt: new Date("2026-11-09"),
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setNativeValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(name: string) {
  const found = [...document.body.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name);
  if (!found) throw new Error(`Button not found: ${name}`);
  return found as HTMLButtonElement;
}

describe("WorkRecordContainerTree", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;

  beforeEach(async () => {
    versionsMock.mockResolvedValue([version]);
    iterationsMock.mockResolvedValue([iteration]);
    updateVersionMock.mockResolvedValue({ ...version, revision: 2 });
    updateIterationMock.mockResolvedValue({ ...iteration, revision: 2 });
    createVersionMock.mockResolvedValue({ ...version, id: "version-created", name: "V2" });
    createIterationMock.mockResolvedValue({ ...iteration, id: "iteration-created", name: "迭代二" });
    mutateVersionMock.mockResolvedValue({ ...version, revision: 2 });
    mutateIterationMock.mockResolvedValue({ ...iteration, revision: 2 });
    deleteVersionMock.mockResolvedValue({ id: version.id, deleted: true });
    deleteIterationMock.mockResolvedValue({ id: iteration.id, deleted: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    vi.clearAllMocks();
  });

  async function render(writable = true, mode: "navigation" | "management" = "navigation", callbacks: {
    onSelectScope?: (scopeId: string) => void;
    onManageContainers?: () => void;
    onCloseManagement?: () => void;
  } = {}) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkRecordContainerTree companyId="company-1" projectId="project-1" writable={writable} mode={mode} {...callbacks} /></QueryClientProvider>));
    await flush();
  }

  it("uses the top create toolbar and a flat active-only version iteration tree", async () => {
    versionsMock.mockResolvedValue([version, archivedVersion]);
    iterationsMock.mockResolvedValue([iteration, archivedIteration, {
      ...iteration,
      id: "iteration-under-archived",
      versionId: archivedVersion.id,
      name: "随版本归档",
    }]);
    const onSelectScope = vi.fn();
    const onManageContainers = vi.fn();
    await render(true, "navigation", { onManageContainers, onSelectScope });

    expect(button("+版本")).toBeTruthy();
    expect(button("+迭代")).toBeTruthy();
    expect(button("版本与迭代管理")).toBeTruthy();
    const rail = host.querySelector('[data-testid="version-iteration-tree"]') as HTMLElement;
    const toolbar = host.querySelector('[data-testid="container-toolbar"]') as HTMLElement;
    expect(rail.className).not.toMatch(/rounded|border|bg-card/);
    expect(toolbar.className).toContain("flex");
    expect(toolbar.className).not.toContain("flex-wrap");
    expect(toolbar.querySelectorAll(":scope > button")).toHaveLength(3);
    expect(button("+版本").className).toContain("work-record-rail-create");
    expect(button("+迭代").className).toContain("work-record-rail-create");
    expect(host.querySelector('input[aria-label="新版本名称"]')).toBeNull();
    expect(host.querySelector('select[aria-label="迭代所属版本"]')).toBeNull();
    expect(host.textContent).toContain("V1");
    expect(host.textContent).toContain("迭代一");
    expect(host.textContent).not.toContain("V0 已归档");
    expect(host.textContent).not.toContain("迭代归档");
    expect(host.textContent).not.toContain("随版本归档");
    expect(host.querySelector('[data-version-id="version-1"]')?.className).not.toContain("rounded border");
    expect(host.querySelectorAll('button[aria-label^="编辑"]')).toHaveLength(2);
    expect(host.querySelector('button[aria-label$="操作菜单"]')).toBeNull();
    await act(async () => button("迭代一").click());
    expect(onSelectScope).toHaveBeenCalledWith(iteration.id);
    await act(async () => button("版本与迭代管理").click());
    expect(onManageContainers).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="container-manager"]')).toBeNull();
    expect(host.querySelector('[data-testid="container-navigation"]')).not.toBeNull();
  });

  it("creates versions and iterations from dialogs opened by the top toolbar", async () => {
    await render();
    await act(async () => button("+版本").click());
    let dialog = document.body.querySelector('[data-testid="container-create-form"]') as HTMLElement;
    await act(async () => setNativeValue(dialog.querySelector('input[aria-label="名称"]') as HTMLInputElement, "V2"));
    await act(async () => setNativeValue(dialog.querySelector('input[aria-label="目标日期"]') as HTMLInputElement, "2026-12-31"));
    await act(async () => button("创建版本").click());
    await flush();
    expect(createVersionMock).toHaveBeenCalledWith("company-1", "project-1", { name: "V2", targetDate: "2026-12-31" });
    expect(document.body.querySelector('[data-testid="container-create-form"]')).toBeNull();

    await act(async () => button("+迭代").click());
    dialog = document.body.querySelector('[data-testid="container-create-form"]') as HTMLElement;
    expect((dialog.querySelector('select[aria-label="所属版本"]') as HTMLSelectElement).value).toBe(version.id);
    await act(async () => setNativeValue(dialog.querySelector('input[aria-label="名称"]') as HTMLInputElement, "迭代二"));
    await act(async () => setNativeValue(dialog.querySelector('input[aria-label="开始日期"]') as HTMLInputElement, "2026-11-16"));
    await act(async () => setNativeValue(dialog.querySelector('input[aria-label="结束日期"]') as HTMLInputElement, "2026-11-30"));
    await act(async () => button("创建迭代").click());
    await flush();
    expect(createIterationMock).toHaveBeenCalledWith("company-1", "project-1", {
      versionId: version.id,
      name: "迭代二",
      startsOn: "2026-11-16",
      endsOn: "2026-11-30",
    });
  });

  it("renders a main-region two-level manager that includes archived containers and owns deletion", async () => {
    versionsMock.mockResolvedValue([version, archivedVersion]);
    iterationsMock.mockResolvedValue([iteration, archivedIteration]);
    const onCloseManagement = vi.fn();
    await render(true, "management", { onCloseManagement });
    const manager = host.querySelector('[data-testid="container-manager"]') as HTMLElement;
    expect(host.querySelector('[data-testid="version-iteration-tree"]')).toBeNull();
    expect(host.querySelector('[data-testid="container-admin-view"]')).not.toBeNull();
    expect(manager.textContent).toContain("版本管理");
    expect(manager.textContent).toContain("V1");
    expect(manager.textContent).toContain("V0 已归档");
    expect(manager.textContent).not.toContain("迭代一");
    expect(manager.textContent).not.toContain("迭代归档");
    expect(host.querySelector('button[aria-label$="操作菜单"]')).toBeNull();

    await act(async () => button("管理版本 V1").click());
    expect(manager.textContent).toContain("迭代一");
    expect(manager.textContent).toContain("迭代归档");
    await act(async () => button("删除迭代 迭代一").click());
    expect(document.body.querySelector('[data-testid="container-delete-confirmation"]')).not.toBeNull();
    await act(async () => button("取消").click());
    await act(async () => button("返回需求池").click());
    expect(onCloseManagement).toHaveBeenCalledOnce();
  });

  it("keeps the edit draft on 409 and retries against the reloaded revision", async () => {
    updateVersionMock.mockRejectedValueOnce(new ApiError("revision changed", 409, { currentRevision: 2 }));
    await render();
    await act(async () => button("编辑版本 V1").click());
    const name = document.body.querySelector('[data-testid="container-edit-form"] input:not([type="date"])') as HTMLInputElement;
    await act(async () => setNativeValue(name, "V1 我的修改"));
    await act(async () => button("保存").click());
    await flush();
    expect(name.value).toBe("V1 我的修改");
    expect(document.body.textContent).toContain("你的输入仍保留");

    versionsMock.mockResolvedValue([{ ...version, name: "V1 远端", revision: 2 }]);
    updateVersionMock.mockResolvedValue({ ...version, name: "V1 我的修改", revision: 3 });
    await act(async () => button("复制我的修改后重试").click());
    await flush();
    expect(updateVersionMock).toHaveBeenLastCalledWith("company-1", "project-1", version.id, expect.objectContaining({ expectedRevision: 2, name: "V1 我的修改" }));
  });

  it("keeps the parent version in every iteration update request", async () => {
    await render();
    await act(async () => button("编辑迭代 迭代一").click());
    const dialog = document.body.querySelector('[data-testid="container-edit-form"]') as HTMLElement;
    const name = dialog.querySelector('input:not([type="date"])') as HTMLInputElement;
    await act(async () => setNativeValue(name, "迭代一调整"));
    await act(async () => button("保存").click());
    await flush();

    expect(updateIterationMock).toHaveBeenCalledWith("company-1", "project-1", iteration.id, {
      expectedRevision: iteration.revision,
      versionId: version.id,
      name: "迭代一调整",
      startsOn: iteration.startsOn,
      endsOn: iteration.endsOn,
    });
  });

  it("hides every write entry for a read-only user", async () => {
    await render(false);
    expect(host.textContent).toContain("只读");
    expect(host.querySelector('button[aria-label^="编辑"]')).toBeNull();
    expect(host.querySelector('button[aria-label$="操作菜单"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some((item) => item.textContent?.trim() === "+版本")).toBe(false);
    expect(button("版本与迭代管理")).toBeTruthy();
  });

  it("keeps archive in the pencil edit dialog without a cancel button", async () => {
    await render();
    const editButton = button("编辑版本 V1");
    editButton.focus();
    await act(async () => editButton.click());
    const dialog = document.body.querySelector('[data-testid="container-edit-form"]') as HTMLElement;
    const footerButtons = [...dialog.querySelectorAll('[data-slot="dialog-footer"] button')];
    expect(footerButtons.map((item) => item.textContent?.trim())).toEqual(["归档", "保存"]);
    expect(footerButtons[0]?.getAttribute("data-variant")).toBe("destructive");
    expect(dialog.textContent).not.toContain("取消");

    const name = dialog.querySelector('input:not([type="date"])') as HTMLInputElement;
    await act(async () => setNativeValue(name, "V1 未保存"));
    expect(button("归档").disabled).toBe(true);
    expect(dialog.textContent).toContain("有未保存修改，请先保存后再归档");

    await act(async () => (dialog.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement).click());
    await flush();
    expect(document.body.querySelector('[data-testid="container-edit-form"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="container-discard-confirmation"]')).not.toBeNull();
    await act(async () => button("放弃修改").click());
    await flush();
    expect(document.body.querySelector('[data-testid="container-edit-form"]')).toBeNull();
    expect(updateVersionMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editButton);
  });

  it("protects a dirty edit from Escape and returns Escape in the confirmation to editing", async () => {
    await render();
    await act(async () => button("编辑版本 V1").click());
    const dialog = document.body.querySelector('[data-testid="container-edit-form"]') as HTMLElement;
    const name = dialog.querySelector('input:not([type="date"])') as HTMLInputElement;
    await act(async () => setNativeValue(name, "V1 未保存草稿"));

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    await flush();
    expect(document.body.querySelector('[data-testid="container-discard-confirmation"]')).not.toBeNull();
    expect(name.value).toBe("V1 未保存草稿");
    expect(document.activeElement).toBe(button("继续编辑"));

    const confirmation = document.body.querySelector('[data-testid="container-discard-confirmation"]') as HTMLElement;
    await act(async () => confirmation.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    await flush();
    expect(document.body.querySelector('[data-testid="container-discard-confirmation"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="container-edit-form"]')).not.toBeNull();
    expect(name.value).toBe("V1 未保存草稿");

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    await flush();
    await act(async () => button("放弃修改").click());
    await flush();
    expect(document.body.querySelector('[data-testid="container-edit-form"]')).toBeNull();
  });

  it("archives and restores from the lifecycle action in the edit dialog", async () => {
    await render();
    await act(async () => button("编辑版本 V1").click());
    await act(async () => button("归档").click());
    await flush();
    expect(mutateVersionMock).toHaveBeenCalledWith("company-1", "project-1", version.id, "archive", version.revision);

    versionsMock.mockResolvedValue([{ ...version, archivedAt: new Date("2026-11-09") }]);
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(host);
    await render(true, "management");
    expect(host.textContent).toContain("V1");
    await act(async () => button("编辑版本 V1").click());
    const restore = button("恢复");
    expect(restore.getAttribute("data-testid")).toBe("container-lifecycle-action");
    await act(async () => restore.click());
    await flush();
    expect(mutateVersionMock).toHaveBeenLastCalledWith("company-1", "project-1", version.id, "restore", version.revision);
  });
});
