import { l10n } from "../../i18n";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { formatCents, formatTokens, rollupUpdates } from "./format";
import type { StatusCardView } from "./types";

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ArchivedStatusCardRow({
  card,
  onView,
  onRestore,
  restorePending,
}: {
  card: StatusCardView;
  onView: () => void;
  onRestore: () => void;
  restorePending?: boolean;
}) {
  // Lifetime cost is a rollup of the card's full update ledger (live P1 data).
  const updatesQuery = useQuery({
    queryKey: queryKeys.statusCards.updates(card.id),
    queryFn: () => statusCardsApi.updates(card.id),
  });
  const rollup = updatesQuery.data ? rollupUpdates(updatesQuery.data) : null;

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{card.title ?? l10n("local.untitled_card_29fc5432")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground" title={card.archivedAt ? formatDateTime(card.archivedAt) : undefined}>
          {l10n("local.archived_dd9e8812")}{" "}{shortDate(card.archivedAt)} {l10n("local._last_summary_35a21f1d")}{" "}{shortDate(card.lastGeneratedAt)}
          {rollup ? (" " + l10n("local._lifetime_value_value_d58338ad", {v0: (formatTokens(rollup.totalTokens)), v1: (formatCents(rollup.totalCostCents))})) : ""}
        </p>
      </div>
      {/* View is the more common intent on an archived row (reading the last
          summary); Restore is safe but secondary — it brings the card back
          stale and never auto-runs. */}
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={onView}>
          {l10n("local.view_dcc839a4")}</Button>
        <Button variant="outline" size="sm" onClick={onRestore} disabled={restorePending}>
          {restorePending ? <Loader2 className="animate-spin" /> : null}
          {l10n("local.restore_a76e13b9")}</Button>
      </div>
    </div>
  );
}
