import { l10n } from "../i18n";
/**
 * Prosumer copy for the Apps surface (PAP-10856).
 *
 * The P1a gallery manifest carries developer-flavoured taglines and credential
 * labels (e.g. "Connect Zapier-hosted MCP actions", "Zapier MCP token"). Those
 * strings would fail the vocabulary gate from PAP-10827 — no "MCP", "server",
 * "profile", "policy", "gateway", or "transport" anywhere on this surface. So
 * the UI never renders the raw manifest copy directly: it looks up plain copy
 * here, and `sanitizeProsumerCopy` is a final backstop for any free-text we do
 * surface (app names, fallback taglines).
 */

/** Words that must never appear in prosumer-facing copy on the Apps surface. */
const BANNED_WORDS = [
  "mcp",
  "server",
  "profile",
  "policy",
  "gateway",
  "transport",
  "stdio",
  "endpoint",
];

const BANNED_RE = new RegExp(`\\b(${BANNED_WORDS.join("|")})s?\\b`, "gi");

/**
 * Strip banned vocabulary from a free-text string as a last-resort backstop.
 * Prefer curated copy below; this only protects against manifest text we can't
 * fully control (e.g. a newly added gallery app with no curated entry yet).
 */
export function sanitizeProsumerCopy(text: string): string {
  return text
    .replace(BANNED_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export interface AppCopy {
  /** Two short lines for the gallery card (M2). */
  tagline: string;
  /** Single line for the connect step header (M3b). */
  short: string;
}

/**
 * Curated prosumer copy keyed by gallery key. Taken from the M-series wires
 * (https://happy-grove-jzyc.here.now/). Apps without an entry fall back to a
 * generic, gate-safe line.
 */
function appCopy(): Record<string, AppCopy> {
  return {
  zapier: {
    tagline: l10n("local.zapier_gallery_tagline_0c970001"),
    short: l10n("local.zapier_gallery_short_0c970002"),
  },
  github: {
    tagline: l10n("local.github_gallery_copy_0c970003"),
    short: l10n("local.github_gallery_copy_0c970003"),
  },
  slack: {
    tagline: l10n("local.slack_gallery_tagline_0c970004"),
    short: l10n("local.slack_gallery_short_0c970005"),
  },
  notion: {
    tagline: l10n("local.notion_gallery_copy_0c970006"),
    short: l10n("local.notion_gallery_copy_0c970006"),
  },
  railway: {
    tagline: l10n("local.railway_gallery_tagline_0c970007"),
    short: l10n("local.railway_gallery_short_0c970008"),
  },
  posthog: {
    tagline: l10n("local.posthog_gallery_tagline_0c970009"),
    short: l10n("local.posthog_gallery_short_0c970010"),
  },
  linear: {
    tagline: l10n("local.linear_gallery_copy_0c970011"),
    short: l10n("local.linear_gallery_copy_0c970011"),
  },
  "google-sheets": {
    tagline: l10n("local.google_sheets_gallery_tagline_0c970012"),
    short: l10n("local.google_sheets_gallery_short_0c970013"),
  },
  gmail: {
    tagline: l10n("local.gmail_gallery_copy_0c970014"),
    short: l10n("local.gmail_gallery_copy_0c970014"),
  },
  "google-drive": {
    tagline: l10n("local.google_drive_gallery_copy_0c970015"),
    short: l10n("local.google_drive_gallery_copy_0c970015"),
  },
  "google-docs": {
    tagline: l10n("local.google_docs_gallery_copy_0c970016"),
    short: l10n("local.google_docs_gallery_copy_0c970016"),
  },
  "google-slides": {
    tagline: l10n("local.google_slides_gallery_copy_0c970017"),
    short: l10n("local.google_slides_gallery_copy_0c970017"),
  },
  "google-calendar": {
    tagline: l10n("local.google_calendar_gallery_copy_0c970018"),
    short: l10n("local.google_calendar_gallery_copy_0c970018"),
  },
  "google-chat": {
    tagline: l10n("local.google_chat_gallery_copy_0c970019"),
    short: l10n("local.google_chat_gallery_copy_0c970019"),
  },
  "google-people": {
    tagline: l10n("local.google_people_gallery_copy_0c970020"),
    short: l10n("local.google_people_gallery_copy_0c970020"),
  },
  "google-workspace-search": {
    tagline: l10n("local.google_workspace_search_gallery_copy_0c970021"),
    short: l10n("local.google_workspace_search_gallery_copy_0c970021"),
  },
  hubspot: {
    tagline: l10n("local.hubspot_gallery_copy_0c970022"),
    short: l10n("local.hubspot_gallery_copy_0c970022"),
  },
  intercom: {
    tagline: l10n("local.intercom_gallery_copy_0c970023"),
    short: l10n("local.intercom_gallery_copy_0c970023"),
  },
  figma: {
    tagline: l10n("local.figma_gallery_copy_0c970024"),
    short: l10n("local.figma_gallery_copy_0c970024"),
  },
  stripe: {
    tagline: l10n("local.stripe_gallery_copy_0c970025"),
    short: l10n("local.stripe_gallery_copy_0c970025"),
  },
  context7: {
    tagline: l10n("local.context7_gallery_copy_0c970026"),
    short: l10n("local.context7_gallery_copy_0c970026"),
  },
  };
}

function genericAppCopy(): AppCopy {
  const copy = l10n("local.generic_app_gallery_copy_0c970027");
  return { tagline: copy, short: copy };
}

/** Curated, gate-safe copy for a gallery app. */
export function appCopyFor(key: string, fallbackTagline?: string | null): AppCopy {
  const curated = appCopy()[key];
  if (curated) return curated;
  if (fallbackTagline) {
    const cleaned = sanitizeProsumerCopy(fallbackTagline);
    if (cleaned) return { tagline: cleaned, short: cleaned };
  }
  return genericAppCopy();
}

/**
 * Label for a single credential field on the key-paste step (M3b). The raw
 * manifest label can contain banned vocab ("Zapier MCP token"), so for the
 * common single-field case we present "Your {App} key" per the wires; multi-
 * field apps fall back to a sanitized version of the manifest label.
 */
export function credentialFieldLabel(
  appName: string,
  rawLabel: string,
  fieldCount: number,
): string {
  if (fieldCount <= 1) return l10n("local.your_value_key_721683e8", {v0: (appName)});
  const cleaned = sanitizeProsumerCopy(rawLabel);
  return cleaned || l10n("local.your_value_key_721683e8", { v0: appName });
}
