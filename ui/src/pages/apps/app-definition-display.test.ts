import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { localizedBundledAppDescription } from "./app-definition-display";

describe("localizedBundledAppDescription", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps the original catalog description in English", async () => {
    await i18n.changeLanguage("en");
    expect(localizedBundledAppDescription("github", "GitHub", "Repository tools."))
      .toBe("Repository tools.");
  });

  it("uses the curated Chinese description for featured apps", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedBundledAppDescription("github", "GitHub", "Repository tools."))
      .toContain("代码仓库工具");
  });

  it("uses a Chinese fallback for every other bundled app", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedBundledAppDescription("airtable", "Airtable", "Provider tools."))
      .toBe("将 Airtable 连接到 Alice，供智能体在授权范围内使用。");
  });

  it("does not rewrite a user-authored custom app description", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizedBundledAppDescription(null, "内部工具", "这是团队自己填写的说明。"))
      .toBe("这是团队自己填写的说明。");
  });
});
