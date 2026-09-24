import { enumLabel } from "../i18n/display";
import { l10n } from "../i18n";
import type {
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Flag, Loader2, RotateCcw } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { formatMonitorOffset, displayMonitorRelative } from "../lib/issue-monitor";
import { useRetryNowMutation } from "../hooks/useRetryNowMutation";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { RetryErrorBand } from "./IssueScheduledRetryCard";
import {
  isAssignedBacklogBlocker,
  orderWaitingBlockers,
  type WaitingBlockerStatus,
} from "../lib/issue-blockers";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { Badge } from "@/components/ui/badge";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
} from "../lib/recovery-display";
import {
  formatRecoveryLineageSummary,
  readRecoveryRetryLineage,
} from "../lib/recovery-lineage";
import { StatusGlyph } from "./StatusGlyph";

function BlockerRecoveryIndicator({
  action,
  scheduledRetry,
}: {
  action: IssueRecoveryAction;
  /** The blocker's own scheduled retry, used to verify that the stored attempt is in flight. */
  scheduledRetry?: IssueScheduledRetry | null;
}) {
  const liveness = { scheduledRetry: scheduledRetry ?? null };
  const state = deriveActiveRecoveryDisplayState(action, liveness);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  // The blocker chip reads the same stored lineage as the source task's recovery card, so
  // a parent view never contradicts the task it is waiting on.
  const lineage = readRecoveryRetryLineage(action, liveness);
  const label = recoveryChipLabel(state, action.kind, lineage);
  const detail = lineage ? formatRecoveryLineageSummary(lineage) : null;
  return (
    <Badge variant="outline"
      data-testid="issue-blocked-notice-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      data-recovery-lane={lineage?.lane}
      role="status"
      aria-label={detail ? `${label} — ${detail}` : label}
      title={detail
        ? l10n("local.value_value_open_the_source_task_to_act_946c6e14", {v0: (label), v1: (detail)})
        : l10n("local.value_open_the_source_task_to_act_9061d91a", {v0: (label)})}
      className={`[&>svg]:size-2.5 gap-0.5 px-1.5 text-(length:--text-nano) ${tone.className}`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </Badge>
  );
}

function SuccessfulRunRetryNowControl({
  issueId,
  scheduledRetry,
}: {
  issueId: string;
  scheduledRetry: IssueScheduledRetry;
}) {
  const retryNow = useRetryNowMutation(issueId);
  const dueAtIso = scheduledRetry.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const scheduleLabel = relative === "now"
    ? l10n("local.due_now_cfc76a56")
    : relative
      ? l10n("local.scheduled_value_2877115d", {v0: displayMonitorRelative(relative)})
      : l10n("local.scheduled_6aef76c6");
  const success = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");

  return (
    <div className="mt-2 rounded-md border border-amber-300/70 bg-background/80 p-2 dark:border-amber-500/40 dark:bg-background/40">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs leading-5 text-amber-900 dark:text-amber-100">
          {l10n("local.paperclip_will_ask_the_assignee_to_choose_the_9d4ce989")}{" "}{scheduleLabel}{l10n("local._retry_now_starts_that_follow_up_immediately_06bc7747")}</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-amber-300/80 bg-background/80 text-amber-950 shadow-none hover:bg-amber-100 dark:border-amber-500/50 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
          onClick={() => retryNow.mutate()}
          disabled={retryNow.isPending || success}
          data-testid="issue-next-step-retry-now"
        >
          {retryNow.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {l10n("local.retrying_84a657bc")}</span>
          ) : success ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryNow.data?.outcome === "already_promoted" ? l10n("local.already_promoted_8a7ece83") : l10n("local.promoted_0cf04463")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {l10n("local.retry_now_5148c3e2")}</span>
          )}
        </Button>
      </div>
      <RetryErrorBand
        error={retryNow.lastError}
        className="mt-2 border-amber-300/70 bg-amber-100/70 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
        onRetry={() => {
          retryNow.reset();
          retryNow.mutate();
        }}
      />
    </div>
  );
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>();

