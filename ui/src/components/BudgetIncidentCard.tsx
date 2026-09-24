import { l10n } from "../i18n";
import { useState } from "react";
import type { BudgetIncident } from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function incidentStateLabel(incident: BudgetIncident) {
  if (incident.status === "resolved") return l10n("local.resolved_5be3c2c8");
  if (incident.status === "dismissed") return l10n("local.dismissed_9d747277");
  if (incident.approvalStatus === "revision_requested") return l10n("local.escalated_b710aaaa");
  if (incident.approvalStatus === "pending") return l10n("local.pending_approval_bb33a7f4");
  return l10n("local.open_ed077f3d");
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseDollarInput(draftAmount);
  const stateLabel = incidentStateLabel(incident);

  return (
    <Card className="overflow-hidden border-red-500/20 bg-(image:--gradient-extract-4)">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-red-700/90 dark:text-red-200/80">
                {incident.scopeType} {l10n("local.hard_stop_4bef884e")}</div>
              <Badge variant={incident.status === "resolved" ? "outline" : "secondary"}>
                {stateLabel}
              </Badge>
            </div>
            <CardTitle className="mt-1 text-base text-red-950 dark:text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-900/75 dark:text-red-100/70">
              {l10n("local.spending_reached_e6294c8d")}{" "}{formatCents(incident.amountObserved)} {l10n("local.against_a_limit_of_c144f794")}{" "}{formatCents(incident.amountLimit)}.
            </CardDescription>
          </div>
          <div className="rounded-full border border-red-400/30 bg-red-500/10 p-2 text-red-600 dark:text-red-200">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-950/90 dark:text-red-50/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? l10n("local.project_execution_is_paused_new_work_in_this_11358463")
              : l10n("local.this_scope_is_paused_new_heartbeats_will_not_04b4ec4c")}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
            {l10n("local.new_budget_usd_99dd3774")}</label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed === "number") onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? l10n("local.applying_dba1ddef") : l10n("local.raise_budget_resume_ecf70616")}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-red-700 dark:text-red-200/80">
              {l10n("local.the_new_budget_must_exceed_current_observed_s_a9af346c")}</p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={onKeepPaused}>
            {l10n("local.keep_paused_686b908d")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
