import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { announcementsApi } from "./announcements";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("announcements API localization", () => {
  it("localizes the visible error and retains the raw diagnostic", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(announcementsApi.current(new AbortController().signal)).rejects.toMatchObject({
      status: 500,
      message: "服务器发生错误，请稍后重试。",
      rawMessage: "Announcement request failed",
    });
  });
});