function waitingTaskStatusLabel(status: string): string {
  return enumLabel(status);
}

function WaitingChipLink({
  blocker,
  running = false,
}: {
  blocker: IssueRelationIssueSummary;
  running?: boolean;
}) {
  const issuePathId = blocker.identifier ?? blocker.id;
  return (
    <IssueLinkQuicklook
      issuePathId={issuePathId}
      to={createIssueDetailPath(issuePathId)}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-blue-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-blue-950 transition-colors hover:border-blue-500 hover:bg-blue-100 hover:underline dark:border-blue-500/40 dark:bg-background/40 dark:text-blue-100 dark:hover:bg-blue-500/15"
    >
      <StatusGlyph
        status={blocker.status}
        size="sm"
        title={l10n("local.value_status_089f13ac", {v0: (waitingTaskStatusLabel(blocker.status))})}
      />
      <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
      <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-blue-800 dark:text-blue-200">
        {blocker.title}
      </span>
      {running ? (
        <span className="ml-0.5 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide text-blue-700 dark:bg-blue-400/20 dark:text-blue-200">
          {l10n("local.running_c071cf5f")}</span>
      ) : null}
    </IssueLinkQuicklook>
  );
}

function WaitingStepGlyph({ status }: { status: WaitingBlockerStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" aria-hidden />;
  }
  if (status === "running") {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
      </span>
    );
  }
  return <Circle className="h-3.5 w-3.5 text-blue-300 dark:text-blue-500/50" aria-hidden />;
}

/**
 * Calm in-flight counterpart to the amber "still needs a next step" alarm.
 * The handoff is still `required`, but a correction run is live on the issue,
 * so the alarm would be crying wolf while an agent is already working. Saying
 * it quietly beats saying nothing: the reader still learns a disposition is
 * outstanding, and learns that the alarm comes back if the run ends without
 * choosing one.
 */
