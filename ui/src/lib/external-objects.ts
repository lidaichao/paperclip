import { l10n } from "../i18n";
import {
  AlertCircle,
  AlertOctagon,
  Archive,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Clock,
  CloudOff,
  GitMerge,
  GitPullRequest,
  KeyRound,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
  ExternalObjectStatusTone,
  ExternalObjectSummary,
  ExternalObjectSummaryItem,
} from "@paperclipai/shared";

/**
 * Lucide icon for each status category. The mapping is host-owned per the
 * Phase 1B security review — providers never inject inline React.
 */
export const externalObjectCategoryIcon: Record<string, LucideIcon> = {
  unknown: CircleDashed,
  open: CircleDot,
  waiting: Clock,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  blocked: AlertOctagon,
  closed: Circle,
  archived: Archive,
  auth_required: KeyRound,
  unreachable: CloudOff,
};

export const externalObjectCategoryIconDefault: LucideIcon = CircleDashed;

export function externalObjectIconForCategory(category: string): LucideIcon {
  return externalObjectCategoryIcon[category] ?? externalObjectCategoryIconDefault;
}

const EXTERNAL_OBJECT_ICON_KEYS: Record<string, LucideIcon> = {
  archive: Archive,
  check: CheckCircle2,
  "check-circle": CheckCircle2,
  circle: Circle,
  "circle-dot": CircleDot,
  clock: Clock,
  github: GithubIcon,
  "git-merge": GitMerge,
  "git-pull-request": GitPullRequest,
  key: KeyRound,
  loader: Loader2,
  "x-circle": XCircle,
};

export function externalObjectIconForKey(iconKey: string | null | undefined): LucideIcon | null {
  if (!iconKey) return null;
  return EXTERNAL_OBJECT_ICON_KEYS[iconKey] ?? null;
}

export function externalObjectIconForLiveness(liveness: string): LucideIcon | null {
  if (liveness === "auth_required") return KeyRound;
  if (liveness === "unreachable") return CloudOff;
  return null;
}

const CATEGORY_LABELS: Record<string, string> = {
  unknown: l10n("local.not_yet_resolved_60d1c681"),
  open: l10n("local.open_ed077f3d"),
  waiting: l10n("local.waiting_6e293a8c"),
  running: l10n("local.running_f4ccae29"),
  succeeded: l10n("local.succeeded_6d9a6f97"),
  failed: l10n("local.failed_031a8f0f"),
  blocked: l10n("local.blocked_18f2a094"),
  closed: l10n("local.closed_c21ead06"),
  archived: l10n("local.archived_bdb86505"),
  auth_required: l10n("local.authorization_required_47e796b6"),
  unreachable: l10n("local.unreachable_abaa46ad"),
};

export function externalObjectCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

const LIVENESS_LABELS: Record<string, string> = {
  unknown: l10n("local.not_yet_refreshed_cde59065"),
  fresh: l10n("local.fresh_f810b668"),
  stale: l10n("local.stale_40c9e59c"),
  auth_required: l10n("local.requires_auth_53d75ad8"),
  unreachable: l10n("local.unreachable_abaa46ad"),
};

export function externalObjectLivenessLabel(liveness: string): string {
  return LIVENESS_LABELS[liveness] ?? liveness.replace(/_/g, " ");
}

export function externalObjectDisplayStatusLabel(input: {
  providerKey: string | null | undefined;
  objectType: string | null | undefined;
  statusCategory: string;
  liveness: string;
  statusLabel?: string | null;
}): string {
  const trimmedStatusLabel = input.statusLabel?.trim();
  if (trimmedStatusLabel) return trimmedStatusLabel;
  const isGenericUrl = input.providerKey === "url" && input.objectType === "link";
  const hasKnownObjectType = Boolean(input.providerKey && input.objectType);
  if (input.statusCategory === "unknown" && hasKnownObjectType && !isGenericUrl) {
    if (input.liveness === "fresh") return l10n("local.status_unavailable_7eb5af92");
    return externalObjectLivenessLabel(input.liveness);
  }
  return externalObjectCategoryLabel(input.statusCategory);
}

/**
 * Higher number = more attention-worthy. The rollups in §5 sort by tone first.
 * Mirrors `externalObjectStatusToneSeverity` in `status-colors.ts`.
 */
const TONE_SEVERITY: Record<string, number> = {
  muted: 0,
  neutral: 1,
  success: 2,
  info: 3,
  warning: 4,
  danger: 5,
};

