import { l10n, englishPluralSuffix } from "../i18n";
import type { FinanceByKind } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { financeEventKindDisplayName, formatCents } from "@/lib/utils";

interface FinanceKindCardProps {
  rows: FinanceByKind[];
}

export function FinanceKindCard({ rows }: FinanceKindCardProps) {
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-base">{l10n("local.financial_event_mix_ca44745d")}</CardTitle>
        <CardDescription>{l10n("local.account_level_charges_grouped_by_event_kind_61cc3a6e")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{l10n("local.no_finance_events_in_this_period_66810e6a")}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.eventKind}
              className="flex items-center justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{financeEventKindDisplayName(row.eventKind)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.eventCount} {l10n("local.event_b8e1f80b")}{row.eventCount === 1 ? "" : englishPluralSuffix("s")} · {row.billerCount} {l10n("local.biller_116d3dda")}{row.billerCount === 1 ? "" : englishPluralSuffix("s")}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm font-medium">{formatCents(row.netCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatCents(row.debitCents)} {l10n("local.debits_d2277130")}</div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
