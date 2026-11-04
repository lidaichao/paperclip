import { afterEach, describe, expect, it } from "vitest";
import { enumLabel } from "./display";
import { i18n } from "./index";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("enumLabel", () => {
  it("localizes shared runtime statuses in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(enumLabel("success")).toBe("成功");
    expect(enumLabel("processed")).toBe("已处理");
    expect(enumLabel("preparing")).toBe("准备中");
    expect(enumLabel("informational")).toBe("信息");
    expect(enumLabel("not_dispatched")).toBe("未派发");
    expect(enumLabel("ended")).toBe("已结束");
  });

  it("keeps English labels readable", async () => {
    await i18n.changeLanguage("en");

    expect(enumLabel("not_dispatched")).toBe("Not Dispatched");
  });
});