function SuccessfulRunHandoffInFlightNotice({
  liveRunId,
  assigneeAgentId,
}: {
  liveRunId?: string | null;
  assigneeAgentId?: string | null;
}) {
  const shortRunId = liveRunId ? liveRunId.slice(0, 8) : null;
  return (
    <div
      data-testid="issue-next-step-in-flight"
      data-successful-run-handoff="in_flight"
      className="mb-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
          <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
        </span>
        <p className="min-w-0 leading-5">
          {l10n("local.a_correction_run_is_in_progress_the_agent_is_a5988eb1")}{shortRunId ? (
            <>
              {" "}
              {assigneeAgentId ? (
                <Link
                  to={`/agents/${assigneeAgentId}/runs/${liveRunId}`}
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                >
                  {l10n("local.run_acba2551")}{" "}{shortRunId}
                </Link>
              ) : (
                <span className="font-mono">{l10n("local.run_acba2551")}{" "}{shortRunId}</span>
              )}
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/**
 * Blue "Waiting on live work" variant — rendered in place of the
 * amber notice when `blockerAttention.state === "covered"`: the blocker chain
 * is a healthy plan executing in order and something in it is live.
 */
function WaitingOnLiveWorkNotice({
  blockerAttentionState,
  chainBlockers,
  terminalBlockers,
  liveIds,
  parkedBlockers,
  renderParkedChip,
}: {
  blockerAttentionState?: string;
  chainBlockers: IssueRelationIssueSummary[];
  terminalBlockers: IssueRelationIssueSummary[];
  liveIds: ReadonlySet<string>;
  parkedBlockers: IssueRelationIssueSummary[];
  renderParkedChip: (blocker: IssueRelationIssueSummary) => ReactNode;
}) {
  const steps = orderWaitingBlockers(chainBlockers, liveIds);
  const total = steps.length;
  const doneCount = steps.filter((step) => step.status === "done").length;
  const runningCount = steps.filter((step) => step.status === "running").length;

  // "Now running" replaces "Ultimately waiting on": prefer live terminal
  // leaves that are not already shown in the ordered queue list.
  const stepIds = new Set(steps.map((step) => step.blocker.id));
  const nowRunningSeen = new Set<string>();
  const nowRunning: IssueRelationIssueSummary[] = [];
  for (const blocker of [...terminalBlockers, ...chainBlockers]) {
    if (!liveIds.has(blocker.id)) continue;
    if (stepIds.has(blocker.id)) continue;
    if (nowRunningSeen.has(blocker.id)) continue;
    nowRunningSeen.add(blocker.id);
    nowRunning.push(blocker);
  }

  const queuedNoun = total === 1 ? "task" : "tasks";

  return (
    <div
      data-blocker-attention-state={blockerAttentionState}
      data-testid="issue-blocked-notice-live"
      className="mb-3 rounded-md border border-blue-300/70 bg-blue-50/90 px-3 py-2.5 text-sm text-blue-950 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-1">
            <p className="font-medium leading-5">{l10n("local.waiting_on_live_work_54a2de10")}</p>
            <p className="leading-5">
              {l10n("local.queued_behind_07eacf1b")}{" "}{total} {queuedNoun} {l10n("local.being_worked_in_order_this_task_resumes_autom_7fc7ae24")}</p>
          </div>

          <div className="space-y-1" data-testid="issue-blocked-notice-progress">
            <div className="text-xs font-medium text-blue-800 dark:text-blue-200">
              {doneCount} {l10n("local.of_28391d3b")}{" "}{total} {l10n("local.done_a4c3ed04")}{runningCount > 0 ? (" " + l10n("local._value_running_c4ce6779", {v0: (runningCount)})) : null}
            </div>
            <div
              role="progressbar"
              aria-label={l10n("local.blocker_chain_progress_e381a27e")}
              aria-valuemin={0}
              aria-valuenow={doneCount}
              aria-valuemax={total}
              className="flex h-2 w-full overflow-hidden rounded-full bg-blue-100 dark:bg-blue-500/20"
            >
              {steps.map(({ blocker, status }) => (
                <span
                  key={blocker.id}
                  className={cn(
                    "h-full border-r border-blue-50/80 last:border-r-0 dark:border-blue-950/40",
                    status === "done"
                      ? "bg-blue-500 dark:bg-blue-400"
                      : status === "running"
                        ? "animate-pulse bg-blue-400"
                        : "bg-blue-200 dark:bg-blue-500/30",
                  )}
                  style={{ width: `${100 / total}%` }}
                  title={`${blocker.identifier ?? blocker.id.slice(0, 8)}: ${status}`}
                  aria-hidden
                />
              ))}
            </div>
          </div>

          <div data-testid="issue-blocked-notice-steps">
            {steps.map(({ blocker, status }) => (
              <div key={blocker.id} className="flex items-stretch gap-2">
                <div className="flex w-3.5 flex-col items-center">
                  <span className="flex min-h-6 items-center">
                    <WaitingStepGlyph status={status} />
                  </span>
                  <span
                    className="w-px flex-1 bg-blue-300/50 dark:bg-blue-500/30"
                    aria-hidden
                  />
                </div>
                <div className="min-w-0 pb-1.5">
                  <WaitingChipLink blocker={blocker} running={status === "running"} />
                </div>
              </div>
            ))}
            <div className="flex items-stretch gap-2">
              <div className="flex w-3.5 flex-col items-center">
                <span
                  className="mt-1.5 h-3 w-3 rounded-full border border-dashed border-blue-400/60 dark:border-blue-400/50"
                  aria-hidden
                />
              </div>
              <div className="min-w-0 pb-0.5">
                <span className="inline-block rounded-md border border-dashed border-blue-300/70 px-2 py-1 text-xs text-blue-800 dark:border-blue-500/40 dark:text-blue-200">
                  {l10n("local.this_task_resumes_automatically_when_the_chai_30e6fd94")}</span>
              </div>
            </div>
          </div>

          {nowRunning.length > 0 ? (
            <div
              data-testid="issue-blocked-notice-now-running"
              className="space-y-1 pt-0.5"
            >
              <div className="text-xs font-medium text-blue-800 dark:text-blue-200">
                {l10n("local.now_running_44cdf357")}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {nowRunning.map((blocker) => (
                  <WaitingChipLink key={blocker.id} blocker={blocker} running />
                ))}
              </div>
            </div>
          ) : null}

          {parkedBlockers.length > 0 ? (
            <div
              data-testid="issue-blocked-notice-parked-row"
              className="flex flex-wrap items-center gap-1.5 pt-0.5"
            >
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                <Flag className="h-3 w-3" aria-hidden />
                {l10n("local.blocked_by_parked_work_8b239473")}</span>
              {parkedBlockers.map((blocker) => renderParkedChip(blocker))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function IssueBlockedNotice({
  issueId,
  issueStatus,
  blockers,
  allBlockers,
  liveIssueIds,
  blockerAttention,
  successfulRunHandoff,
  scheduledRetry,
  agentName,
}: {
  issueId?: string | null;
  issueStatus?: string;
  /** Unresolved blockers (drives the amber notice; unchanged). */
  blockers: IssueRelationIssueSummary[];
  /**
   * Full blocker list (resolved + unresolved). Used by the blue "Waiting on
   * live work" variant to render done steps and progress counts. Falls back to
   * {@link blockers} when not supplied.
   */
  allBlockers?: IssueRelationIssueSummary[];
  /** Company-wide set of issue ids with a queued/running run (own or blocker). */
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  agentName?: string | null;
}) {
  if (issueStatus === "done" || issueStatus === "cancelled") return null;
  // A live run on this issue means an agent is already handling it — the
  // missing-disposition complaint only applies when the issue is stuck.
  // `hasLiveContinuation` is the server's view; `liveIssueIds` catches runs
  // that started after the issue payload was fetched.
  const issueHasLiveRun = Boolean(issueId && liveIssueIds?.has(issueId));
  const showSuccessfulRunHandoff =
    successfulRunHandoff != null
    && isSuccessfulRunHandoffRequired({ successfulRunHandoff, scheduledRetry })
    && !issueHasLiveRun;
  // Outstanding handoff + a live run on the issue: the alarm is suppressed, so
  // render the quiet in-flight line in its place rather than nothing at all.
  // The unpromoted-scheduled-retry carve-out keeps `showSuccessfulRunHandoff`
  // true, so the amber notice (and its "Retry now" control) still wins there.
  // This stands in for the handoff alarm only. When the issue also has
  // blockers, the blocker notice below is the stronger signal and owns the
  // slot, exactly as it did before this line existed.
  const handoffInFlightNotice =
    successfulRunHandoff != null
    && successfulRunHandoff.required === true
    && !showSuccessfulRunHandoff
    && (successfulRunHandoff.hasLiveContinuation || issueHasLiveRun)
      ? (
        <SuccessfulRunHandoffInFlightNotice
          liveRunId={successfulRunHandoff.liveRunId}
          assigneeAgentId={successfulRunHandoff.assigneeAgentId}
        />
      )
      : null;
  if (!showSuccessfulRunHandoff && blockers.length === 0 && issueStatus !== "blocked") {
    return handoffInFlightNotice;
  }
  const successfulRunRetryNow = showSuccessfulRunHandoff
    && issueId
    && scheduledRetry?.status === "scheduled_retry"
      ? { issueId, scheduledRetry }
      : null;

  const blockerLabel = blockers.length === 1 ? l10n("local.the_linked_task_bd75976e") : l10n("local.the_linked_tasks_a90141d6");
  const terminalBlockers = blockers
    .flatMap((blocker) => blocker.terminalBlockers ?? [])
    .filter((blocker, index, all) => all.findIndex((candidate) => candidate.id === blocker.id) === index);

  const isStalled = blockerAttention?.state === "stalled";
  const parkedBlockers = (() => {
    const seen = new Set<string>();
    const collected: IssueRelationIssueSummary[] = [];
    const sources: IssueRelationIssueSummary[] = [...blockers];
    for (const blocker of blockers) {
      for (const terminal of blocker.terminalBlockers ?? []) {
        sources.push(terminal);
      }
    }
    for (const blocker of sources) {
      if (!isAssignedBacklogBlocker(blocker)) continue;
      if (seen.has(blocker.id)) continue;
      seen.add(blocker.id);
      collected.push(blocker);
    }
    return collected;
  })();
  const showParkedRow = parkedBlockers.length > 0;
  const stalledLeafIdentifier =
    blockerAttention?.sampleStalledBlockerIdentifier ?? blockerAttention?.sampleBlockerIdentifier ?? null;
  const stalledLeafBlockers = (() => {
    const candidates: IssueRelationIssueSummary[] = [];
    for (const blocker of [...blockers, ...terminalBlockers]) {
      if (blocker.status !== "in_review") continue;
      if (candidates.some((existing) => existing.id === blocker.id)) continue;
      candidates.push(blocker);
    }
    if (stalledLeafIdentifier) {
      const preferred = candidates.find(
        (blocker) => (blocker.identifier ?? blocker.id) === stalledLeafIdentifier,
      );
      if (preferred) {
        return [preferred, ...candidates.filter((blocker) => blocker.id !== preferred.id)];
      }
    }
    return candidates;
  })();
  const showStalledRow = isStalled && stalledLeafBlockers.length > 0;

  // Rule C (PAP-13554 / plan §Rule C): when the issue is `blocked` and a
  // blocker edge is genuinely not done, a human comment does NOT reopen it —
  // the reopen gate keeps it blocked. `blockers` here is the *unresolved* set
  // (status ≠ done/cancelled), so a non-empty list on a `blocked` issue is
  // exactly the case the human's message can't move to todo. Done-but-pending-
  // finalize blockers are `done`, so they fall out of this set and into the
  // Rule B reopen path — we must not claim "a message won't reopen" for those.
  // Name the deepest unresolved leaf (prefer terminal leaves) with its status
  // so "I sent a message and nothing happened" can't recur silently.
  const responsibleName = agentName ?? "the assignee";
  const reopenSuppressed = issueStatus === "blocked" && !isStalled && blockers.length > 0;
  const unresolvedLeafBlockers = (() => {
    if (!reopenSuppressed) return [] as IssueRelationIssueSummary[];
    const seen = new Set<string>();
    const collected: IssueRelationIssueSummary[] = [];
    for (const blocker of blockers) {
      const terminals = (blocker.terminalBlockers ?? []).filter(
        (leaf) => leaf.status !== "done" && leaf.status !== "cancelled",
      );
      const leaves = terminals.length > 0 ? terminals : [blocker];
      for (const leaf of leaves) {
        if (seen.has(leaf.id)) continue;
        seen.add(leaf.id);
        collected.push(leaf);
      }
    }
    return collected;
  })();
  const reopenSuppressedLeaf = unresolvedLeafBlockers[0] ?? null;
  const reopenSuppressedLeafId = reopenSuppressedLeaf
    ? reopenSuppressedLeaf.identifier ?? reopenSuppressedLeaf.id.slice(0, 8)
    : null;
  const reopenSuppressedLeafStatus = reopenSuppressedLeaf
    ? reopenSuppressedLeaf.status.replace(/_/g, " ")
    : null;
  const reopenSuppressedOtherCount = Math.max(unresolvedLeafBlockers.length - 1, 0);

  const renderBlockerChip = (blocker: IssueRelationIssueSummary) => {
    const issuePathId = blocker.identifier ?? blocker.id;
    const recoveryAction = blocker.activeRecoveryAction ?? null;
    return (
      <IssueLinkQuicklook
        key={blocker.id}
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-amber-950 transition-colors hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
      >
        <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
        <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-amber-800 dark:text-amber-200">
          {blocker.title}
        </span>
        {recoveryAction ? (
          <BlockerRecoveryIndicator
            action={recoveryAction}
            scheduledRetry={blocker.scheduledRetry}
          />
        ) : null}
      </IssueLinkQuicklook>
    );
  };

  // Blue "Waiting on live work" variant: the blocker chain is a healthy plan
  // executing in order and something in it is live. `covered` is
  // the only state that goes blue — stalled / needs_attention / none keep the
  // amber notice byte-for-byte. The successful-run handoff notice is about this
  // task's own finished run, so it always keeps its amber priority styling.
  const liveIds = liveIssueIds ?? EMPTY_LIVE_IDS;
  const chainBlockers = allBlockers ?? blockers;
  const hasLiveWaitingBlocker = [...chainBlockers, ...terminalBlockers].some((blocker) => (
    liveIds.has(blocker.id)
  ));
  const waitingOnLiveWork =
    !showSuccessfulRunHandoff
    && blockerAttention?.state === "covered"
    && chainBlockers.length > 0
    && hasLiveWaitingBlocker;

  if (waitingOnLiveWork) {
    return (
      <WaitingOnLiveWorkNotice
        blockerAttentionState={blockerAttention?.state}
        chainBlockers={chainBlockers}
        terminalBlockers={terminalBlockers}
        liveIds={liveIds}
        parkedBlockers={showParkedRow ? parkedBlockers : []}
        renderParkedChip={renderBlockerChip}
      />
    );
  }

  return (
    <div
      data-blocker-attention-state={blockerAttention?.state}
      data-successful-run-handoff={showSuccessfulRunHandoff ? "required" : undefined}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 space-y-1.5">
          {showSuccessfulRunHandoff ? (
            <>
              <p className="font-medium leading-5">{l10n("local.this_task_still_needs_a_next_step_1ada26e3")}</p>
              <p className="leading-5">
                {l10n("local.a_run_finished_successfully_but_the_task_is_s_51ed8189")}</p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900 dark:text-amber-100">
                <li>{l10n("local.mark_it_done_or_cancelled_5cbd6466")}</li>
                <li>{l10n("local.send_it_for_review_or_ask_for_input_fa883fca")}</li>
                <li>{l10n("local.record_what_is_blocking_it_and_who_owns_that_6b236d4d")}</li>
                <li>{l10n("local.delegate_follow_up_work_or_queue_a_continuati_19ff3fa4")}</li>
              </ul>
              <div className="flex flex-wrap gap-1.5 text-xs">
                {successfulRunHandoff.sourceRunId && successfulRunHandoff.assigneeAgentId ? (
                  <Link
                    to={`/agents/${successfulRunHandoff.assigneeAgentId}/runs/${successfulRunHandoff.sourceRunId}`}
                    className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
                  >
                    {l10n("local.run_acba2551")}{" "}{successfulRunHandoff.sourceRunId.slice(0, 8)}
                  </Link>
                ) : successfulRunHandoff.sourceRunId ? (
                  <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                    {l10n("local.run_acba2551")}{" "}{successfulRunHandoff.sourceRunId.slice(0, 8)}
                  </span>
                ) : null}
                <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 text-amber-900 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                  {l10n("local.asked_821c038b")}{" "}{agentName ?? l10n("local.the_assignee_f584ae3a")} {l10n("local.to_choose_the_next_step_ebd73cac")}</span>
              </div>
              {successfulRunHandoff.detectedProgressSummary ? (
                <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                  {l10n("local.detected_progress_28a0185a")}{" "}{successfulRunHandoff.detectedProgressSummary}
                </p>
              ) : null}
              {successfulRunRetryNow ? (
                <SuccessfulRunRetryNowControl
                  issueId={successfulRunRetryNow.issueId}
                  scheduledRetry={successfulRunRetryNow.scheduledRetry}
                />
              ) : null}
            </>
          ) : null}
          {showSuccessfulRunHandoff && (blockers.length > 0 || issueStatus === "blocked") ? (
            <div className="border-t border-amber-300/60 pt-1.5 dark:border-amber-500/30" />
          ) : null}
          {blockers.length > 0 || issueStatus === "blocked" ? (
            <>
              <p className="leading-5">
                {blockers.length > 0
                  ? isStalled
                    ? stalledLeafBlockers.length > 1
                      ? <>{l10n("local.work_on_this_task_is_blocked_by_14b7a503")}{" "}{blockerLabel}{l10n("local._but_the_chain_is_stalled_in_review_without_a_0e9574da")}</>
                      : <>{l10n("local.work_on_this_task_is_blocked_by_14b7a503")}{" "}{blockerLabel}{l10n("local._but_the_chain_is_stalled_in_review_without_a_9a237d94")}</>
                    : reopenSuppressed
                      ? <>{l10n("local.a_message_won_rsquo_t_restart_this_task_yet_i_a4e13c3c")}{" "}{blockerLabel} {l10n("local.until_2e3200de")}{" "}{blockers.length === 1 ? l10n("local.it_is_1aa0be92") : l10n("local.they_are_4f616d6e")} {l10n("local.done_then_it_reopens_automatically_comments_s_acd5a0c7")}{" "}{responsibleName} {l10n("local.for_questions_or_triage_in_the_meantime_0890504a")}</>
                      : <>{l10n("local.work_on_this_task_is_blocked_by_14b7a503")}{" "}{blockerLabel} {l10n("local.until_2e3200de")}{" "}{blockers.length === 1 ? l10n("local.it_is_1aa0be92") : l10n("local.they_are_4f616d6e")} {l10n("local.complete_comments_still_notify_the_assignee_f_518a9957")}</>
                  : <>{l10n("local.work_on_this_task_is_blocked_until_someone_mo_6d2d0cb4")}</>}
              </p>
              {reopenSuppressed && reopenSuppressedLeafId ? (
                <p
                  data-testid="issue-blocked-notice-reopen-suppressed"
                  className="text-xs font-medium leading-5 text-amber-900 dark:text-amber-100"
                >
                  {l10n("local.still_blocked_by_4f3b07f8")}{" "}
                  <span className="font-mono">{reopenSuppressedLeafId}</span>
                  {reopenSuppressedLeafStatus ? <> ({reopenSuppressedLeafStatus})</> : null}
                  {reopenSuppressedOtherCount > 0
                    ? (" " + l10n("local.and_value_other_value_eb157cf9", {v0: (reopenSuppressedOtherCount), v1: (reopenSuppressedOtherCount === 1 ? "task" : "tasks")}))
                    : null}
                  .
                </p>
              ) : null}
              {blockers.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {blockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showStalledRow ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    {l10n("local.stalled_in_review_0fc03143")}</span>
                  {stalledLeafBlockers.map(renderBlockerChip)}
                </div>
              ) : terminalBlockers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    {l10n("local.ultimately_waiting_on_ae937d06")}</span>
                  {terminalBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showParkedRow ? (
                <div
                  data-testid="issue-blocked-notice-parked-row"
                  className="flex flex-wrap items-center gap-1.5 pt-0.5"
                >
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                    <Flag className="h-3 w-3" aria-hidden />
                    {l10n("local.blocked_by_parked_work_8b239473")}</span>
                  {parkedBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
