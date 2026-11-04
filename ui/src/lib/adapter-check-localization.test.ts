import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  adapterCheckLevelLabel,
  localizeAdapterEnvironmentCheck,
} from "./adapter-check-localization";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

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
});
