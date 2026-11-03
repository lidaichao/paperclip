import { afterAll, beforeAll, describe, expect, it } from "vitest";

let toolActivityPresentation: typeof import("./tool-taxonomy").toolActivityPresentation;

beforeAll(async () => {
  const { i18n } = await import("../../i18n");
  await i18n.changeLanguage("zh-CN");
  ({ toolActivityPresentation } = await import("./tool-taxonomy"));
});

afterAll(async () => {
  const { i18n } = await import("../../i18n");
  await i18n.changeLanguage("en");
});

describe("中文工具动作词汇", () => {
  it("翻译已知工具、未知工具和 Alice MCP 来源", () => {
    expect(toolActivityPresentation({ name: "apply_patch" }).runningLabel).toBe("正在应用补丁");
    expect(toolActivityPresentation({ name: "tool call" }).runningLabel).toBe("正在运行未命名工具");

    const aliceRead = toolActivityPresentation({ name: "mcp.paperclip.get_task_context" });
    expect(aliceRead.runningLabel).toBe("正在读取任务上下文");
    expect(aliceRead.sourceLabel).toBe("Alice");
    expect(aliceRead.summaryGroup.singular).toBe("Alice 读取");
  });
});
