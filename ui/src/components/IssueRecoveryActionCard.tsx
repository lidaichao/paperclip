import { l10n } from "../i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { requiresExecutionReconciliation } from "@paperclipai/shared";
import { useMemo, useState } from "react";
import type {
  Agent,
  GitWorktreeBranchAncestryVerdict,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import {
  Eye,
  GitBranch,
  GitBranchPlus,
  Loader2,
  Lock,
  OctagonAlert,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { agentUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  deriveRecoveryDisplayState,
  type RecoveryDisplayState,
} from "@/lib/recovery-display";
import {
  formatRecoveryAttemptLabel,
  formatRecoveryRetryOffset,
  readRecoveryRetryLineage,
  type RecoveryRetryLineage,
} from "@/lib/recovery-lineage";

export type RecoveryCardCardState = RecoveryDisplayState;
export const deriveRecoveryCardState = deriveRecoveryDisplayState;

export type RecoveryResolveOutcome =
  | "todo"
  | "done"
  | "in_review"
  | "false_positive_done"
  | "false_positive_in_review";

/**
 * Payload for the "Re-issue on isolated workspace" action (workspace_validation only).
 * The caller composes an isolated-workspace re-issue whose git worktree bases off `baseRef`
 * — the live (checked-out) branch that diverged, or its HEAD sha when the branch is detached.
 */
export interface RecoveryReissueRequest {
  baseRef: string;
  liveBranch: string | null;
  liveHeadSha: string | null;
  expectedBranch: string | null;
}

export interface IssueRecoveryActionCardProps {
  action: IssueRecoveryAction;
  agentMap?: ReadonlyMap<string, Agent>;
  /**
   * The source issue's scheduled retry. It is the only signal that can confirm the run the
   * wake policy parked is genuinely in flight, which is what separates a retry the scheduler
   * is running from one whose due time quietly passed.
   */
  scheduledRetry?: IssueScheduledRetry | null;
  /** Preferred state hint (e.g. observe_only when watchdog tone is requested). Falls back to derived state. */
  forcedState?: RecoveryCardCardState;
  /** Optional click handler for resolve menu actions. If omitted, the buttons are not rendered. */
  onResolve?: (outcome: RecoveryResolveOutcome) => void;
  /**
   * Optional handler for the workspace_validation "Re-issue on isolated workspace" action.
   * Rendered only for a git-worktree branch-incoherence divergence with a resolvable live ref.
   * If omitted, the re-issue button is not shown.
   */
  onReissueIsolated?: (request: RecoveryReissueRequest) => void;
  /** Whether an isolated re-issue is currently in flight (disables the action + shows a spinner). */
  reissuePending?: boolean;
  /**
   * Handler for action 1 — "Reconcile forward & continue" (workspace_validation only). Rendered
   * only for an ancestry-proven (`ancestor`) git-worktree divergence; the caller invokes the S4
   * reconcile op in `forward` mode, which re-verifies ancestry server-side (the client hint is
   * never trusted). If omitted, the button is not shown.
   */
  onReconcileForward?: () => void;
  /**
   * Handler for action 2 — the audited break-glass override (workspace_validation only). Receives
   * the operator's required, non-empty reason and invokes the S4 reconcile op in `override` mode.
   * Rendered only when `canBreakGlass` is true AND this handler is provided; the server independently
   * rejects agent actors and re-checks runtime-manage permission, so UI hiding is defense-in-depth.
   */
  onBreakGlassOverride?: (reason: string) => void;
  /**
   * Whether the viewer may run the permission-gated break-glass override. When false, action 2 is
   * not rendered at all — a non-permitted user never sees the "reconcile anyway" affordance.
   */
  canBreakGlass?: boolean;
  /**
   * Handler for the lossless repair — "Repair workspace — quarantine changes & restore branch"
   * (workspace_validation only). Rendered only for a *dirty* divergence; the caller invokes the S4
   * reconcile op in `quarantine_restore` mode, which quarantines the dirty worktree onto a rescue
   * branch and restores the recorded branch. If omitted, the repair action is not shown.
   */
  onQuarantineRestore?: () => void;
  /** Whether a quarantine-restore repair is currently in flight (shares the reconcile spinner). */
  quarantineRestorePending?: boolean;
  /** Whether a reconcile (forward, override, or quarantine-restore) is currently in flight. */
  reconcilePending?: boolean;
  /** Whether the viewer can run destructive board-only actions (e.g. false-positive dismissal). */
  canFalsePositive?: boolean;
  /**
   * Rendering density. `full` (default) shows the complete metadata table; `compact` drops the
   * metadata rows for embedding beside a run on the agent run page, keeping the header, divergence
   * diagnosis, and action footer.
   */
  variant?: "full" | "compact";
  className?: string;
}

const KIND_LABEL: Record<IssueRecoveryActionKind, string> = {
  missing_disposition: "Missing Disposition",
  deliberate_wait_without_target: "Wait Without A Target",
  stranded_assigned_issue: "Stranded Task",
  workspace_validation: "Workspace Validation",
  configuration_validation: "Configuration Validation",
  active_run_watchdog: "Active Watchdog",
  issue_graph_liveness: "Task Needs Next Step",
};

const KIND_HEADLINE: Record<IssueRecoveryActionKind, string> = {
  missing_disposition:
    "This task's run finished, but no next step was chosen. Choose what happens next — try the task again, mark it done, or send it for review.",
  deliberate_wait_without_target:
    "This task's last run stopped to wait, but there is no reviewer, blocker, monitor, or approval to wait for. Paperclip is repairing the next step; the task stays with its owner.",
  stranded_assigned_issue:
    "Paperclip retried this task's last run, but there is still no queued run, reviewer, blocker, or other next owner. To get it moving, choose what happens next — try the task again, mark it done, or send it for review.",
  workspace_validation:
    "Paperclip stopped this run because the task's git workspace could not be validated.",
  configuration_validation:
    "Paperclip stopped before dispatching this run because required secret/env bindings are missing.",
  active_run_watchdog:
    "The active run has been silent. Recovery is observing without interrupting it.",
  issue_graph_liveness:
    "Paperclip could not find a clear next step for this open task. Choose whether to continue work, send it for review, mark it done, or record what is blocking it.",
};

/** Shared shell for the retry-timing pill so every timing state reads as the same control. */
const RETRY_PILL_CLASS =
  "rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground";

const STATE_TONE: Record<RecoveryCardCardState, {
  label: string;
  containerClass: string;
  iconWrapClass: string;
  iconClass: string;
  labelClass: string;
  Icon: typeof TriangleAlert;
  divider: string;
}> = {
  needed: {
    label: l10n("local.recovery_needed_85e5d2f1"),
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    label: l10n("local.recovery_in_progress_477f0e94"),
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    label: l10n("local.observing_active_run_a43568b4"),
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    label: l10n("local.recovery_escalated_f577dda4"),
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    label: l10n("local.recovery_resolved_ed726d68"),
    containerClass:
      "border-emerald-300/70 bg-emerald-50/80 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    iconWrapClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    iconClass: "text-emerald-700 dark:text-emerald-300",
    labelClass: "text-emerald-900 dark:text-emerald-200",
    Icon: Sparkles,
    divider: "border-emerald-300/60 dark:border-emerald-500/30",
  },
};

const OUTCOME_LABEL: Record<IssueRecoveryActionOutcome, string> = {
  restored: "restored",
  handed_back: "handed back to original owner",
  owner_completed: "completed by recovery owner",
  delegated: "delegated to follow-up",
  false_positive: "false positive",
  blocked: "blocked",
  escalated: "escalated",
  cancelled: "cancelled",
};

function readEvidenceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

// Human-sentence evidence sources render as prose; code-shaped sources
// (error codes, statuses) stay in the mono treatment used for run ids.
const PROSE_EVIDENCE_KEYS = ["summary", "detectedProgressSummary", "missingDisposition", "retryReason"] as const;
const CODE_EVIDENCE_KEYS = ["latestRunErrorCode", "latestRunStatus", "latestIssueStatus"] as const;

function pickEvidenceSummary(action: IssueRecoveryAction): { text: string; isCode: boolean } | null {
  const evidence = action.evidence ?? {};
  for (const key of PROSE_EVIDENCE_KEYS) {
    const next = readEvidenceString(evidence[key]);
    if (next) return { text: next, isCode: false };
  }
  for (const key of CODE_EVIDENCE_KEYS) {
    const next = readEvidenceString(evidence[key]);
    if (next) return { text: next, isCode: true };
  }
  return null;
}

function readEvidenceRunId(action: IssueRecoveryAction, key: "sourceRunId" | "correctiveRunId" | "latestRunId") {
  const evidence = action.evidence ?? {};
  const next = readEvidenceString(evidence[key]);
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asAncestryVerdict(value: unknown): GitWorktreeBranchAncestryVerdict | null {
  return value === "ancestor" || value === "diverged" || value === "unknown" ? value : null;
}

function formatShortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/**
 * Diagnosis derived from a workspace_validation recovery action whose underlying failure is a
 * git-worktree branch incoherence. The evidence carries the recorded ("expected") branch, the
 * live ("actual"/checked-out) branch, both HEAD shas, and a server-computed ancestry verdict +
 * plain-language explanation of why the run was declined.
 */
interface WorkspaceContention {
  claimedByIssueId: string | null;
  claimedByIssueIdentifier: string | null;
  /** True when the claiming workspace has a queued/running run (not just a stale claim). */
  hasActiveRun: boolean;
}

interface WorkspaceDivergence {
  expectedBranch: string | null;
  liveBranch: string | null;
  expectedHeadSha: string | null;
  liveHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict | null;
  plainLanguageReason: string | null;
  cleanliness: "clean" | "dirty" | "unknown" | null;
  /** Number of dirty (uncommitted) status entries in the live worktree, when known. */
  dirtyFileCount: number | null;
  /** Sample of dirty paths (already truncated server-side) for the confirm step. */
  dirtyPathSample: string[];
  /**
   * Another workspace is holding the live branch. When present, the lossless quarantine repair is
   * refused server-side — re-issuing on an isolated workspace is the recommended path instead.
   */
  contention: WorkspaceContention | null;
  /**
   * Preview of the rescue branch the quarantine repair will create. The server appends a UTC
   * timestamp at repair time, so this is the stable prefix only (rendered with a trailing marker).
   */
  rescueBranchPreview: string;
  /** Ref a re-issue should base off — the live branch when known, else the live HEAD sha. */
  reissueBaseRef: string | null;
}

/** Mirrors the server's `sanitizeBranchName` for a faithful rescue-branch preview. */
function sanitizeBranchComponent(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .slice(0, 120) || "issue"
  );
}

function buildRescueBranchPreview(sourceIdentifier: string | null): string {
  return `paperclip/rescue/${sanitizeBranchComponent(sourceIdentifier ?? "issue")}/`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function readContention(value: unknown): WorkspaceContention | null {
  const record = asRecord(value);
  if (!record) return null;
  const activeRun = asRecord(record.activeRun);
  return {
    claimedByIssueId: asNonEmptyString(record.claimedByIssueId),
    claimedByIssueIdentifier: asNonEmptyString(record.claimedByIssueIdentifier),
    hasActiveRun: activeRun !== null,
  };
}

function readWorkspaceDivergence(action: IssueRecoveryAction): WorkspaceDivergence | null {
  if (action.kind !== "workspace_validation") return null;
  const workspaceValidation = asRecord(action.evidence?.workspaceValidation);
  if (!workspaceValidation) return null;
  if (workspaceValidation.reason !== "git_worktree_branch_incoherence") return null;
  const provenance = asRecord(workspaceValidation.provenance) ?? {};
  const expectedBranch = asNonEmptyString(workspaceValidation.expectedBranch);
  const liveBranch = asNonEmptyString(workspaceValidation.actualBranch);
  const expectedHeadSha = asNonEmptyString(provenance.expectedHeadSha);
  const liveHeadSha = asNonEmptyString(provenance.actualHeadSha);
  const cleanlinessRaw = workspaceValidation.cleanliness;
  const cleanliness =
    cleanlinessRaw === "clean" || cleanlinessRaw === "dirty" || cleanlinessRaw === "unknown"
      ? cleanlinessRaw
      : null;
  const sourceIdentifier = asNonEmptyString(workspaceValidation.sourceIdentifier);
  return {
    expectedBranch,
    liveBranch,
    expectedHeadSha,
    liveHeadSha,
    ancestryVerdict: asAncestryVerdict(provenance.ancestryVerdict),
    plainLanguageReason: asNonEmptyString(provenance.plainLanguageReason),
    cleanliness,
    dirtyFileCount: asNonNegativeInt(workspaceValidation.statusEntryCount),
    dirtyPathSample: asStringArray(workspaceValidation.dirtyPathSample),
    contention: readContention(workspaceValidation.contention),
    rescueBranchPreview: buildRescueBranchPreview(sourceIdentifier),
    reissueBaseRef: liveBranch ?? liveHeadSha,
  };
}

const ANCESTRY_BADGE: Record<
  GitWorktreeBranchAncestryVerdict,
  { label: string; className: string }
> = {
  ancestor: {
    label: l10n("local.forward_only_8ab1faed"),
    className: "border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  diverged: {
    label: l10n("local.diverged_ec67106c"),
    className: "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  unknown: {
    label: l10n("local.ancestry_unknown_83119bdb"),
    className: "border-border bg-muted/60 text-muted-foreground",
  },
};

function BranchFacet({
  label,
  branch,
  sha,
}: {
  label: string;
  branch: string | null;
  sha: string | null;
}) {
  const shortSha = formatShortSha(sha);
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
      <div className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {branch ? (
          <code className="truncate font-mono text-xs text-foreground/90">{branch}</code>
        ) : (
          <span className="text-xs italic text-muted-foreground">{l10n("local.detached_unknown_05fae70b")}</span>
        )}
      </div>
      <div className="mt-0.5 pl-5 font-mono text-(length:--text-micro) text-muted-foreground">
        {shortSha ? `@ ${shortSha}` : "@ —"}
      </div>
    </div>
  );
}

function DivergenceDiagnosis({
  divergence,
  dividerClass,
}: {
  divergence: WorkspaceDivergence;
  dividerClass: string;
}) {
  const badge = ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"];
  return (
    <div
      data-testid="recovery-divergence-diagnosis"
      className={cn(
        "space-y-2.5 border-t bg-background/40 px-3 py-3 dark:bg-background/20 sm:px-4",
        dividerClass,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {l10n("local.divergence_diagnosis_02f094ee")}</span>
        <Badge variant="outline"
          data-testid="recovery-ancestry-verdict"
          className={cn(
            "text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label)",
            badge.className,
          )}
        >
          {badge.label}
        </Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <BranchFacet
          label={l10n("local.expected_recorded_42e4fef0")}
          branch={divergence.expectedBranch}
          sha={divergence.expectedHeadSha}
        />
        <BranchFacet
          label={l10n("local.live_checked_out_842e7ba2")}
          branch={divergence.liveBranch}
          sha={divergence.liveHeadSha}
        />
      </div>
      {divergence.plainLanguageReason ? (
        <p className="text-xs leading-5 text-foreground/80">{divergence.plainLanguageReason}</p>
      ) : null}
      {divergence.contention ? (
        <p
          data-testid="recovery-contention-notice"
          className="flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-500/5 px-2.5 py-1.5 text-xs leading-5 text-amber-900 dark:text-amber-200"
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {l10n("local.worktree_claimed_by_94f9b256")}{" "}
            <code className="font-mono text-foreground/90">{contentionLabel(divergence.contention)}</code>{" "}
            {divergence.contention.hasActiveRun ? l10n("local._active_run_66a9e1b6") : l10n("local._claim_held_20b3f865")} {l10n("local._the_lossless_repair_can_apos_t_run_while_ano_f5163111")}</span>
        </p>
      ) : null}
    </div>
  );
}

function contentionLabel(contention: WorkspaceContention): string {
  return (
    contention.claimedByIssueIdentifier ??
    (contention.claimedByIssueId ? `issue ${contention.claimedByIssueId.slice(0, 8)}` : "another task")
  );
}

/**
 * Action 2 — the audited break-glass override. Gated by an explicit confirm step that *restates the
 * divergence* (both branches + short SHAs + ancestry verdict) and a required, non-empty reason: the
 * confirm button stays disabled until the operator records why. The server re-checks the actor and
 * permission and appends the reason to the audit log — this UI gate is the operator-facing guardrail,
 * not the security boundary.
 */
function BreakGlassOverride({
  divergence,
  onConfirm,
  pending,
}: {
  divergence: WorkspaceDivergence;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length > 0 && !pending;
  const verdictBadge = ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"];
  const expectedSha = formatShortSha(divergence.expectedHeadSha);
  const liveSha = formatShortSha(divergence.liveHeadSha);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="recovery-action-breakglass-trigger"
          className="border-red-400/60 text-red-700 hover:bg-red-500/10 dark:border-red-500/40 dark:text-red-300"
        >
          <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
          {l10n("local.i_apos_ve_verified_this_reconcile_anyway_538d6d70")}</Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-labelledby="recovery-breakglass-title"
        className="w-96 max-w-(--sz-calc-4) space-y-3 p-3"
      >
        <div className="space-y-1">
          <div
            id="recovery-breakglass-title"
            className="flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-red-700 dark:text-red-300"
          >
            <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
            {l10n("local.break_glass_reconciliation_73512366")}</div>
          <p className="text-xs leading-5 text-muted-foreground">
            {l10n("local.this_overrides_paperclip_apos_s_safety_check_e17b70d7")}{" "}
            <span className="font-medium text-foreground/80">{l10n("local.without_an_ancestry_proof_d4c337c4")}</span>{l10n("local._confirm_the_divergence_below_and_record_why_4e812217")}</p>
        </div>
        <dl
          data-testid="recovery-breakglass-restated-divergence"
          className="space-y-1.5 rounded-md border border-red-400/40 bg-red-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.recorded_expected_1869f1a4")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? l10n("local.detached_88e34e4c")}
              {expectedSha ? ` @ ${expectedSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.live_checked_out_842e7ba2")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? l10n("local.detached_88e34e4c")}
              {liveSha ? ` @ ${liveSha}` : ""}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.ancestry_verdict_bee6031b")}</dt>
            <dd className="font-medium">{verdictBadge.label}</dd>
          </div>
        </dl>
        <div className="space-y-1">
          <Label htmlFor="recovery-breakglass-reason" className="text-(length:--text-micro) text-muted-foreground">
            {l10n("local.reason_f81ab834")}{" "}<span className="text-red-600 dark:text-red-400">{l10n("local._required_recorded_in_the_audit_log_b0e8acff")}</span>
          </Label>
          <Textarea
            id="recovery-breakglass-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={l10n("local.e_g_verified_the_live_branch_carries_only_the_df2b78ba")}
            className="min-h-20 text-xs"
            data-testid="recovery-breakglass-reason"
            aria-required="true"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="w-full"
          disabled={!canSubmit}
          data-testid="recovery-action-breakglass-confirm"
          onClick={() => {
            if (!canSubmit) return;
            onConfirm(trimmedReason);
          }}
        >
          {pending ? l10n("local.reconciling_8adbed64") : l10n("local.reconcile_anyway_break_glass_b9913635")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The lossless repair — quarantine the dirty worktree onto a rescue branch, then restore the
 * recorded branch. Unlike break-glass, this is *non-destructive* (no work is lost, so no reason is
 * required): the confirm popover simply restates what will happen — the dirty file count, that the
 * live branch is left untouched, the rescue branch that will hold the changes, and the recorded
 * branch to be restored. Disabled (with an inline explanation, no popover) when the live branch is
 * contended by another workspace, since the server refuses the repair in that case.
 */
function RepairWorkspace({
  divergence,
  onConfirm,
  pending,
  disabled,
  disabledReason,
}: {
  divergence: WorkspaceDivergence;
  onConfirm: () => void;
  pending: boolean;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const dirtyCount = divergence.dirtyFileCount;
  const dirtyLabel =
    dirtyCount === null
      ? l10n("local.uncommitted_changes_a388bd2d")
      : l10n("local.value_uncommitted_value_489fabf6", {v0: (dirtyCount), v1: (dirtyCount === 1 ? "change" : "changes")});
  const trigger = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending || disabled}
      data-testid="recovery-action-repair-trigger"
      className="border-sky-400/50 text-sky-700 hover:bg-sky-500/10 dark:border-sky-500/40 dark:text-sky-300"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Wrench className="h-3.5 w-3.5" aria-hidden />
      )}
      {l10n("local.repair_workspace_quarantine_changes_amp_resto_4f1b29b2")}</Button>
  );
  if (disabled) {
    // Contended: the server refuses the repair, so render a plainly disabled control with the reason
    // inline rather than a popover the operator can't act on.
    return (
      <div className="flex flex-col gap-1" data-testid="recovery-action-repair-disabled">
        {trigger}
        {disabledReason ? (
          <span className="text-(length:--text-nano) leading-4 text-muted-foreground">
            {disabledReason}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-labelledby="recovery-repair-title"
        className="w-96 max-w-(--sz-calc-4) space-y-3 p-3"
      >
        <div className="space-y-1">
          <div
            id="recovery-repair-title"
            className="flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-sky-700 dark:text-sky-300"
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            {l10n("local.repair_workspace_152f148b")}</div>
          <p className="text-xs leading-5 text-muted-foreground">
            {l10n("local.this_is_lossless_no_reason_required_your_unco_d38bf6fc")}</p>
        </div>
        <dl
          data-testid="recovery-repair-restated"
          className="space-y-1.5 rounded-md border border-sky-400/30 bg-sky-500/5 px-2.5 py-2 text-(length:--text-micro)"
        >
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.dirty_changes_29f59cc3")}</dt>
            <dd data-testid="recovery-repair-dirty-count" className="font-medium text-foreground/90">
              {dirtyLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.live_branch_b0d6b594")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.liveBranch ?? l10n("local.detached_88e34e4c")}
              <span className="ml-1 font-sans text-muted-foreground">{l10n("local._left_untouched_2500b7ae")}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.rescue_branch_e1151230")}</dt>
            <dd
              data-testid="recovery-repair-rescue-branch"
              className="min-w-0 truncate font-mono text-foreground/90"
            >
              {divergence.rescueBranchPreview}
              <span className="text-muted-foreground">&lt;timestamp&gt;</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{l10n("local.restore_to_9d1b6771")}</dt>
            <dd className="min-w-0 truncate font-mono text-foreground/90">
              {divergence.expectedBranch ?? l10n("local.recorded_branch_9a6e1632")}
            </dd>
          </div>
        </dl>
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={pending}
          data-testid="recovery-action-repair-confirm"
          onClick={() => {
            if (pending) return;
            onConfirm();
          }}
        >
          {pending ? l10n("local.repairing_fb4c616e") : l10n("local.quarantine_changes_restore_branch_e648b8fc")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function readWakePolicySummary(action: IssueRecoveryAction): string | null {
  const policy = action.wakePolicy;
  if (!policy) return null;
  const type = readEvidenceString(policy.type);
  if (!type) return null;
  if (type === "wake_owner") return l10n("local.an_agent_will_be_asked_to_choose_the_next_ste_9beb9b59");
  if (type === "bounded_owner_disposition_repair") {
    return l10n("local.paperclip_is_retrying_the_original_owner_833a8a2e");
  }
  if (type === "bounded_recovery_owner") return l10n("local.a_recovery_owner_is_repairing_the_next_step_f927e4ab");
  if (type === "board_escalation") return l10n("local.board_decision_required_e6936688");
  if (type === "manual") return l10n("local.manual_follow_up_needed_9bd119ba");
  if (type === "manual_repair_required") return l10n("local.repair_needed_before_retry_a014a14c");
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval ? `Check scheduled · ${interval}` : "Check scheduled";
  }
  return type.replaceAll("_", " ");
}

function formatTimeShort(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMs = date.getTime() - now;
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    if (absMin < 60) {
      return diffMs >= 0 ? `in ${absMin}m` : `${absMin}m ago`;
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function shortenRunId(runId: string | null | undefined) {
  if (!runId) return null;
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-(--gtc-8) gap-x-3 gap-y-0 px-3 py-1.5 text-xs sm:px-4">
      <dt className="truncate text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

function MissingValue() {
  return <span className="text-muted-foreground">—</span>;
}

function AgentLink({
  agentId,
  agentMap,
  fallback,
}: {
  agentId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Agent>;
  fallback?: string | null;
}) {
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label = agent?.name ?? l10n("local.agent_value_8e17b76e", {v0: (agentId.slice(0, 8))});
  if (agent) {
    return (
      <Link
        to={agentUrl(agent)}
        className="rounded-sm font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}

function RunChip({
  runId,
  agentId,
  status,
}: {
  runId: string | null;
  agentId: string | null | undefined;
  status?: string | null;
}) {
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
        run {short}
      </code>
      {status ? (
        <span className="font-sans text-(length:--text-micro) text-muted-foreground">{status}</span>
      ) : null}
    </>
  );
  if (agentId) {
    return (
      <Link
        to={`/agents/${agentId}/runs/${runId}`}
        className="inline-flex items-center gap-2 rounded-sm underline-offset-2 hover:underline"
      >
        {inner}
      </Link>
    );
  }
  return <span className="inline-flex items-center gap-2">{inner}</span>;
}

function formatTimeAbsolute(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Headline for an action carrying a bounded retry lineage. It names who keeps the task in
 * every phase, because a manager owning the repair must never read as a manager owning
 * the deliverable.
 */
function lineageHeadline(lineage: RecoveryRetryLineage): string {
  // An attempt that came due and never ran leaves nobody working on this task, even though
  // attempts remain on paper. Say so before any lane wording that ends in "no action needed".
  if (lineage.retryExpired) {
    return "This task's automatic retry came due and did not run, so nothing is moving it forward right now. Someone must retry it or record the next step. The task stays with its original owner.";
  }
  if (lineage.lane === "source_owner") {
    return lineage.exhausted
      ? "This task's last run stopped to wait, but nothing was waiting for it. The original owner has used every automatic repair attempt, so the next step needs a decision. The task stays with its owner."
      : "This task's last run stopped to wait, but nothing was waiting for it. Paperclip is retrying the original owner to record a real next step. The task stays with its owner, and no action is needed yet.";
  }
  if (lineage.lane === "recovery_owner") {
    return "The original owner could not record a next step within its retry budget. A recovery owner is now repairing the path only — the task itself still belongs to its original owner.";
  }
  return "Automatic recovery is exhausted, so the board must choose the next step. The task itself still belongs to its original owner.";
}

/** Spent/remaining attempts as pips. The readable count lives beside it in text. */
function AttemptMeter({ lineage }: { lineage: RecoveryRetryLineage }) {
  if (lineage.maxAttempts === null || lineage.maxAttempts > 12) return null;
  const spent = Math.min(lineage.attempt, lineage.maxAttempts);
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {Array.from({ length: lineage.maxAttempts }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 rounded-full",
            index < spent ? "bg-current opacity-80" : "bg-current opacity-25",
          )}
        />
      ))}
    </span>
  );
}

const RESOLVE_OPTIONS: Array<{
  outcome: RecoveryResolveOutcome;
  label: string;
  description: string;
  destructive?: boolean;
  boardOnly?: boolean;
}> = [
  {
    outcome: "todo",
    label: l10n("local.try_again_d8b8392e"),
    description: l10n("local.dismiss_recovery_and_return_the_source_task_t_349c0362"),
  },
  {
    outcome: "done",
    label: l10n("local.mark_task_done_b33502ef"),
    description: l10n("local.restore_by_recording_the_requested_work_as_co_c6d92468"),
  },
  {
    outcome: "in_review",
    label: l10n("local.send_for_review_f7cb7531"),
    description: l10n("local.hand_off_to_a_reviewer_with_a_real_review_pat_6c2fe06e"),
  },
  {
    outcome: "false_positive_done",
    label: l10n("local.false_positive_done_d72c84ea"),
    description: l10n("local.dismiss_recovery_and_mark_the_source_task_com_887a2af6"),
    destructive: true,
    boardOnly: true,
  },
  {
    outcome: "false_positive_in_review",
    label: l10n("local.false_positive_review_26b07b9b"),
    description: l10n("local.dismiss_recovery_and_send_the_source_task_for_fecfa574"),
    destructive: true,
    boardOnly: true,
  },
];

export function IssueRecoveryActionCard({
  action,
  agentMap,
  scheduledRetry = null,
  forcedState,
  onResolve,
  onReissueIsolated,
  reissuePending = false,
  onReconcileForward,
  onBreakGlassOverride,
  onQuarantineRestore,
  quarantineRestorePending = false,
  canBreakGlass = false,
  reconcilePending = false,
  canFalsePositive = false,
  variant = "full",
  className,
}: IssueRecoveryActionCardProps) {
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const liveness = useMemo(() => ({ scheduledRetry }), [scheduledRetry]);
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action, liveness);
  const tone = STATE_TONE[cardState];
  const ToneIcon = tone.Icon;
  const divergence = useMemo(() => readWorkspaceDivergence(action), [action]);
  const lineage = useMemo(() => readRecoveryRetryLineage(action, liveness), [action, liveness]);

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      return `Recovery resolved as ${OUTCOME_LABEL[action.outcome] ?? action.outcome}.`;
    }
    if (
      (cardState === "needed" || cardState === "escalated") &&
      action.kind === "active_run_watchdog" &&
      action.ownerType === "board"
    ) {
      return "This recovery needs a human decision. Review the recorded failure and choose the next step.";
    }
    if (lineage) return lineageHeadline(lineage);
    return KIND_HEADLINE[action.kind] ?? KIND_HEADLINE.missing_disposition;
  }, [action.kind, action.outcome, action.ownerType, cardState, lineage]);

  // A lane with no path left must not keep advertising a retry that will never run — whether
  // the budget ran out or the scheduled attempt simply never fired.
  const wakeSummary = lineage?.retryExpired
    ? l10n("local.the_scheduled_retry_did_not_run_a_retry_or_a_ed36a28b")
    : lineage?.exhausted && lineage.lane !== "board"
    ? l10n("local.automatic_retries_are_finished_a_decision_is_82f7e281")
    : readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  // The lineage rows below already carry the attempt budget, so the generic chip only
  // covers actions without one.
  const showAttempt = !lineage && action.attemptCount > 1 && action.maxAttempts !== null;
  const sourceOwnerAgentId = action.returnOwnerAgentId ?? action.previousOwnerAgentId;
  const recoveryOwnerIsSourceOwner =
    action.ownerType === "agent" &&
    action.ownerAgentId !== null &&
    action.ownerAgentId === sourceOwnerAgentId;
  const retryOffset = lineage ? formatRecoveryRetryOffset(lineage) : null;
  const attemptLabel = lineage ? formatRecoveryAttemptLabel(lineage) : null;
  const showTimeoutInline = (() => {
    // The retry-progress row is the single place a lineage reports its timing.
    if (lineage) return false;
    if (!action.timeoutAt) return false;
    try {
      const date = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 && diffMs < 60 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  const updatedAtLabel = formatTimeShort(action.updatedAt);

  const ariaState = ({
    needed: "needed",
    in_progress: "in progress",
    observe_only: "observing active run",
    escalated: "escalated",
    resolved: "resolved",
  } satisfies Record<RecoveryCardCardState, string>)[cardState];

  const showResolveActions = onResolve !== undefined && cardState !== "resolved";
  const visibleResolveOptions = RESOLVE_OPTIONS.filter((option) => {
    if (option.outcome === "todo" && requiresExecutionReconciliation(action.cause)) return false;
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });
  const reissueBaseRef = divergence?.reissueBaseRef ?? null;
  const showReissueAction =
    workspaceIsolationControlsVisible &&
    onReissueIsolated !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    reissueBaseRef !== null;
  const reissueVerdictBadge = divergence
    ? ANCESTRY_BADGE[divergence.ancestryVerdict ?? "unknown"]
    : null;
  // Action 1 — the ancestry-proven safe path. Only offered when the server-computed verdict is
  // "ancestor"; the server re-verifies before mutating, so this gate mirrors (not replaces) it.
  const showReconcileForward =
    onReconcileForward !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    divergence.ancestryVerdict === "ancestor";
  // Action 2 — the break-glass override. Permission-hidden: absent entirely unless the viewer is a
  // permitted operator. The confirm step (restated divergence + required reason) lives in the popover.
  const showBreakGlass =
    onBreakGlassOverride !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    canBreakGlass;
  // The lossless repair — offered only for a *dirty* divergence (a clean one reconciles forward or
  // via break-glass, with nothing to quarantine). Disabled when the live branch is contended by an
  // active claimant, since the server refuses `quarantine_restore` in that case.
  const repairContention = divergence?.contention ?? null;
  const showRepairAction =
    onQuarantineRestore !== undefined &&
    cardState !== "resolved" &&
    divergence !== null &&
    divergence.cleanliness === "dirty";
  const repairDisabledReason = repairContention
    ? `Held by ${contentionLabel(repairContention)}${showReissueAction ? " — re-issue on an isolated workspace instead." : "."}`
    : null;
  // When contended, the re-issue is the recommended path, so it takes the primary emphasis and a
  // "Recommended" hint while the repair button is disabled.
  const reissueRecommended = showRepairAction && repairContention !== null;
  const showFooter =
    showResolveActions ||
    showReissueAction ||
    showReconcileForward ||
    showBreakGlass ||
    showRepairAction;

  if (requiresExecutionReconciliation(action.cause)) return null;

  return (
    <section
      role="status"
      aria-label={l10n("local.recovery_action_value_c453b342", {v0: (ariaState)})}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
      data-recovery-lane={lineage?.lane}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-(--shadow-extract-8)",
        tone.containerClass,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone.iconWrapClass,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tone.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)">
            <span className={tone.labelClass}>{tone.label}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) tracking-normal text-muted-foreground">
              {KIND_LABEL[action.kind] ?? action.kind}
            </code>
            {updatedAtLabel ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {updatedAtLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-6">{headline}</p>
        </div>
      </header>
      {variant === "compact" ? null : (
      <dl className={cn("border-t bg-background/40 dark:bg-background/20", tone.divider)}>
        {lineage ? (
          <>
            <MetadataRow label={l10n("local.task_owner_e600ccf8")}>
              <span
                className="inline-flex flex-wrap items-center gap-1.5"
                data-testid="recovery-source-owner"
              >
                <AgentLink
                  agentId={sourceOwnerAgentId}
                  agentMap={agentMap}
                  fallback="unassigned"
                />
                <span className="text-muted-foreground">{l10n("local.keeps_this_task_6fffd595")}</span>
              </span>
            </MetadataRow>
            <MetadataRow label={l10n("local.recovery_owner_27c6c04c")}>
              <span
                className="inline-flex flex-wrap items-center gap-1.5"
                data-testid="recovery-recovery-owner"
              >
                {recoveryOwnerIsSourceOwner ? (
                  <span className="font-medium">{l10n("local.original_owner_retrying_itself_21196882")}</span>
                ) : action.ownerType === "agent" && action.ownerAgentId ? (
                  <>
                    <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
                    <span className="text-muted-foreground">{l10n("local.repairs_the_next_step_only_907769bc")}</span>
                  </>
                ) : action.ownerType === "board" ? (
                  <>
                    <span className="font-medium">{l10n("local.board_4816cbfd")}</span>
                    <span className="text-muted-foreground">{l10n("local.decides_the_next_step_only_425ea666")}</span>
                  </>
                ) : action.ownerType === "user" && action.ownerUserId ? (
                  <span className="font-medium">{l10n("local.user_04f8996d")}{" "}{action.ownerUserId.slice(0, 6)}</span>
                ) : (
                  <span className="text-muted-foreground">{l10n("local.unassigned_pick_one_to_wake_them_68903e71")}</span>
                )}
              </span>
            </MetadataRow>
            <MetadataRow label={l10n("local.retry_progress_edb85d9f")}>
              <span
                className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
                data-testid="recovery-retry-progress"
                data-recovery-lane={lineage.lane}
                data-recovery-attempt={lineage.attempt}
                data-recovery-max-attempts={lineage.maxAttempts ?? undefined}
              >
                <AttemptMeter lineage={lineage} />
                <span>{attemptLabel ?? l10n("local.attempts_not_bounded_3ccd1bed")}</span>
                {lineage.liveRunId ? (
                  <span
                    className={RETRY_PILL_CLASS}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                  >
                    {l10n("local.attempt_running_now_5ff77617")}</span>
                ) : lineage.retryExpired ? (
                  // The due time is stated plainly as missed. Rendering it as "Next try 5m
                  // ago" is what made an abandoned lane read as healthy recovery.
                  <span
                    className={cn(RETRY_PILL_CLASS, "border-destructive/50 bg-destructive/10 text-destructive")}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                    data-recovery-retry-expired="true"
                  >
                    {retryOffset ? l10n("local.retry_missed_value_cafb69d7", {v0: (retryOffset)}) : l10n("local.retry_missed_a3e392ad")}
                  </span>
                ) : retryOffset ? (
                  <span
                    className={RETRY_PILL_CLASS}
                    title={formatTimeAbsolute(lineage.nextRetryAt) ?? undefined}
                    data-testid="recovery-next-retry"
                  >
                    {retryOffset === "now" ? l10n("local.next_try_now_3101ffa0") : l10n("local.next_try_value_97dabfd6", {v0: (retryOffset)})}
                  </span>
                ) : lineage.exhausted ? (
                  <span className={RETRY_PILL_CLASS} data-testid="recovery-next-retry">
                    {l10n("local.automatic_retries_used_up_d074fd7d")}</span>
                ) : null}
              </span>
            </MetadataRow>
            {lineage.lane !== "source_owner" && lineage.sourceMaxAttempts !== null ? (
              <MetadataRow label={l10n("local.owner_retries_1db44f58")}>
                <span data-testid="recovery-source-attempts">
                  {l10n("local.the_original_owner_used_79ab8618")}{" "}{lineage.sourceAttempt ?? lineage.sourceMaxAttempts} {l10n("local.of_28391d3b")}{" "}
                  {lineage.sourceMaxAttempts} {l10n("local.automatic_attempts_bbe993c6")}</span>
              </MetadataRow>
            ) : null}
          </>
        ) : (
        <MetadataRow label={l10n("local.owner_4b1b8aa3")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">{l10n("local.recovery_a812f4b2")}</span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">{l10n("local.board_4816cbfd")}</span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium">{l10n("local.user_04f8996d")}{" "}{action.ownerUserId.slice(0, 6)}</span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">{l10n("local.system_6725e7bb")}</span>
            ) : (
              <span className="text-muted-foreground">{l10n("local.unassigned_pick_one_to_wake_them_68903e71")}</span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">{l10n("local._returns_to_1e820759")}</span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        )}
        <MetadataRow label={l10n("local.source_run_bb84312e")}>
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow label={l10n("local.corrective_run_87e1de42")}>
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow label={l10n("local.evidence_03867aea")}>
          {evidenceSummary ? (
            evidenceSummary.isCode ? (
              <span className="break-words font-mono text-(length:--text-micro) text-foreground/80">
                {evidenceSummary.text}
              </span>
            ) : (
              <span className="text-xs leading-5 text-foreground/80">{evidenceSummary.text}</span>
            )
          ) : (
            <MissingValue />
          )}
        </MetadataRow>
        <MetadataRow label={l10n("local.next_action_365987d0")}>
          {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
        </MetadataRow>
        <MetadataRow label={l10n("local.follow_up_09b2d9cd")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                {l10n("local.attempt_c7ce66d0")}{" "}{action.attemptCount} {l10n("local.of_28391d3b")}{" "}{action.maxAttempts}
              </span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                {l10n("local.times_out_d239ec5d")}{" "}{formatTimeShort(action.timeoutAt) ?? l10n("local.soon_4a754148")}
              </span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow label={l10n("local.resolution_d4055faf")}>
            <span className={cn("font-medium", tone.labelClass)}>
              {l10n("local.resolved_as_53ac3f26")}{" "}{OUTCOME_LABEL[action.outcome]}
              {action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}
            </span>
          </MetadataRow>
        ) : null}
      </dl>
      )}
      {divergence ? <DivergenceDiagnosis divergence={divergence} dividerClass={tone.divider} /> : null}
      {showFooter ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          {showResolveActions ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="recovery-action-resolve-trigger"
                  aria-label={l10n("local.resolve_recovery_0e77e521")}
                >
                  {l10n("local.resolve_a55fea56")}</Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-72 p-1.5"
              >
                <div className="px-2 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                  {l10n("local.resolve_recovery_0e77e521")}</div>
                <div className="flex flex-col">
                  {visibleResolveOptions.map((option) => (
                    <button
                      key={option.outcome}
                      type="button"
                      onClick={() => onResolve?.(option.outcome)}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        option.destructive ? "text-destructive" : null,
                      )}
                    >
                      <span className="font-medium leading-5">{option.label}</span>
                      <span className="text-(length:--text-micro) leading-4 text-muted-foreground">{option.description}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {showReconcileForward ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={reconcilePending}
              data-testid="recovery-action-reconcile-forward"
              onClick={() => onReconcileForward?.()}
            >
              {reconcilePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              {l10n("local.reconcile_forward_amp_continue_6cea09a1")}</Button>
          ) : null}
          {showRepairAction && divergence ? (
            <RepairWorkspace
              divergence={divergence}
              pending={quarantineRestorePending}
              disabled={repairContention !== null}
              disabledReason={repairDisabledReason}
              onConfirm={() => onQuarantineRestore?.()}
            />
          ) : null}
          {showReissueAction && divergence && reissueBaseRef ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={reissueRecommended ? "default" : "outline"}
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-trigger"
                  data-recommended={reissueRecommended ? "true" : undefined}
                >
                  {reissuePending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <GitBranchPlus className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {l10n("local.re_issue_on_isolated_workspace_21625ad5")}{reissueRecommended ? (
                    <span
                      data-testid="recovery-reissue-recommended"
                      className="ml-1 rounded-sm bg-background/25 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label)"
                    >
                      {l10n("local.recommended_d70604e8")}</span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 space-y-3 p-3">
                <div className="space-y-1">
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {l10n("local.re_issue_on_isolated_workspace_21625ad5")}</div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {l10n("local.creates_a_fresh_copy_of_this_task_on_an_isola_251d91cd")}</p>
                </div>
                <dl className="space-y-1 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-(length:--text-micro)">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{l10n("local.base_ref_9c6c10f9")}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/90">{reissueBaseRef}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{l10n("local.recorded_c7175fa7")}</dt>
                    <dd className="min-w-0 truncate font-mono text-foreground/80">
                      {divergence.expectedBranch ?? "—"}
                    </dd>
                  </div>
                  {reissueVerdictBadge ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{l10n("local.ancestry_65a04682")}</dt>
                      <dd className="font-medium">{reissueVerdictBadge.label}</dd>
                    </div>
                  ) : null}
                </dl>
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={reissuePending}
                  data-testid="recovery-action-reissue-confirm"
                  onClick={() =>
                    onReissueIsolated?.({
                      baseRef: reissueBaseRef,
                      liveBranch: divergence.liveBranch,
                      liveHeadSha: divergence.liveHeadSha,
                      expectedBranch: divergence.expectedBranch,
                    })
                  }
                >
                  {reissuePending ? l10n("local.creating_c79ed949") : l10n("local.create_isolated_re_issue_3d7a1128")}
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
          {showBreakGlass && divergence ? (
            <BreakGlassOverride
              divergence={divergence}
              pending={reconcilePending}
              onConfirm={(reason) => onBreakGlassOverride?.(reason)}
            />
          ) : null}
          {showResolveActions ? (
            cardState === "observe_only" ? (
              <span className="text-(length:--text-micro) text-muted-foreground">
                {l10n("local.recovery_is_observing_without_interrupting_th_b2a50809")}</span>
            ) : (
              <span className="text-(length:--text-micro) text-muted-foreground">
                {l10n("local.the_card_stays_open_until_an_explicit_decisio_84526fce")}</span>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
