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
    expect(enumLabel("revision_requested")).toBe("已要求修改");
    expect(enumLabel("oauth_failed")).toBe("OAuth 认证失败");
    expect(enumLabel("file_info_unknown")).toBe("文件信息状态未知");
    expect(enumLabel("preview_url")).toBe("预览链接");
    expect(enumLabel("needs_board_review")).toBe("需要管理层审核");
    expect(enumLabel("job")).toBe("作业");
    expect(enumLabel("ephemeral")).toBe("临时");
    expect(enumLabel("cleanup_failed")).toBe("清理失败");
    expect(enumLabel("script")).toBe("脚本");
    expect(enumLabel("asset")).toBe("资源");
  });

  it("keeps English labels readable", async () => {
    await i18n.changeLanguage("en");

    expect(enumLabel("not_dispatched")).toBe("Not Dispatched");
  });
});
