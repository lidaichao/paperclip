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
    [
      "Scheduled retry suppressed because issue dependencies are still blocked",
      "计划重试已被阻止：任务依赖仍未解除。",
    ],
    [
      "Conversation retry is waiting for a response to a pending question or approval",
      "会话重试正在等待待处理问题或审批的答复。",
    ],
    [
      "Scheduled replacement suppressed because another run owns task execution or checkout",
      "计划替换运行已被阻止：已有其他运行占用任务执行权或签出权。",
    ],
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
