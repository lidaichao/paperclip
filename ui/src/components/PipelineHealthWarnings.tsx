import { l10n } from "../i18n";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { PipelineHealthWarning } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * Setup-health warnings for pipelines, rendered in the same plain-language
 * prosumer voice as the rest of the pipelines UI. The copy comes straight from
 * `computePipelineHealth` — these components only handle layout.
 */

function warningCount(count: number) {
  return `${count} thing${count === 1 ? "" : "s"} to fix`;
}

/** Board-bar caps its list so a busy pipeline doesn't render a wall of warnings. */
const BOARD_WARNING_CAP = 5;

function WarningMessage({ warning }: { warning: PipelineHealthWarning }) {
  return (
    <>
      {warning.message}
      {warning.href ? (
        <>
          {" "}
          <Link to={warning.href} className="font-medium underline underline-offset-2">
            {warning.hrefLabel ?? l10n("local.open_ed077f3d")}
          </Link>
        </>
      ) : null}
    </>
  );
}

/**
 * Board-header bar: a single amber strip summarising every stage that won't run,
 * with each warning optionally clickable to jump to that stage's settings.
 */
export function PipelineHealthBar({
  warnings,
  onSelectStage,
  className,
}: {
  warnings: PipelineHealthWarning[];
  onSelectStage?: (stageId: string) => void;
  className?: string;
}) {
  if (warnings.length === 0) return null;
  const shown = warnings.slice(0, BOARD_WARNING_CAP);
  const overflow = warnings.length - shown.length;
  return (
    <div
      role="region"
      aria-labelledby="pipeline-health-bar-heading"
      className={cn(
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200",
        className,
      )}
    >
      <h2 id="pipeline-health-bar-heading" className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{l10n("local.some_steps_won_t_run_yet_d0a31925")}{" "}{warningCount(warnings.length)}</span>
      </h2>
      <ul className="mt-1.5 space-y-1 pl-6 text-sm">
        {shown.map((warning, index) => {
          const body = (
            <>
              <span className="font-medium">{warning.stageName}:</span> <WarningMessage warning={warning} />
            </>
          );
          return (
            <li key={`${warning.stageId}-${warning.code}-${index}`} className="list-disc">
              {warning.href ? (
                <span>{body}</span>
              ) : onSelectStage ? (
                <button
                  type="button"
                  aria-label={l10n("local.open_value_settings_7afd71e5", {v0: (warning.stageName)})}
                  className="group flex w-full items-start gap-1 text-left underline-offset-2 hover:underline"
                  onClick={() => onSelectStage(warning.stageId)}
                >
                  <span className="min-w-0 flex-1">{body}</span>
                  <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                </button>
              ) : (
                <span>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {overflow > 0 ? (
        <p className="mt-1.5 pl-6 text-xs text-amber-800/80 dark:text-amber-200/70">
          +{overflow} {l10n("local.more_in_stage_settings_2342eb61")}</p>
      ) : null}
    </div>
  );
}

/**
 * Compact per-stage warning list, shown inside a stage's settings panel.
 */
export function StageHealthWarnings({
  warnings,
  className,
}: {
  warnings: PipelineHealthWarning[];
  className?: string;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="region"
      aria-labelledby="stage-health-warnings-heading"
      className={cn(
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200",
        className,
      )}
    >
      <h2
        id="stage-health-warnings-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {warnings.length === 1
            ? l10n("local.this_step_won_t_run_yet_e1530f5f")
            : l10n("local.this_step_won_t_run_yet_value_things_to_fix_c8a6a029", {v0: (warnings.length)})}
        </span>
      </h2>
      <ul className="mt-1.5 space-y-1 pl-6">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`} className="list-disc">
            <WarningMessage warning={warning} />
          </li>
        ))}
      </ul>
    </div>
  );
}