export function externalObjectToneSeverity(tone: string | null | undefined): number {
  if (!tone) return 0;
  return TONE_SEVERITY[tone] ?? 0;
}

const CATEGORY_TONE_FALLBACK: Record<string, ExternalObjectStatusTone> = {
  unknown: "muted",
  open: "info",
  waiting: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
  blocked: "danger",
  closed: "muted",
  archived: "muted",
  auth_required: "warning",
  unreachable: "danger",
};

export function externalObjectFallbackTone(
  category: ExternalObjectStatusCategory,
): ExternalObjectStatusTone {
  return CATEGORY_TONE_FALLBACK[category] ?? "neutral";
}

const PROVIDER_LABELS: Record<string, string> = {
  github: l10n("local.github_f911e414"),
  github_pull_request: l10n("local.github_f911e414"),
  github_issue: l10n("local.github_f911e414"),
  hubspot: l10n("local.hubspot_5f5f6ddd"),
  linear: "Linear",
  jira: l10n("local.jira_8b9b0b3f"),
  notion: "Notion",
  asana: "Asana",
};

export function externalObjectProviderLabel(providerKey: string | null | undefined): string {
  if (!providerKey) return l10n("local.external_68c114ea");
  const lookup = PROVIDER_LABELS[providerKey];
  if (lookup) return lookup;
  return providerKey
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  pull_request: l10n("local.pull_request_763fae51"),
  issue: l10n("local.issue_4a502846"),
  deployment: l10n("local.deployment_aee50b18"),
  workflow_run: l10n("local.workflow_run_d70a7c47"),
  ticket: l10n("local.ticket_14069429"),
  lead: l10n("local.lead_e3456bc1"),
  url_link: l10n("local.url_e7a241de"),
};

export function externalObjectTypeLabel(objectType: string | null | undefined): string {
  if (!objectType) return l10n("local.object_2958d416");
  return OBJECT_TYPE_LABELS[objectType] ?? objectType.replace(/_/g, " ");
}

export function externalObjectDisplayLabel(
  providerKey: string | null | undefined,
  objectType: string | null | undefined,
  displayKey?: string | null,
): string {
  const trimmedDisplayKey = displayKey?.trim();
  if (trimmedDisplayKey) return trimmedDisplayKey;
  if (providerKey === "url" && objectType === "link") return l10n("local.url_e7a241de");
  return `${externalObjectProviderLabel(providerKey)} ${externalObjectTypeLabel(objectType)}`;
}

/**
 * Sort summary items by severity-first ordering: danger → warning → info →
 * success → muted/neutral. Within a tone, items keep their incoming order so
 * server-side ordering (e.g. most recent change first) is preserved.
 */
export function sortExternalObjectsBySeverity<T extends ExternalObjectSummaryItem>(
  items: readonly T[],
): T[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTone = externalObjectToneSeverity(a.item.statusTone);
      const bTone = externalObjectToneSeverity(b.item.statusTone);
      if (aTone !== bTone) return bTone - aTone;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Compute the dominant tone in a summary — used by sidebar / list rollups.
 * Falls back to `null` when no objects are present or every tone is `muted`.
 */
export function dominantExternalObjectTone(
  summary: Pick<ExternalObjectSummary, "highestSeverity" | "objects"> | null | undefined,
): ExternalObjectStatusTone | null {
  if (!summary) return null;
  const tone = summary.highestSeverity;
  if (!tone) return null;
  if (externalObjectToneSeverity(tone) <= TONE_SEVERITY.muted) return null;
  return tone;
}

/**
 * For the sidebar / list rollup we want the count of objects matching the
 * dominant severity (e.g. "3 failed PRs"), not the global total. Returns 0
 * whenever the dominant tone is muted so callers can render based on the
 * count without double-checking the rollup-hide rule.
 */
export function externalObjectDominantCount(
  summary: Pick<ExternalObjectSummary, "highestSeverity" | "objects"> | null | undefined,
): number {
  if (!summary) return 0;
  const tone = dominantExternalObjectTone(summary);
  if (!tone) return 0;
  return summary.objects.filter((object) => object.statusTone === tone).length;
}

/**
 * Reduced motion support — match `prefers-reduced-motion: reduce` so the
 * spinning Loader2 stays static when requested. Hooks consume this via React
 * to react to runtime changes; non-hook callers can use the helper directly.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
