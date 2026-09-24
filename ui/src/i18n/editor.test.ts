import { afterEach, expect, it } from "vitest";
import { i18n } from "./index";
import { translateEditor } from "./editor";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("localizes editor accessibility text and preserves the English option", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(translateEditor("contentArea.editableMarkdown", "editable markdown")).toBe("可编辑的 Markdown 内容");
  await i18n.changeLanguage("en");
  expect(translateEditor("contentArea.editableMarkdown", "editable markdown")).toBe("editable markdown");
});

it("falls back when an upstream editor message changes", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(translateEditor("contentArea.editableMarkdown", "New upstream wording")).toBe("New upstream wording");
});

it("does not recursively interpolate user URLs or change their bytes", async () => {
  await i18n.changeLanguage("zh-CN");
  const url = "https://example.com/{{secret}}?q=%E4%B8%AD";
  expect(translateEditor("linkPreview.open", "Open {{url}} in new window", { url, secret: "must not expand" }))
    .toBe("在新窗口中打开 " + url);
});
