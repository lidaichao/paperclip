import { l10n } from "../../i18n";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IssueRow } from "@/components/IssueRow";
import { StatusIcon } from "@/components/StatusIcon";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
} from "@/lib/issueDetailBreadcrumb";
import { Link } from "@/lib/router";

export interface TaskDetailRelationItem {
  id: string;
  identifier?: string | null;
  title: string;
  status?: string | null;
}

export function RelationNavigationList({
  items,
  emptyMessage,
  ariaLabel,
  issueLinkState,
}: {
  items: TaskDetailRelationItem[];
  emptyMessage: string;
  ariaLabel: string;
  issueLinkState?: unknown;
}) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {items.map((item) => {
        const pathId = item.identifier ?? item.id;
        return (
          <li key={item.id}>
            <Link
              to={createIssueDetailPath(pathId)}
              state={issueLinkState}
              onClickCapture={() => rememberIssueDetailLocationState(pathId, issueLinkState)}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`${item.identifier ? `${item.identifier} — ` : ""}${item.title}`}
            >
              {item.status ? (
                <StatusIcon status={item.status} className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.identifier ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {item.identifier}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const NEXT_SUBTASK_STATUS_ORDER: IssueStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
  "blocked",
];

export function resolveTaskDetailSubtaskState(items: Issue[]) {
  const nextAction = NEXT_SUBTASK_STATUS_ORDER
    .map((status) => items.find((item) => item.status === status))
    .find((item): item is Issue => Boolean(item)) ?? null;
  const rootBlocker = nextAction?.status === "blocked"
    ? nextAction.blockerAttention?.terminalBlocker ?? null
    : null;

  return {
    nextAction,
    rootBlocker,
    remainingItems: nextAction
      ? items.filter((item) => item.id !== nextAction.id)
      : items,
  };
}

export function TaskDetailTaskList({
  items,
  ariaLabel,
  issueLinkState,
}: {
  items: Issue[];
  ariaLabel: string;
  issueLinkState?: unknown;
}) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.id}>
          <IssueRow
            issue={item}
            issueLinkState={issueLinkState}
            presentation="task"
            className="rounded-md"
          />
        </li>
      ))}
    </ul>
  );
}

export function TaskDetailSubtasksPanel({
  items,
  onAddSubtask,
  issueLinkState,
}: {
  items: Issue[];
  onAddSubtask?: () => void;
  issueLinkState?: unknown;
}) {
  const completed = items.filter((item) => item.status === "done").length;
  const progress = items.length > 0 ? Math.round((completed / items.length) * 100) : 0;
  const { nextAction, rootBlocker, remainingItems } = resolveTaskDetailSubtaskState(items);
  const allCompleted = items.length > 0 && completed === items.length;

  return (
    <section className="flex flex-col gap-4" aria-label={l10n("local.subtasks_7eff0a19")}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{l10n("local.progress_4664827f")}</span>
          <span className="font-mono">{completed} {l10n("local.of_28391d3b")}{" "}{items.length} {l10n("local.complete_eebbf645")}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={l10n("local.subtask_completion_7e7ba512")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded-full bg-(--status-task-icon-done) transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {rootBlocker ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-root-blocker-heading">
          <h3 id="task-root-blocker-heading" className="text-xs font-medium text-muted-foreground">
            {l10n("local.root_blocker_9c1c8ef5")}</h3>
          <RelationNavigationList
            items={[rootBlocker]}
            emptyMessage=""
            ariaLabel={l10n("local.root_blocker_9c1c8ef5")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : null}

      {nextAction ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-next-action-heading">
          <h3 id="task-next-action-heading" className="text-xs font-medium text-muted-foreground">
            {nextAction.status === "blocked" ? l10n("local.blocked_subtask_6e5a137d") : l10n("local.next_action_365987d0")}
          </h3>
          <TaskDetailTaskList
            items={[nextAction]}
            ariaLabel={l10n("local.next_subtask_action_2da7268b")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : items.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {allCompleted ? l10n("local.all_subtasks_are_complete_a49f51a5") : l10n("local.no_remaining_subtask_actions_e87f15bb")}
        </p>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{l10n("local.no_subtasks_yet_17d17d5b")}</p>
      )}

      {remainingItems.length > 0 ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="task-other-subtasks-heading">
          <h3 id="task-other-subtasks-heading" className="text-xs font-medium text-muted-foreground">
            {nextAction ? l10n("local.other_subtasks_087ef068") : l10n("local.subtasks_7eff0a19")}
          </h3>
          <TaskDetailTaskList
            items={remainingItems}
            ariaLabel={nextAction ? l10n("local.other_subtasks_087ef068") : l10n("local.subtasks_7eff0a19")}
            issueLinkState={issueLinkState}
          />
        </section>
      ) : null}

      {onAddSubtask ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onAddSubtask}>
          <Plus className="h-3.5 w-3.5" />
          {l10n("local.add_subtask_65db0c29")}</Button>
      ) : null}
    </section>
  );
}

export function TaskDetailReferencesPanel({
  referenced,
  mentionedIn,
  issueLinkState,
}: {
  referenced: TaskDetailRelationItem[];
  mentionedIn: TaskDetailRelationItem[];
  issueLinkState?: unknown;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-labelledby="task-referenced-heading">
        <h3 id="task-referenced-heading" className="text-xs font-medium text-muted-foreground">
          {l10n("local.referenced_e1ea8a5e")}</h3>
        <RelationNavigationList
          items={referenced}
          emptyMessage={l10n("local.this_task_does_not_reference_another_task_9547804c")}
          ariaLabel={l10n("local.referenced_tasks_2b2c775c")}
          issueLinkState={issueLinkState}
        />
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="task-mentioned-in-heading">
        <h3 id="task-mentioned-in-heading" className="text-xs font-medium text-muted-foreground">
          {l10n("local.mentioned_in_fb9d60f6")}</h3>
        <RelationNavigationList
          items={mentionedIn}
          emptyMessage={l10n("local.no_other_task_mentions_this_task_5ddc410b")}
          ariaLabel={l10n("local.tasks_that_mention_this_task_1780231a")}
          issueLinkState={issueLinkState}
        />
      </section>
    </div>
  );
}
