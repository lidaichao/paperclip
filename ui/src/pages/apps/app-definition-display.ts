import type { AppDefinition, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { i18n } from "../../i18n";

export type AppGalleryDisplayEntry = AppDefinition & {
  key?: string;
  logoUrl?: string;
  tagline?: string;
  branding?: AppDefinition["branding"];
};

export function appDefinitionSlug(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.slug ?? entry?.key ?? "";
}

export function appDefinitionName(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.name ?? appDefinitionSlug(entry) ?? "App";
}

export function appDefinitionDescription(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.description ?? entry?.tagline ?? "";
}

const FEATURED_APP_DESCRIPTIONS_ZH: Record<string, string> = {
  arcade: "使用 Arcade MCP 连接提供的工具。",
  composio: "通过 Composio Connect 查找并使用已连接的应用。",
  executor: "使用 Executor MCP 连接提供的工具。",
  github: "为智能体提供代码仓库工具，也可从 GitHub 议题和拉取请求中发起及跟进工作。",
  gmail: "搜索和读取 Gmail 邮件，并在不开放发送权限的情况下创建草稿。",
  "google-calendar": "读取日历并管理 Google Calendar 日程。",
  "google-docs": "读取和更新 Google Docs 文档。",
  "google-drive": "在 Google Drive 中搜索、读取、新建和复制文件。",
  "google-sheets": "读取和更新 Google Sheets 表格。",
  "google-slides": "读取和更新 Google Slides 演示文稿。",
  jira: "连接 Jira 托管的 MCP 服务器。",
  linear: "创建、更新和读取 Linear 议题。",
  notion: "读取和更新 Notion 工作区中的页面。",
  posthog: "通过 PostHog 托管的 MCP 服务器分析产品使用、错误、功能开关和实验。",
  slack: "为智能体提供 Slack 工具，也可从 Slack 中发起和继续 Alice 工作。",
  zapier: "通过 Zapier 账户连接数千种应用。",
};

/** Localize bundled catalog copy without modifying user-authored app descriptions. */
export function localizedBundledAppDescription(
  slug: string | null | undefined,
  name: string,
  fallback: string,
): string {
  if (i18n.language !== "zh-CN" || !slug) return fallback;
  const featured = FEATURED_APP_DESCRIPTIONS_ZH[slug];
  if (featured) return featured;
  if (/provider-hosted MCP server/i.test(fallback)) {
    return `连接 ${name} 托管的 MCP 服务器。`;
  }
  return `将 ${name} 连接到 Alice，供智能体在授权范围内使用。`;
}

export function appDefinitionLogoUrl(entry: AppGalleryDisplayEntry | null | undefined): string | undefined {
  return entry?.branding?.logoUrl ?? entry?.logoUrl;
}

export function appDefinitionDarkLogoUrl(entry: AppGalleryDisplayEntry | null | undefined): string | undefined {
  return entry?.branding?.darkLogoUrl;
}

export function appApplicationSourceSlug(application: ToolApplication | null | undefined): string | null {
  if (!application) return null;
  const metadata = application.metadata;
  const source = metadata?.sourceTemplateKey ?? metadata?.galleryKey;
  if (typeof source === "string" && source.trim()) return source.trim();
  const key = application.applicationKey?.trim();
  if (!key) return null;
  const galleryPrefix = "app-gallery:";
  if (key.startsWith(galleryPrefix)) {
    const slug = key.slice(galleryPrefix.length).split(":")[0] || null;
    // Curated apps deliberately group multiple accounts by provider. Generic
    // URL apps use `link` only as a synthetic key, so grouping on it would make
    // every unrelated MCP server in the company look like the same app.
    return slug === "link" ? null : slug;
  }
  return key;
}

export function appConnectionSourceSlug(connection: ToolConnection | null | undefined): string | null {
  if (!connection) return null;
  const source = connection.config?.sourceTemplateKey ?? connection.transportConfig?.sourceTemplateKey;
  return typeof source === "string" && source.trim() ? source.trim() : null;
}
