import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { appCopyFor, credentialFieldLabel } from "./app-gallery-copy";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("app gallery copy", () => {
  it("renders curated and fallback copy in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(appCopyFor("github")).toEqual({
      tagline: "读取代码和拉取请求，并评论议题。",
      short: "读取代码和拉取请求，并评论议题。",
    });
    expect(appCopyFor("unknown-app")).toEqual({
      tagline: "授权智能体访问此应用。",
      short: "授权智能体访问此应用。",
    });
    expect(credentialFieldLabel("示例应用", "MCP token", 1)).toBe(
      "你的 示例应用 密钥",
    );
  });
});
