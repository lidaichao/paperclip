import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { i18n } from "../i18n";
import { auditApi } from "./audit";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("auditApi.exportAgentActionsCsv", () => {
  it("initiates tenant-session recovery for a direct CSV export", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const request = auditApi.exportAgentActionsCsv("company-1");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("localizes a direct export failure", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Export worker unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(auditApi.exportAgentActionsCsv("company-1")).rejects.toMatchObject({
      message: "服务器发生错误，请稍后重试。",
      rawMessage: "Export worker unavailable",
      status: 503,
    });
  });
});
