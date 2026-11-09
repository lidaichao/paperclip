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
const updateVersionMock = vi.hoisted(() => vi.fn());
const mutateVersionMock = vi.hoisted(() => vi.fn());
const mutateIterationMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    versions: versionsMock,
    iterations: iterationsMock,
    createVersion: vi.fn(),
    createIteration: vi.fn(),
    updateVersion: updateVersionMock,
    updateIteration: vi.fn(),
    mutateVersion: mutateVersionMock,
    mutateIteration: mutateIterationMock,
    deleteVersion: vi.fn(),
    deleteIteration: vi.fn(),
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
    mutateVersionMock.mockResolvedValue({ ...version, revision: 2 });
    mutateIterationMock.mockResolvedValue({ ...iteration, revision: 2 });
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

  async function render(writable = true) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkRecordContainerTree companyId="company-1" projectId="project-1" writable={writable} /></QueryClientProvider>));
    await flush();
  }

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

  it("hides every write entry for a read-only user", async () => {
    await render(false);
    expect(host.textContent).toContain("只读");
    expect(host.querySelector('button[aria-label^="编辑"]')).toBeNull();
    expect(host.querySelector('button[aria-label$="操作菜单"]')).toBeNull();
    expect(host.querySelector('input[aria-label="新版本名称"]')).toBeNull();
  });

  it("keeps archive out of the row menu and places it in the edit dialog without a cancel button", async () => {
    await render();
    const menuTrigger = button("V1 操作菜单");
    await act(async () => {
      menuTrigger.focus();
      menuTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    });
    await flush();

    const menu = document.body.querySelector('[data-slot="dropdown-menu-content"]');
    expect(menu?.textContent).toContain("编辑");
    expect(menu?.textContent).toContain("删除空容器");
    expect(menu?.textContent).not.toContain("归档");
    await act(async () => menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    await flush();

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
    expect(document.body.querySelector('[data-testid="container-edit-form"]')).toBeNull();
    expect(updateVersionMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editButton);
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
    await render();
    await act(async () => button("编辑版本 V1").click());
    const restore = button("恢复");
    expect(restore.getAttribute("data-testid")).toBe("container-lifecycle-action");
    await act(async () => restore.click());
    await flush();
    expect(mutateVersionMock).toHaveBeenLastCalledWith("company-1", "project-1", version.id, "restore", version.revision);
  });
});
