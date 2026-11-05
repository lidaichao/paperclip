import type { Announcement } from "@paperclipai/shared";

/** Localized copy for announcements that the remote feed currently ships in English. */
export function announcementForLocale(announcement: Announcement | null, locale: string): Announcement | null {
  if (!announcement || locale !== "zh-CN") return announcement;

  if (announcement.id === "2026-09-14-connectors") {
    return {
      ...announcement,
      eyebrow: "连接器上线",
      title: "让智能体使用所需的应用",
      description: "连接 Gmail、GitHub、Notion 等服务，并选择哪些智能体可以使用哪些账户和操作。",
      image: announcement.image ? { ...announcement.image, alt: "智能体与各自连接的应用" } : undefined,
      primaryAction: { ...announcement.primaryAction, label: "查看连接器" },
    };
  }

  // Preserve unknown announcements so new product notices are not silently lost.
  return announcement;
}
