import { l10n } from "../i18n";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PauseCircle, PlayCircle, Repeat, XCircle } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** Shared by the task header and its Storybook composition. */
export function TaskTreeControlMenuItems({
  scope,
  canPause,
  canResume,
  canCancel,
  canRestore,
  pending,
  onPause,
  onResume,
  onCancel,
  onRestore,
}: {
  scope: "leaf" | "subtree";
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRestore: boolean;
  pending?: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRestore: () => void;
}) {
  const itemClass =
    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 disabled:opacity-50 disabled:pointer-events-none";
  return (
    <>
      {canPause ? (
        <button disabled={pending} className={itemClass} onClick={onPause}>
          <PauseCircle className="h-3 w-3" />
          {scope === "leaf" ? l10n("local.pause_work_0faaea9a") : l10n("local.pause_subtree_d4492053")}
        </button>
      ) : null}
      {canResume ? (
        <button disabled={pending} className={itemClass} onClick={onResume}>
          <PlayCircle className="h-3 w-3" />
          {scope === "leaf" ? l10n("local.resume_work_4c474b94") : l10n("local.resume_subtree_b3820988")}
        </button>
      ) : null}
      {canCancel ? (
        <button
          disabled={pending}
          className={`${itemClass} text-destructive`}
          onClick={onCancel}
        >
          <XCircle className="h-3 w-3" />
          {l10n("local.cancel_subtree_fccd5115")}</button>
      ) : null}
      {canRestore ? (
        <button disabled={pending} className={itemClass} onClick={onRestore}>
          <Repeat className="h-3 w-3" />
          {l10n("local.restore_subtree_b42c3044")}</button>
      ) : null}
    </>
  );
}

export function TaskTreeControlDialog({
  open,
  onOpenChange,
  mode,
  scope,
  affectedCount,
  affectedAgentCount,
  loading,
  error,
  pending,
  valid,
  wakeAgents,
  onWakeAgentsChange,
  onRetry,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "resume" | "cancel" | "restore";
  scope: "leaf" | "subtree";
  affectedCount: number;
  affectedAgentCount: number;
  loading: boolean;
  error?: string | null;
  pending: boolean;
  valid: boolean;
  wakeAgents: boolean;
  onWakeAgentsChange: (wake: boolean) => void;
  onRetry: () => void;
  onApply: () => void;
}) {
  const cancel = mode === "cancel";
  const tasks = `${affectedCount} task${affectedCount === 1 ? "" : "s"}`;
  const title = cancel
    ? l10n("local.cancel_subtree_b8b708d6")
    : mode === "restore"
      ? l10n("local.restore_subtree_d824b6aa")
      : scope === "leaf"
        ? l10n("local.resume_work_4c474b94")
        : l10n("local.resume_subtree_b3820988");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        className="max-h-(--sz-calc-18) overflow-y-auto sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {loading
              ? l10n("local.loading_ba3bbbe1")
              : cancel
                ? l10n("local.value_will_be_cancelled_d91d0193", {v0: (tasks)})
                : l10n("local.value_will_value_c256d634", {v0: (tasks), v1: (mode === "restore" ? "be restored" : "resume")})}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={onRetry}
            >
              {l10n("local.retry_preview_ceba3527")}</Button>
          </div>
        ) : null}
        {!cancel ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={wakeAgents}
              disabled={pending || loading || affectedAgentCount === 0}
              onChange={(event) => onWakeAgentsChange(event.target.checked)}
            />
            {l10n("local.wake_affected_agents_ba0ae697")}{affectedAgentCount})
          </label>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancel ? l10n("local.keep_tasks_8d7bd1de") : l10n("local.close_7d9eb7ac")}
          </Button>
          <Button
            variant={cancel ? "destructive" : "default"}
            disabled={pending || loading || !!error || !valid}
            onClick={onApply}
          >
            {pending
              ? l10n("local.applying_3329a9bb")
              : cancel
                ? l10n("local.cancel_value_db3da0ce", {v0: (tasks)})
                : mode === "restore"
                  ? l10n("local.restore_value_5ec37798", {v0: (tasks)})
                  : title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Quiet, persistent pause feedback shared by the task page and previews. */
export function TaskPauseNotice({
  scope,
  onResume,
  pending,
  className,
  resumeLink,
}: {
  scope: "leaf" | "subtree";
  onResume?: () => void;
  pending?: boolean;
  className?: string;
  resumeLink?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <span>
        {scope === "subtree" ? l10n("local.subtree_is_paused_f9ebf72d") : l10n("local.task_is_paused_fb9c04c9")}
      </span>
      {resumeLink ??
        (onResume ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onResume}
          >
            {scope === "subtree" ? l10n("local.resume_subtree_b3820988") : l10n("local.resume_work_4c474b94")}
          </Button>
        ) : null)}
    </div>
  );
}
