import { l10n } from "../i18n";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import {
  IssueRecoveryActionCard,
  type RecoveryReissueRequest,
  type RecoveryResolveOutcome,
} from "./IssueRecoveryActionCard";
import {
  canBoardManageRuntime,
  readRecoveryReconcileWorkspaceId,
} from "../lib/recovery-reconcile";

/** The run errorCode Paperclip stamps when it declines a run over a git workspace it can't validate. */
export const WORKSPACE_VALIDATION_RUN_ERROR_CODE = "workspace_validation_failed";

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

/**
 * Reads the source issue id a failed run was working when it was declined over workspace validation.
 * The run's context snapshot pins the issue the recovery action lives on.
 */
function readRunIssueId(run: HeartbeatRun): string | null {
  const context = asRecord(run.contextSnapshot);
  if (!context) return null;
  return asNonEmptyString(context.issueId);
}

/**
 * Run-page recovery surface. When a run *failed* with workspace-validation evidence, this fetches
 * the source issue's active recovery action and renders the same `IssueRecoveryActionCard`
 * (compact) that `IssueDetail` shows — wired to the same reconcile-forward / repair / re-issue /
 * break-glass / resolve handlers — so the divergence can be resolved from the run view directly.
 *
 * Renders nothing unless the run is a workspace-validation failure whose source issue still carries
 * a live `workspace_validation` recovery action.
 */
