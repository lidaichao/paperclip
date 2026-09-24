import { l10n } from "../i18n";
import type { StatusCard, StatusCardRefreshPolicy } from "@paperclipai/shared";

/**
 * The lifecycle states a status card renders as on the board (plan §7,
 * wireframe `07-card-states.svg`). Derived from the stored `status_cards` row:
 * the persisted `state` enum plus `archivedAt`, `generatingIssueId` and
 * `pendingChangeCount`. Kept in one place so the board tile, detail drawer and
 * tests agree on the mapping.
 */
export type StatusCardLifecycle =
  | "compiling"
  | "fresh"
  | "stale"
  | "updating"
  | "error"
  | "paused_budget"
  | "paused_hours"
  | "archived";

/**
 * Map a card row to its display lifecycle. Precedence, highest first:
 * archived → compiling → error → paused → updating (a run is in flight) →
 * stale (pending changes) → fresh.
 */
export function deriveStatusCardLifecycle(
  card: Pick<StatusCard, "state" | "archivedAt" | "generatingIssueId" | "pendingChangeCount">,
): StatusCardLifecycle {
  if (card.archivedAt) return "archived";
  if (card.state === "compiling") return "compiling";
  if (card.state === "error") return "error";
  if (card.state === "paused_budget") return "paused_budget";
  if (card.state === "paused_hours") return "paused_hours";
  if (card.generatingIssueId) return "updating";
  if (card.pendingChangeCount > 0) return "stale";
  return "fresh";
}

export interface StatusCardLifecyclePresentation {
  label: string;
  /** Tailwind classes for the leading state dot. */
  dotClassName: string;
  /** Short human description used in the states reference and empty affordances. */
  description: string;
  /** Whether the tile should render a dashed "building" border. */
  dashedBorder: boolean;
  /** Whether the last-good summary should stay visible under a banner. */
  keepsLastSummary: boolean;
}

export const STATUS_CARD_LIFECYCLE_PRESENTATION: Record<
  StatusCardLifecycle,
  StatusCardLifecyclePresentation
> = {
  compiling: {
    label: l10n("local.setting_up_dbdf27e5"),
    dotClassName: "bg-cyan-400 animate-pulse",
    description: l10n("local.just_created_setting_up_and_generating_the_fi_226c1e3f"),
    dashedBorder: true,
    keepsLastSummary: false,
  },
  fresh: {
    label: l10n("local.fresh_f810b668"),
    dotClassName: "bg-emerald-400",
    description: l10n("local.summary_reflects_all_known_changes_nothing_pe_52934f2a"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  stale: {
    label: l10n("local.stale_40c9e59c"),
    dotClassName: "bg-amber-400",
    description: l10n("local.changes_are_pending_since_the_last_update_c681361c"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  updating: {
    // Blue (distinct from fresh-emerald and compiling-cyan) so an in-flight
    // update never reads as "fresh" on a glance-scan of the board.
    label: l10n("local.updating_0b5260e1"),
    dotClassName: "bg-blue-500 animate-pulse",
    description: l10n("local.an_update_is_streaming_in_now_0b749ec6"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  error: {
    label: l10n("local.error_54a0e8c1"),
    dotClassName: "bg-red-500",
    description: l10n("local.the_last_run_failed_the_last_good_summary_sta_3a1419dd"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_budget: {
    label: l10n("local.paused_budget_62ae6677"),
    dotClassName: "bg-orange-400",
    description: l10n("local.the_daily_token_cap_was_hit_auto_updates_are_7fb1a09a"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  paused_hours: {
    label: l10n("local.paused_hours_9e029267"),
    dotClassName: "bg-orange-400",
    description: l10n("local.outside_active_hours_changes_batch_into_one_u_5fc8333c"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
  archived: {
    label: l10n("local.archived_bdb86505"),
    dotClassName: "bg-muted-foreground/50",
    description: l10n("local.no_auto_updates_and_no_watches_restore_to_sta_cd8313f2"),
    dashedBorder: false,
    keepsLastSummary: true,
  },
};

/** Compact token count, e.g. `1.1k`, `950`, `12.4k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** US-dollar cost from integer cents, e.g. `$0.09`, `$1.20`. Sub-cent → `<$0.01`. */
export function formatUsdFromCents(cents: number): string {
  if (cents <= 0) return "$0.00";
  if (cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

/** A one-line, human summary of a card's refresh policy for chips and footers. */
export function describeRefreshPolicy(policy: StatusCardRefreshPolicy): string {
  switch (policy.mode) {
    case "manual":
      return "manual";
    case "interval":
      return policy.intervalMinutes
        ? `every ${policy.intervalMinutes}m if changed`
        : "on a schedule if changed";
    case "reactive": {
      const debounce = policy.debounceSeconds ?? 60;
      return `on change (${debounce}s)`;
    }
    default:
      return "manual";
  }
}
