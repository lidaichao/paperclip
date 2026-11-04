import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, api: mockApi };
});

import { heartbeatsApi } from "./heartbeats";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { i18n } from "../i18n";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("heartbeatsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests summary rows for hot-path history consumers", async () => {
    await heartbeatsApi.list("company-1", undefined, 200, { summary: true });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?limit=200&summary=true");
  });

  it("keeps full row requests as the default for run-history screens", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 25);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?agentId=agent-1&limit=25");
  });
});

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });
});

describe("heartbeatsApi.downloadProviderTrace", () => {
  it("initiates tenant-session recovery for a direct trace download", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const request = heartbeatsApi.downloadProviderTrace("run-1");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("localizes a direct trace download failure", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Trace archive unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(heartbeatsApi.downloadProviderTrace("run-1")).rejects.toMatchObject({
      message: "服务器发生错误，请稍后重试。",
      rawMessage: "Trace archive unavailable",
      status: 503,
    });
  });

  it("uses a Chinese fallback when a trace download has no error body", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(null, { status: 503 }),
    ));

    await expect(heartbeatsApi.downloadProviderTrace("run-1")).rejects.toMatchObject({
      rawMessage: "请求失败（状态码 503）。",
      status: 503,
    });
  });
});
