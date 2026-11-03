import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { localizedCatalogSkillDescription, localizedSkillSourceLabel } from "./skill-catalog-display";

describe("skill catalog display localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps user-authored descriptions unchanged", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedCatalogSkillDescription("team/custom", "自定义技能", "团队自己填写的说明", null))
      .toBe("团队自己填写的说明");
  });

  it("shows the exact Chinese purpose of a bundled skill", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedCatalogSkillDescription(
      "paperclipai/bundled/quality/qa-acceptance",
      "qa-acceptance",
      "English fallback",
      "bundled",
    )).toContain("质量验收标准");
  });

  it("keeps the original description in English mode", async () => {
    await i18n.changeLanguage("en");
    expect(localizedCatalogSkillDescription(
      "paperclipai/bundled/quality/qa-acceptance",
      "qa-acceptance",
      "English fallback",
      "bundled",
    )).toBe("English fallback");
  });

  it("renames and localizes bundled source labels", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedSkillSourceLabel("Paperclip bundled")).toBe("Alice 内置");
  });
});
