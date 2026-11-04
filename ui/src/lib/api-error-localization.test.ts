import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { localizeApiErrorMessage } from "./api-error-localization";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("API error localization", () => {
  it.each([
    ["unauthorized", 401, "登录状态无效，请重新登录。"],
    ["Internal server error", 500, "服务器发生错误，请稍后重试。"],
    ["Validation error", 422, "提交内容未通过验证。"],
    ["Execution workspace is not reopenable", 409, "此执行工作区无法重新打开。"],
    ["Failed to rebuild the execution workspace", 500, "重建执行工作区失败。"],
    ["Release is waiting for durable delivery", 409, "正在等待可靠交付完成。"],
    ["Provider vault is disabled.", 422, "提供商密钥库已停用。"],
    ["Provider vault runtime is locked while coming soon.", 422, "提供商密钥库运行功能尚未开放。"],
    [
      "An existing secret already links this exact provider reference.",
      409,
      "已有密钥关联到相同的提供商引用。",
    ],
  ])("localizes generic server error %s", async (message, status, expected) => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeApiErrorMessage(message, status)).toBe(expected);
  });

  it("uses status-aware copy for the transport fallback", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeApiErrorMessage("Request failed: 429", 429)).toBe("请求过于频繁，请稍后重试。");
  });

  it("preserves a specific diagnostic that has no safe translation", async () => {
    await i18n.changeLanguage("zh-CN");
    const diagnostic = "Repository URL must include an owner and name: acme";
    expect(localizeApiErrorMessage(diagnostic, 422)).toBe(diagnostic);
  });

  it("preserves an existing Chinese server explanation", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeApiErrorMessage("项目已归档，不能继续修改。", 409)).toBe("项目已归档，不能继续修改。");
  });
});
