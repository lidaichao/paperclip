import { describe, expect, it } from "vitest";
import type { Announcement } from "@paperclipai/shared";
import { announcementForLocale } from "./announcement-locale";

const connectors = {
  id: "2026-09-14-connectors",
  eyebrow: "Introducing Connectors",
  title: "Give your agents the access they need",
  description: "Connect Gmail, GitHub, Notion, and more.",
  image: { path: "connectors.png", alt: "Paperclip agents with connected apps." },
  primaryAction: { kind: "route", label: "Explore connectors", path: "/apps" },
} as Announcement;

describe("announcement locale", () => {
  it("translates the known remote announcement without changing its destination", () => {
    const translated = announcementForLocale(connectors, "zh-CN");
    expect(translated?.title).toBe("让智能体使用所需的应用");
    expect(translated?.description).toContain("GitHub");
    expect(translated?.primaryAction).toMatchObject({ label: "查看连接器", path: "/apps" });
    expect(translated?.image?.alt).toBe("智能体与各自连接的应用");
  });

  it("keeps the original card in English and preserves future notices", () => {
    expect(announcementForLocale(connectors, "en")).toBe(connectors);
    const future = { ...connectors, id: "future-english-card" };
    expect(announcementForLocale(future, "zh-CN")).toBe(future);
  });
});
