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

vi.mock("@/api/work-records", () => ({
  workRecordsApi: {
    versions: versionsMock,
    iterations: iterationsMock,
    createVersion: vi.fn(),
    createIteration: vi.fn(),
    updateVersion: updateVersionMock,
    updateIteration: vi.fn(),
    mutateVersion: vi.fn(),
    mutateIteration: vi.fn(),
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
});
