import { l10n } from "../i18n";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge, type BrandChipColor } from "@/lib/status-colors";

/**
 * The load-bearing visual grammar for the built-in bundle status panel
 * (Reflection Coach — [PAP-13099], ux-spec §4). Each variant double-encodes
 * state as glyph + word + color so it never relies on color alone
 * (WCAG 1.4.1). Colors route through the shared `brandChipBadge` families — no
 * bespoke tints are minted here (ux-spec §10).
 *
 * A single resource shows at most one readiness chip and at most one drift
 * chip; when both a readiness problem and a drift state coexist, the caller
 * suppresses the drift chip until readiness is `ready` (ux-spec §4).
 */
export type ResourceStatusVariant =
  | "ready"
  | "needs_setup"
  | "missing"
  | "error"
  | "update_available"
  | "drifted"
  | "schedule_off"
  | "schedule_on"
  | "pending_approval"
  | "proposal_pending";

interface VariantSpec {
  color: BrandChipColor;
  glyph: string;
  label: string;
  title: string;
}

const VARIANTS: Record<ResourceStatusVariant, VariantSpec> = {
  ready: { color: "green", glyph: "●", label: l10n("local.ready_5fa7aac5"), title: l10n("local.materialized_and_matches_the_shipped_default_4dd6c838") },
  needs_setup: { color: "amber", glyph: "⚠", label: l10n("local.needs_setup_b6df2441"), title: l10n("local.present_but_not_usable_yet_968a2059") },
  missing: { color: "amber", glyph: "⚠", label: l10n("local.missing_6be36ca4"), title: l10n("local.expected_resource_absent_reconcile_will_recre_f4936f59") },
  error: { color: "red", glyph: "✕", label: l10n("local.error_54a0e8c1"), title: l10n("local.failed_to_load_or_reconcile_4e42ee64") },
  update_available: {
    color: "blue",
    glyph: "↑",
    label: l10n("local.update_available_ff8b555d"),
    title: l10n("local.unedited_a_newer_shipped_default_can_be_appli_71a19f55"),
  },
  drifted: {
    color: "gray",
    glyph: "✎",
    label: l10n("local.drifted_bb85e268"),
    title: l10n("local.you_ve_edited_this_your_changes_are_kept_not_993846ba"),
  },
  schedule_off: {
    color: "gray",
    glyph: "◌",
    label: l10n("local.schedule_off_e96f8077"),
    title: l10n("local.no_background_work_runs_until_you_enable_it_c_ef9bdba7"),
  },
  schedule_on: { color: "green", glyph: "●", label: l10n("local.weekly_29751324"), title: l10n("local.runs_on_the_weekly_schedule_47fd02dd") },
  pending_approval: {
    color: "amber",
    glyph: "⚠",
    label: l10n("local.pending_approval_bb33a7f4"),
    title: l10n("local.waiting_on_board_hire_approval_before_it_can_96a74263"),
  },
  proposal_pending: {
    color: "blue",
    glyph: "↑",
    label: l10n("local.proposal_pending_f8a713a2"),
    title: l10n("local.a_proposed_update_is_waiting_for_your_review_ae9d5086"),
  },
};

export function ResourceStatusChip({
  variant,
  label,
  compact = false,
  className,
}: {
  variant: ResourceStatusVariant;
  /** Override the default label (e.g. "Weekly · Mon 09:00 UTC"). */
  label?: string;
  compact?: boolean;
  className?: string;
}) {
  const spec = VARIANTS[variant];
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge[spec.color],
        "font-medium",
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title={spec.title}
    >
      <span aria-hidden="true">{spec.glyph}</span>
      {label ?? spec.label}
    </Badge>
  );
}
