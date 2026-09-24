import { l10n } from "../i18n";
import { Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";
import {
  type SourceResolvedWatchdogFold,
  formatCleanupOutcome,
  formatSilenceAgeMs,
  shortenEvidenceId,
} from "@/lib/source-resolved-watchdog-fold";

export interface SourceResolvedFoldCalloutProps {
  fold: SourceResolvedWatchdogFold;
  /** Time the run was finalized — used for the "system audit · {when}" header chip. */
  finalizedAt?: string | Date | null;
  className?: string;
}

function isoOrLocaleString(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function issueLink(id: string, identifier: string | null) {
  return `/issues/${identifier ?? id}`;
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-(--gtc-10) gap-x-3 gap-y-0 py-1 text-xs sm:grid-cols-(--gtc-11)">
      <dt className="truncate text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-emerald-900/70 dark:text-emerald-200/70">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-emerald-950 dark:text-emerald-100">{children}</dd>
    </div>
  );
}

export function SourceResolvedFoldCallout({
  fold,
  finalizedAt,
  className,
}: SourceResolvedFoldCalloutProps) {
  const sourceLabel = fold.sourceIssueIdentifier ?? fold.sourceIssueId.slice(0, 8);
  const evidenceShort = shortenEvidenceId(fold.sameRunEvidenceId);
  const evidenceAt = isoOrLocaleString(fold.sameRunEvidenceAt);
  const silenceAgeLabel = formatSilenceAgeMs(fold.silenceAgeMs);
  const silenceStartedLabel = isoOrLocaleString(fold.silenceStartedAt);
  const cleanupLabel = formatCleanupOutcome(fold.cleanup.outcome);
  const finalizedRelative = finalizedAt ? relativeTime(finalizedAt) : null;
  const evaluationLabel = fold.evaluationIssueIdentifier ?? fold.evaluationIssueId?.slice(0, 8);

  return (
    <section
      role="status"
      aria-label={l10n("local.source_resolved_watchdog_fold_b1780fd4")}
      data-source-resolved-fold
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-(--shadow-extract-8)",
        "border-emerald-300/70 bg-emerald-50/80 text-emerald-950",
        "dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
          )}
          aria-hidden
        >
          <Sparkles className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)">
            <span className="text-emerald-900 dark:text-emerald-200">{l10n("local.source_resolved_fold_b2eafb16")}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <span className="font-medium normal-case tracking-normal text-muted-foreground">
              {l10n("local.system_audit_05752318")}</span>
            {finalizedRelative ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {finalizedRelative}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-6">
            {l10n("local.this_run_was_folded_as_a_source_resolved_fals_25e03a96")}</p>
        </div>
      </header>
      <dl
        className={cn(
          "divide-y border-t bg-background/40 px-3 py-2 sm:px-4 dark:bg-background/20",
          "border-emerald-300/60 dark:border-emerald-500/30",
          "[&>*]:border-emerald-300/40 dark:[&>*]:border-emerald-500/20",
        )}
      >
        <MetaRow label={l10n("local.source_task_d0e467ea")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Link
              to={issueLink(fold.sourceIssueId, fold.sourceIssueIdentifier)}
              className="rounded-sm font-medium underline-offset-2 hover:underline"
            >
              {sourceLabel}
            </Link>
            <span className="rounded-md border border-emerald-300/60 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-emerald-900 dark:border-emerald-500/30 dark:text-emerald-200">
              {fold.sourceIssueStatus}
            </span>
          </span>
        </MetaRow>
        <MetaRow label={l10n("local.same_run_evidence_434922c9")}>
          <span className="inline-flex flex-wrap items-baseline gap-1.5">
            <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-emerald-900 dark:bg-background/40 dark:text-emerald-100">
              {fold.sameRunEvidenceKind}
            </span>
            <code
              className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-emerald-900 dark:bg-background/40 dark:text-emerald-100"
              title={fold.sameRunEvidenceId}
            >
              {evidenceShort}
            </code>
            {evidenceAt ? (
              <span className="text-(length:--text-micro) text-muted-foreground">{l10n("local.at_b1d6b91b")}{" "}{evidenceAt}</span>
            ) : null}
          </span>
        </MetaRow>
        <MetaRow label={l10n("local.silence_age_before_fold_f1af4dc6")}>
          {silenceAgeLabel ? (
            <span>
              {silenceAgeLabel}
              {silenceStartedLabel ? (
                <span className="text-muted-foreground"> {l10n("local._silence_started_bc7eb007")}{" "}{silenceStartedLabel})</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">{l10n("local.unknown_b23a6a84")}</span>
          )}
        </MetaRow>
        <MetaRow label={l10n("local.process_cleanup_2e6ef181")}>
          <span
            className="inline-flex flex-wrap items-baseline gap-1.5"
            title={fold.cleanup.outcome}
          >
            <span>{cleanupLabel}</span>
            {fold.cleanup.error ? (
              <span className="text-muted-foreground">— {fold.cleanup.error}</span>
            ) : null}
          </span>
        </MetaRow>
        {fold.evaluationIssueId ? (
          <MetaRow label={l10n("local.evaluation_task_b2d2b7e6")}>
            <Link
              to={issueLink(fold.evaluationIssueId, fold.evaluationIssueIdentifier)}
              className="rounded-sm font-medium underline-offset-2 hover:underline"
            >
              {evaluationLabel}
            </Link>
          </MetaRow>
        ) : null}
      </dl>
    </section>
  );
}

export default SourceResolvedFoldCallout;
