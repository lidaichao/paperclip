import { l10n } from "../../i18n";
import type { StatusCardRefreshPolicy, StatusCardUpdate } from "@paperclipai/shared";

/** "1.1k tok" / "940 tok" — compact token count for footers and chips. */
export function formatTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined) return null;
  if (tokens < 1000) return l10n("local.value_tokens_compact_10300249", { v0: tokens });
  return l10n("local.value_tokens_compact_10300249", { v0: `${(tokens / 1000).toFixed(1)}k` });
}

/**
 * Dollar cost from integer cents. Uses more precision for sub-cent amounts so a
 * $0.006 incremental update does not collapse to $0.01.
 */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export interface StatusCardRollup {
  updateCount: number;
  totalTokens: number;
  totalCostCents: number;
}

// `compile` rows are cheap query (re)compiles, not summary updates. They still
// cost tokens (so they count toward token/cost totals), but they must not be
// counted as "updates" in the ledger's update count.
function accumulate(updates: StatusCardUpdate[]): StatusCardRollup {
  return updates.reduce(
    (acc, update) => ({
      updateCount: acc.updateCount + (update.kind === "compile" ? 0 : 1),
      totalTokens: acc.totalTokens + update.inputTokens + update.outputTokens,
      totalCostCents: acc.totalCostCents + update.costCents,
    }),
    { updateCount: 0, totalTokens: 0, totalCostCents: 0 },
  );
}

/**
 * Lifetime rollup across the whole update ledger — used for the archived-row
 * "lifetime" cost label.
 */
export function rollupUpdates(updates: StatusCardUpdate[]): StatusCardRollup {
  return accumulate(updates);
}

/**
 * Today-scoped rollup — only updates started since the start of the UTC
 * calendar day, matching the server-side daily token cap boundary.
 */
export function rollupUpdatesToday(updates: StatusCardUpdate[], now = new Date()): StatusCardRollup {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();
  return accumulate(updates.filter((update) => new Date(update.startedAt).getTime() >= startMs));
}

// Rough per-update estimates for the create/settings cost preview. These anchor
// on observed ledger data (a full rebuild ≈ 4.5k tokens ≈ 3¢; an incremental
// re-reads only the changed issues and runs cheaper). The preview is an
// upper-bound guide only — real cost is recorded per update in the ledger.
const EST_FULL_TOKENS = 4_500;
const EST_FULL_CENTS = 3;
const EST_INCREMENTAL_TOKENS = 2_000;
const EST_INCREMENTAL_CENTS = 1;

/** Minutes per day the card may auto-update, honouring the active-hours window. */
function activeWindowMinutes(policy: StatusCardRefreshPolicy): number {
  const hours = policy.activeHours;
  if (!hours) return 24 * 60;
  const [startH, startM] = hours.start.split(":").map(Number);
  const [endH, endM] = hours.end.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  const span = end > start ? end - start : 24 * 60 - (start - end);
  return span > 0 ? span : 24 * 60;
}

export interface StatusCardCostEstimate {
  /** Bare cost, e.g. "$0.48 · 96.0k tok" — shown to the right of the "=" sign. */
  cost: string;
  /** Headline cost line, e.g. "Up to ~48 updates/day ≈ $0.48 · 96.0k tok". */
  primary: string;
  /** Secondary qualifier (cap / no-op-check / manual-only), or null. */
  note: string | null;
}

/**
 * Derive a per-day / per-update token + cost preview from the chosen refresh
 * policy. Reacts to mode (manual / interval / reactive), interval, active
 * hours, and the daily token cap.
 */
export function estimateStatusCardCost(policy: StatusCardRefreshPolicy): StatusCardCostEstimate {
  if (policy.mode === "manual") {
    const cost = `${formatCents(EST_FULL_CENTS)} · ${formatTokens(EST_FULL_TOKENS)}`;
    return {
      cost,
      primary: l10n("local.one_rebuild_per_refresh_cost_10300250", { v0: cost }),
      note: l10n("local.manual_cards_cost_only_on_refresh_10300251"),
    };
  }

  const windowMinutes = activeWindowMinutes(policy);
  let maxPerDay: number;
  let cadence: string;
  if (policy.mode === "interval") {
    const interval = policy.intervalMinutes ?? 15;
    maxPerDay = Math.floor(windowMinutes / interval);
    cadence = l10n("local.every_value_minutes_10300252", { v0: interval });
  } else {
    const perHour = policy.maxUpdatesPerHour ?? 6;
    maxPerDay = Math.round((windowMinutes / 60) * perHour);
    cadence = l10n("local.up_to_value_per_hour_10300253", { v0: perHour });
  }

  const cap = policy.dailyTokenCap ?? null;
  const maxByCap = cap !== null ? Math.floor(cap / EST_INCREMENTAL_TOKENS) : Infinity;
  const effective = Math.max(0, Math.min(maxPerDay, maxByCap));
  const cappedByTokenCap = cap !== null && maxByCap < maxPerDay;

  const tokens = effective * EST_INCREMENTAL_TOKENS;
  const cents = effective * EST_INCREMENTAL_CENTS;
  const withinHours = policy.activeHours ? l10n("local.during_active_hours_suffix_10300254") : "";
  const cost = `${formatCents(cents)} · ${formatTokens(tokens)}`;

  return {
    cost,
    primary: l10n("local.up_to_updates_per_day_cost_10300255", {
      v0: effective,
      v1: `${cadence}${withinHours}`,
      v2: cost,
    }),
    note: cappedByTokenCap
      ? l10n("local.capped_by_daily_token_limit_10300256", { v0: formatTokens(cap!) })
      : l10n("local.only_runs_when_something_changed_10300257"),
  };
}

/** "0.4k in / 0.2k out" — the per-update token split shown in history rows. */
export function formatTokenSplit(inputTokens: number, outputTokens: number): string {
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  return l10n("local.token_input_output_split_10300258", { v0: fmt(inputTokens), v1: fmt(outputTokens) });
}

/** Human label for an update's kind. */
export function updateKindLabel(kind: StatusCardUpdate["kind"]): string {
  switch (kind) {
    case "compile":
      return l10n("local.compile_eba8dcd6");
    case "full":
      return l10n("local.full_rebuild_4cec2a63");
    case "incremental":
      return l10n("local.incremental_80a3df68");
    default:
      return kind;
  }
}
