import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { localizeRuntimeMessage } from "./runtime-message-localization";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("runtime message localization", () => {
  it.each([
    [
      "Waiting for execution recovery. Your message is saved.",
      "正在等待执行恢复，你的消息已保存。",
    ],
    [
      "The agent has reached its daily limit. Your message is saved until work can resume.",
      "智能体已达到每日额度上限；你的消息已保存，恢复后会继续处理。",
    ],
    ["New conversation session", "新会话已开始"],
    ["Scheduled retry was requested to run now", "已请求立即执行计划重试"],
  ])("localizes server runtime message %s", async (message, expected) => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeRuntimeMessage(message)).toBe(expected);
  });

  it("preserves unknown diagnostic text", async () => {
    await i18n.changeLanguage("zh-CN");
    const diagnostic = "Provider returned an opaque code ABC-42";
    expect(localizeRuntimeMessage(diagnostic)).toBe(diagnostic);
  });
});
