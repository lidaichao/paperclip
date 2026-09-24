import { l10n } from "../../i18n";
import { FilterX, RotateCcw } from "lucide-react";
import type { CompanySearchZeroResults } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  clearFilterDimension,
  countActiveFilters,
  describeLoosenSuggestion,
  type FilterChipLookups,
  type SearchFilters,
} from "@/lib/search-filters";

export function ZeroResultsRecovery({
  query,
  filters,
  zeroResults,
  lookups,
  onChange,
  onClearAll,
}: {
  query: string;
  filters: SearchFilters;
  zeroResults: CompanySearchZeroResults;
  lookups: FilterChipLookups;
  onChange: (next: SearchFilters) => void;
  onClearAll: () => void;
}) {
  const activeCount = countActiveFilters(filters);
  const { unfilteredTotal } = zeroResults;
  // Rank suggestions by how many results each one recovers (highest impact first).
  const suggestions = [...zeroResults.loosenSuggestions].sort(
    (a, b) => b.additionalCount - a.additionalCount,
  );

  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-4 py-12 text-center"
      data-testid="search-zero-results-recovery"
    >
      <FilterX className="h-10 w-10 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <div className="text-base font-semibold">{l10n("local.no_results_with_these_filters_9005fe70")}</div>
        <p className="text-sm text-muted-foreground">
          {unfilteredTotal === 1 ? l10n("local.1_result_matches_0dcfdcd9") : l10n("local.value_results_match_b53aa451", {v0: (unfilteredTotal)})}
          {query ? <> &ldquo;{query}&rdquo;</> : null}{l10n("local._but_your_991bdab8")}{" "}
          {activeCount === 1 ? l10n("local.active_filter_hides_5dc2d18f") : l10n("local.value_active_filters_hide_d44dc5ba", {v0: (activeCount)})} {l10n("local.all_of_them_61fe2660")}</p>
      </div>

      {suggestions.length > 0 ? (
        <div className="flex w-full flex-col gap-1.5">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
            {l10n("local.loosen_a_filter_bbc8b39a")}</div>
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.filter}:${suggestion.values.join(",")}`}
              type="button"
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-foreground/30 hover:bg-accent/40"
              onClick={() => onChange(clearFilterDimension(filters, suggestion.filter))}
            >
              <span className="min-w-0 truncate">
                {l10n("local.remove_c3812fc4")}{" "}
                <span className="font-medium">
                  {describeLoosenSuggestion(suggestion.filter, suggestion.values, lookups)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">
                +{suggestion.additionalCount} {suggestion.additionalCount === 1 ? l10n("local.result_f6a214f7") : l10n("local.results_c099142b")}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <Button onClick={onClearAll} variant="default" size="sm">
        <RotateCcw className="mr-1.5 h-4 w-4" />
        {l10n("local.clear_all_filters_de22447d")}</Button>
    </div>
  );
}
