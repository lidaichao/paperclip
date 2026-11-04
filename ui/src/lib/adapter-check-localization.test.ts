import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  adapterCheckLevelLabel,
  localizeAdapterEnvironmentCheck,
} from "./adapter-check-localization";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

function adapterEnvironmentTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return adapterEnvironmentTestFiles(path);
    return entry.name === "test.ts" ? [path] : [];
  });
}

describe("adapter check localization", () => {
  it("localizes Cursor authentication checks without changing their codes", async () => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code: "cursor_native_auth_present",
      level: "info",
      message: "Cursor is authenticated via `agent login`.",
    });

    expect(check.code).toBe("cursor_native_auth_present");
    expect(check.message).toBe("Cursor 原生认证已就绪。");
    expect(adapterCheckLevelLabel(check.level)).toBe("信息");
  });

  it("keeps technical paths while localizing a Codex working-directory result", async () => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code: "codex_cwd_valid",
      level: "info",
      message: "Working directory is valid: C:\\work\\alice",
    });

    expect(check.message).toBe("工作目录有效：C:\\work\\alice");
  });

  it("localizes Codex ACP recovery guidance", async () => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code: "codex_acp_credentials_missing",
      level: "warn",
      message: "No Codex ACP credentials visible to the Paperclip server were detected.",
      hint: "Set OPENAI_API_KEY or run codex login.",
    });

    expect(check.message).toBe("Alice 服务器未检测到可用的 Codex ACP 凭据。");
    expect(check.hint).toBe("请完成 Codex 登录或配置 API 密钥，然后重新探测。");
    expect(adapterCheckLevelLabel(check.level)).toBe("警告");
  });

  it("uses the correct provider name for shared adapter checks", async () => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code: "gemini_cwd_valid",
      level: "info",
      message: "Working directory is valid: /workspace/alice",
    });

    expect(check.message).toBe("工作目录有效：/workspace/alice");

    const runtime = localizeAdapterEnvironmentCheck({
      code: "gemini_acp_runtime_scaffold",
      level: "info",
      message: "Gemini ACP runtime execution is available through the shared ACP engine.",
    });
    expect(runtime.message).toBe("可通过共享 ACP 引擎执行 Gemini ACP。");
  });

  it.each([
    ["gemini_api_key_missing", "未检测到显式 API 密钥；Gemini CLI 仍可使用 OAuth 登录。"],
    ["kimi_auth_detected", "Kimi 认证凭据已配置。"],
    ["claude_hello_probe_usage_limited", "Claude 认证正常，但当前用量额度已耗尽。"],
  ])("localizes provider authentication result %s", async (code, expected) => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code,
      level: "warn",
      message: "Untranslated provider authentication result.",
      hint: "Untranslated recovery guidance.",
    });

    expect(check.message).toBe(expected);
    expect(check.hint).not.toContain("Untranslated");
  });

  it.each([
    ["opencode_models_discovered", "已发现 OpenCode 可用模型。"],
    ["pi_model_required", "Pi 必须配置模型后才能运行。"],
    ["cursor_cloud_model_unknown", "Cursor 配置的模型不可用。"],
  ])("localizes model result %s", async (code, expected) => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code,
      level: "warn",
      message: "Untranslated model result.",
    });

    expect(check.message).toBe(expected);
  });

  it.each([
    ["openclaw_gateway_url_missing", "OpenClaw 网关必须配置 WebSocket 地址。"],
    ["openclaw_gateway_probe_ok", "OpenClaw 网关连接探测成功。"],
    ["hermes_gateway_health_unreachable", "无法连接 Hermes 网关健康检查端点。"],
    ["cursor_cloud_repo_missing", "Cursor 必须配置代码仓库地址。"],
  ])("localizes remote adapter result %s", async (code, expected) => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code,
      level: "error",
      message: "Untranslated remote adapter result.",
      hint: "Untranslated remote adapter guidance.",
    });

    expect(check.message).toBe(expected);
    expect(check.hint).not.toContain("Untranslated");
  });

  it("localizes common diagnostic details while preserving technical values", async () => {
    await i18n.changeLanguage("zh-CN");

    const check = localizeAdapterEnvironmentCheck({
      code: "cursor_cloud_auth_ok",
      level: "info",
      message: "Cursor API key is valid.",
      detail: "Authenticated as jack@example.com.",
    });

    expect(check.message).toBe("Cursor 认证凭据有效。");
    expect(check.detail).toBe("认证账号：jack@example.com");
  });

  it("does not leak backend English for any static adapter environment check code", async () => {
    await i18n.changeLanguage("zh-CN");
    const adaptersRoot = resolve(process.cwd(), "..", "packages", "adapters");
    const codes = adapterEnvironmentTestFiles(adaptersRoot)
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/code:\s*"([^"]+)"/g)])
      .map((match) => match[1])
      .filter((code, index, all) => all.indexOf(code) === index)
      .sort();
    const sentinel = "Untranslated backend environment check.";
    const untranslated = codes.filter((code) => localizeAdapterEnvironmentCheck({
      code,
      level: "info",
      message: sentinel,
    }).message === sentinel);

    expect(untranslated).toEqual([]);
  });
});
