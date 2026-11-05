import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { routineActivitySummary } from "./RoutineActivityRow";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("routineActivitySummary", () => {
  it("localizes webhook-triggered run details in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(routineActivitySummary({
      id: "event-1",
      action: "routine.run_triggered",
      details: { source: "webhook", status: "issue_created" },
      createdAt: new Date("2026-11-05T00:00:00Z"),
    })).toBe("回调通知 · 任务已创建");
  });
});
