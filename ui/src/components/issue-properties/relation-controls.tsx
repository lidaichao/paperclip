import { l10n } from "../../i18n";
import { useState, type MouseEvent } from "react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowUpRight, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { StatusIcon } from "../StatusIcon";

export function RemovableIssueReferencePill({
  issue,
  onRemove,
  isMobile = false,
}: {
  issue: NonNullable<Issue["blockedBy"]>[number];
  onRemove: (issueId: string) => void;
  isMobile?: boolean;
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const issueLabel = issue.identifier ?? issue.title;
  const confirmLabel = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  const chipClassName = cn(
    "paperclip-mention-chip paperclip-mention-chip--issue",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
  );
  const content = (
    <>
      <StatusIcon status={issue.status} className="h-3 w-3 shrink-0" />
      <span className="truncate">{issueLabel}</span>
    </>
  );
  const removeLabel = l10n("local.remove_value_as_blocker_eaf9d3b1", {v0: (issueLabel)});
  const openRemoveConfirmation = () => setIsConfirmOpen(true);
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openRemoveConfirmation();
  };
  const confirmRemove = () => {
    onRemove(issue.id);
    setIsConfirmOpen(false);
  };

  return (
    <>
      <span className="group relative inline-flex">
        {isMobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={l10n("local.actions_for_blocker_value_522221c1", {v0: (issueLabel)})}
              >
                {content}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {issue.identifier ? (
                <DropdownMenuItem asChild>
                  <Link to={`/issues/${issue.identifier}`}>
                    <ArrowUpRight className="h-4 w-4" />
                    {l10n("local.visit_task_ecacc67b")}</Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={openRemoveConfirmation}>
                <X className="h-4 w-4" />
                {l10n("local.remove_blocker_76792aa6")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            <button
              type="button"
              className="absolute -right-1 -top-1 z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-colors transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-(length:--rad-2) focus-visible:ring-ring group-hover:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={handleRemove}
            >
              <X className="h-3 w-3" />
            </button>
            {issue.identifier ? (
              <Link
                to={`/issues/${issue.identifier}`}
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={l10n("local.task_value_value_e4eb199f", {v0: (issueLabel), v1: (issue.title)})}
              >
                {content}
              </Link>
            ) : (
              <span
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={l10n("local.task_value_4d9fe20e", {v0: (issue.title)})}
              >
                {content}
              </span>
            )}
          </>
        )}
      </span>
      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{l10n("local.remove_blocker_b7d963b0")}</DialogTitle>
            <DialogDescription>
              {l10n("local.remove_c3812fc4")}{" "}{confirmLabel} {l10n("local.as_a_blocker_for_this_task_33a5250e")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{l10n("local.cancel_19766ed6")}</Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmRemove}>
              {l10n("local.remove_blocker_76792aa6")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ExpandRelationListButton({
  hiddenCount,
  expanded,
  onClick,
}: {
  hiddenCount: number;
  expanded: boolean;
  onClick: () => void;
}) {
  if (!expanded && hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
      aria-label={expanded ? l10n("local.show_fewer_items_b908f492") : l10n("local.show_value_more_items_21153fcb", {v0: (hiddenCount)})}
    >
      {expanded ? l10n("local.show_less_94ea9b1d") : l10n("local.show_value_more_df1508f6", {v0: (hiddenCount)})}
    </button>
  );
}
