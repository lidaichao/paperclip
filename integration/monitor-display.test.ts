import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import {
  deriveMonitorState,
  displayMonitorRelative,
  formatMonitorEta,
  formatMonitorEtaDisplay,
  formatMonitorEtaLabel,
  formatMonitorOffset,
  formatMonitorOffsetDisplay,
} from "./issue-monitor";
import { buildMonitorSurfaceCopy } from "../components/IssueMonitorBanner";

const now = new Date("2026-07-17T20:00:00.000Z");
const minute = 60_000;
const after = (offset: number) => new Date(now.getTime() + offset);

afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("monitor presentation localization keeps raw time contracts", () => {
  it.each(["en", "zh-CN"])("preserves raw comparisons and state derivation in %s", async (locale) => {
    await i18n.changeLanguage(locale);
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    expect(formatMonitorEta(after(45_000), now)).toBe("in 45s");
    expect(formatMonitorEta(after(-59_999), now)).toBe("due now");
    expect(formatMonitorEta(after(-minute), now)).toBe("overdue by 1m");
    expect(formatMonitorEta(after(-minute), now).startsWith("overdue by ")).toBe(true);
    expect(formatMonitorOffset(after(10_000))).toBe("now");
    expect(formatMonitorOffset(after(-12 * minute))).toBe("12m ago");
    expect(deriveMonitorState({ monitorNextCheckAt: after(-minute) }, now).state).toBe("overdue");
  });

  it("localizes seconds, minutes, hours, days, due-now and overdue presentation", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatMonitorEtaDisplay(after(45_000), now)).toBe("45秒后");
    expect(formatMonitorEtaDisplay(after(5 * minute), now)).toBe("5分钟后");
    expect(formatMonitorEtaDisplay(after(132 * minute), now)).toBe("2小时 12分钟后");
    expect(formatMonitorEtaDisplay(after(3 * 24 * 60 * minute), now)).toBe("3天后");
    expect(formatMonitorEtaLabel(now, now)).toBe("现已到期");
    expect(formatMonitorEtaLabel(after(-18 * minute), now)).toBe("已逾期18分钟");
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    expect(formatMonitorOffsetDisplay(after(10_000))).toBe("现在");
    expect(formatMonitorOffsetDisplay(after(-12 * minute))).toBe("12分钟前");
  });

  it("keeps English display bytes and unknown user text unchanged", async () => {
    await i18n.changeLanguage("en");
    for (const raw of ["in 45s", "in 2h 12m", "overdue by 18m", "due now", "now", "12m ago"]) {
      expect(displayMonitorRelative(raw)).toBe(raw);
    }
    expect(formatMonitorEtaLabel(after(132 * minute), now)).toBe("In 2h 12m");
    expect(formatMonitorEtaLabel(after(-18 * minute), now)).toBe("Overdue by 18m");
    await i18n.changeLanguage("zh-CN");
    expect(displayMonitorRelative("in user-workspace")).toBe("in user-workspace");
    expect(displayMonitorRelative("C:/workspace/in 3m")).toBe("C:/workspace/in 3m");
  });

  it("renders translated banner/strip countdowns without changing warning classification", async () => {
    await i18n.changeLanguage("en");
    const issue = { monitorNextCheckAt: after(-18 * minute) };
    const state = deriveMonitorState(issue, now);
    const english = buildMonitorSurfaceCopy(state, now);
    expect(english?.stripTitle).toBe("Overdue by 18m");
    await i18n.changeLanguage("zh-CN");
    const chinese = buildMonitorSurfaceCopy(state, now);
    expect(chinese?.bannerTitle).toContain("已逾期18分钟");
    expect(chinese?.stripTitle).toBe("已逾期18分钟");
    expect(chinese?.tone).toBe(english?.tone);
    const future = buildMonitorSurfaceCopy(deriveMonitorState({ monitorNextCheckAt: after(5 * minute) }, now), now);
    expect(future?.stripTitle).toBe("5分钟后恢复");
  });
});
