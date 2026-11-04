import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { i18n } from "../i18n";
import { healthApi } from "./health";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("healthApi", () => {
  it("initiates tenant-session recovery and keeps the bootstrap request pending", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = healthApi.get();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("localizes a direct health failure", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Health probe unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(healthApi.get()).rejects.toMatchObject({
      message: "服务器发生错误，请稍后重试。",
      rawMessage: "Health probe unavailable",
      status: 503,
    });
  });
});