export function RunWorkspaceRecoverySurface({ run }: { run: HeartbeatRun }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const isWorkspaceValidationFailure =
    run.status === "failed" && run.errorCode === WORKSPACE_VALIDATION_RUN_ERROR_CODE;
  const issueId = readRunIssueId(run);

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueId!),
    enabled: Boolean(isWorkspaceValidationFailure && issueId),
  });

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: Boolean(isWorkspaceValidationFailure && issueId),
    retry: false,
  });

  const recoveryAction = issue?.activeRecoveryAction ?? null;
  const canManageBoardRuntime = canBoardManageRuntime(run.companyId, boardAccess);
  // Prefer the workspace pinned by the recovery action's evidence (the workspace that actually
  // diverged) over the page-level id, which can drift after a re-issue rebinds the issue.
  const reconcileWorkspaceId =
    readRecoveryReconcileWorkspaceId(recoveryAction) ?? issue?.executionWorkspaceId ?? null;

  const invalidate = useCallback(() => {
    if (issueId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(run.id) });
  }, [issueId, queryClient, run.id]);

  const reconcile = useMutation({
    mutationFn: (
      input:
        | { workspaceId: string; mode: "forward" }
        | { workspaceId: string; mode: "override"; reason: string }
        | { workspaceId: string; mode: "quarantine_restore" },
    ) => {
      const { workspaceId, ...body } = input;
      return executionWorkspacesApi.reconcile(workspaceId, body);
    },
    onSuccess: (_result, variables) => {
      invalidate();
      pushToast(
        variables.mode === "quarantine_restore"
          ? {
              title: l10n("local.workspace_repaired_22f46fd2"),
              body: "Dirty changes were quarantined onto a rescue branch and the recorded branch restored; the task will resume.",
              tone: "success",
            }
          : {
              title: l10n("local.workspace_branch_reconciled_a01d3ef7"),
              body: "The recorded branch now matches the live branch; the task will resume.",
              tone: "success",
            },
      );
    },
    onError: (err) => {
      pushToast({
        title: l10n("local.reconcile_failed_45e78183"),
        body: err instanceof Error ? err.message : l10n("local.unable_to_reconcile_the_workspace_branch_f5dd8112"),
        tone: "error",
      });
    },
  });

  const reissue = useMutation({
    mutationFn: async (request: RecoveryReissueRequest) => {
      if (!issue) throw new Error("Task is not loaded yet.");
      const sourceLabel = issue.identifier ?? l10n("local.the_stalled_task_701f1d79");
      const descriptionLines = [
        `Re-issued from ${sourceLabel} on an isolated git worktree after a workspace branch divergence.`,
        "",
        `- Base ref (live branch): \`${request.baseRef}\``,
        ...(request.expectedBranch ? [`- Recorded branch: \`${request.expectedBranch}\``] : []),
        "",
        "---",
        "",
        issue.description ?? "",
      ];
      return issuesApi.create(issue.companyId, {
        title: `Re-issue (isolated): ${issue.title ?? sourceLabel}`,
        description: descriptionLines.join("\n"),
        priority: issue.priority,
        projectId: issue.projectId ?? null,
        parentId: issue.parentId ?? null,
        assigneeAgentId:
          recoveryAction?.returnOwnerAgentId ??
          recoveryAction?.previousOwnerAgentId ??
          issue.assigneeAgentId ??
          null,
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", baseRef: request.baseRef },
        },
      });
    },
    onSuccess: (created) => {
      invalidate();
      pushToast({
        title: l10n("local.isolated_re_issue_created_6d112862"),
        body: created.identifier
          ? l10n("local.value_will_run_on_a_fresh_isolated_workspace_5c15dec5", {v0: (created.identifier)})
          : l10n("local.a_fresh_isolated_re_issue_was_created_f8e1a20e"),
        tone: "success",
      });
      if (created.identifier) {
        navigate(`/issues/${created.identifier}`);
      }
    },
    onError: (err) => {
      pushToast({
        title: l10n("local.re_issue_failed_d2f4dc96"),
        body: err instanceof Error ? err.message : l10n("local.unable_to_create_an_isolated_re_issue_36df82b6"),
        tone: "error",
      });
    },
  });

  const resolve = useMutation({
    mutationFn: (data: {
      outcome: "restored" | "false_positive";
      sourceIssueStatus: "todo" | "done" | "in_review";
    }) => {
      if (!issueId || !recoveryAction) throw new Error("No recovery action to resolve.");
      return issuesApi.resolveRecoveryAction(issueId, {
        actionId: recoveryAction.id,
        outcome: data.outcome,
        sourceIssueStatus: data.sourceIssueStatus,
      });
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => {
      pushToast({
        title: l10n("local.recovery_resolution_failed_f9244c72"),
        body: err instanceof Error ? err.message : l10n("local.unable_to_resolve_recovery_action_98c80218"),
        tone: "error",
      });
    },
  });

  const handleReconcileForward = useCallback(() => {
    if (!reconcileWorkspaceId) return;
    void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "forward" });
  }, [reconcile, reconcileWorkspaceId]);

  const handleBreakGlass = useCallback(
    (reason: string) => {
      if (!reconcileWorkspaceId) return;
      void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "override", reason });
    },
    [reconcile, reconcileWorkspaceId],
  );

  const handleQuarantineRestore = useCallback(() => {
    if (!reconcileWorkspaceId) return;
    void reconcile.mutateAsync({ workspaceId: reconcileWorkspaceId, mode: "quarantine_restore" });
  }, [reconcile, reconcileWorkspaceId]);

  const handleReissue = useCallback(
    (request: RecoveryReissueRequest) => {
      void reissue.mutateAsync(request);
    },
    [reissue],
  );

  const handleResolve = useCallback(
    (outcome: RecoveryResolveOutcome) => {
      switch (outcome) {
        case "todo":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "todo" });
          return;
        case "done":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "done" });
          return;
        case "in_review":
          void resolve.mutateAsync({ outcome: "restored", sourceIssueStatus: "in_review" });
          return;
        case "false_positive_done":
          void resolve.mutateAsync({ outcome: "false_positive", sourceIssueStatus: "done" });
          return;
        case "false_positive_in_review":
          void resolve.mutateAsync({ outcome: "false_positive", sourceIssueStatus: "in_review" });
          return;
      }
    },
    [resolve],
  );

  if (!isWorkspaceValidationFailure || !issueId) return null;
  if (!recoveryAction || recoveryAction.kind !== "workspace_validation") return null;

  return (
    <div className="space-y-2" data-testid="run-workspace-recovery-surface">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{l10n("local.workspace_recovery_9869a222")}</span>
        {issue?.identifier ? (
          <a
            href={`/issues/${issue.identifier}`}
            className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(`/issues/${issue.identifier}`);
            }}
          >
            {issue.identifier}
          </a>
        ) : null}
      </div>
      <IssueRecoveryActionCard
        action={recoveryAction}
        variant="compact"
        onResolve={handleResolve}
        onReissueIsolated={handleReissue}
        reissuePending={reissue.isPending}
        onReconcileForward={handleReconcileForward}
        onBreakGlassOverride={handleBreakGlass}
        onQuarantineRestore={handleQuarantineRestore}
        quarantineRestorePending={reconcile.isPending}
        reconcilePending={reconcile.isPending}
        canBreakGlass={canManageBoardRuntime}
      />
    </div>
  );
}

export default RunWorkspaceRecoverySurface;
