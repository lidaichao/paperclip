import { DollarSign } from "lucide-react";
import { l10n } from "../i18n";

export type BudgetSidebarMarkerLevel = "healthy" | "warning" | "critical";

const levelClasses: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: "bg-emerald-500/90 text-white",
  warning: "bg-amber-500/95 text-amber-950",
  critical: "bg-red-500/90 text-white",
};

const defaultTitles: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: l10n("local.budget_healthy_0f200001"),
  warning: l10n("local.budget_warning_0f200002"),
  critical: l10n("local.paused_by_budget_0f200003"),
};

export function BudgetSidebarMarker({
  title,
  level = "critical",
}: {
  title?: string;
  level?: BudgetSidebarMarkerLevel;
}) {
  const accessibleTitle = title ?? defaultTitles[level];

  return (
    <span
      title={accessibleTitle}
      aria-label={accessibleTitle}
      className={`ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full shadow-(--shadow-extract-3) ${levelClasses[level]}`}
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
