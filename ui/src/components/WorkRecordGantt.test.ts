import { describe, expect, it } from "vitest";
import { ganttFromDay, ganttToDay, shiftGanttDate } from "./WorkRecordGantt";

describe("WorkRecordGantt date operations", () => {
  it("moves dates atomically across month boundaries", () => {
    expect(shiftGanttDate("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftGanttDate("2026-12-01", -1)).toBe("2026-11-30");
  });

  it("round trips UTC calendar days without timezone drift", () => {
    expect(ganttFromDay(ganttToDay("2026-03-08"))).toBe("2026-03-08");
  });
});
