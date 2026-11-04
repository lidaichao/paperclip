import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { formatLastRunTimestamp, formatRoutineRunStatus } from "./RoutineList";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("routine list localization", () => {
  it("keeps known English status labels readable", async () => {
    await i18n.changeLanguage("en");
    expect(formatLastRunTimestamp(null)).toBe("never");
    expect(formatRoutineRunStatus("received")).toBe("Received");
    expect(formatRoutineRunStatus("issue_created")).toBe("Issue created");
  });

  it("localizes empty timestamps and every routine run status in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatLastRunTimestamp(null)).toBe("从未");
    expect([
      "received",
      "coalesced",
      "skipped",
      "issue_created",
      "completed",
      "failed",
    ].map(formatRoutineRunStatus)).toEqual([
      "已接收",
      "已合并",
      "已跳过",
      "已创建任务",
      "已完成",
      "失败",
    ]);
  });
});
