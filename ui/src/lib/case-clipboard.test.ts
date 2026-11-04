import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { formatCaseClipboardMarkdown } from "./case-clipboard";

const caseData = {
  identifier: "PAP-C7",
  title: "Launch post",
  key: null,
  caseType: "blog_post",
  status: "done" as const,
  labels: [],
};

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("formatCaseClipboardMarkdown", () => {
  it("preserves the English clipboard format", async () => {
    await i18n.changeLanguage("en");
    expect(formatCaseClipboardMarkdown(caseData)).toBe([
      "# PAP-C7 Launch post",
      "",
      "- Key: None",
      "- Type: blog_post",
      "- Status: Done",
      "- Labels: None",
    ].join("\n"));
  });

  it("localizes clipboard metadata and missing values in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatCaseClipboardMarkdown(caseData)).toBe([
      "# PAP-C7 Launch post",
      "",
      "- 键：无",
      "- 类型：blog_post",
      "- 状态：已完成",
      "- 标签：无",
    ].join("\n"));
  });
});
