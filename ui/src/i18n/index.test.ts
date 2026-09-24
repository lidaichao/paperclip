// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadRuntime(saved: string | null = null, storageError = false) {
  const getItem = vi.fn(() => {
    if (storageError) throw new DOMException("Storage unavailable", "SecurityError");
    return saved;
  });
  const setItem = vi.fn(() => {
    if (storageError) throw new DOMException("Storage unavailable", "SecurityError");
  });
  const reload = vi.fn();
  vi.stubGlobal("window", { localStorage: { getItem, setItem }, location: { reload } });
  const runtime = await import("./index");
  return { runtime, getItem, setItem, reload };
}

describe("interface language", () => {
  it("defaults to Chinese, exposes string translations and synchronizes document language", async () => {
    const { runtime, getItem } = await loadRuntime();
    expect(getItem).toHaveBeenCalledWith("paperclip.locale");
    expect(runtime.i18n.language).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(typeof runtime.l10n("app.noCompanies.title")).toBe("string");
    await runtime.i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("respects saved English and falls back to English when a Chinese message is unavailable", async () => {
    const { runtime } = await loadRuntime("en");
    expect(runtime.i18n.language).toBe("en");
    runtime.i18n.addResource("en", "translation", "runtimeTest.message", "Hello {{name}}");
    await runtime.i18n.changeLanguage("zh-CN");
    expect(runtime.l10n("runtimeTest.message", { name: "Jack" })).toBe("Hello Jack");
  });

  it("ignores unsupported saved values", async () => {
    const { runtime } = await loadRuntime("../../invalid");
    expect(runtime.i18n.language).toBe("zh-CN");
  });

  it("saves the stable locale identifier and reloads to update module-level labels", async () => {
    const { runtime, setItem, reload } = await loadRuntime();
    expect(runtime.setInterfaceLocale("en")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("paperclip.locale", "en");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("survives unavailable browser storage and does not reload without a saved preference", async () => {
    const { runtime, reload } = await loadRuntime(null, true);
    expect(runtime.i18n.language).toBe("zh-CN");
    expect(runtime.setInterfaceLocale("en")).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
