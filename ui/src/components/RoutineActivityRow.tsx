import { l10n } from "../i18n";
import { enumLabel } from "../i18n/display";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

export type RoutineActivityEvent = Pick<ActivityEvent, "id" | "action" | "details" | "createdAt">;

function formatTime(value: string | Date): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(value);
  }
}

export function routineActivitySummary(event: RoutineActivityEvent): string {
  const details = event.details;
  if (event.action === "routine.webhook_test_received") {
    return l10n("local.connection_working_no_run_created_10300201");
  }
  if (event.action === "routine.webhook_test_rejected") {
    return l10n("local.update_key_and_resend_10300202");
  }
  if (event.action === "routine.webhook_received") {
    return l10n("local.authentication_passed_10300203");
  }
  if (event.action === "routine.webhook_rejected") {
    return l10n("local.check_sending_app_key_10300204");
  }
  if (!details) return "";
  if (typeof details.changeSummary === "string") return details.changeSummary;
  if (event.action === "routine.run_triggered") {
    const source = details.source === "webhook"
      ? l10n("local.webhook_4814f62c")
      : details.source === "schedule"
        ? l10n("local.schedule_f4830a1d")
        : l10n("local.manual_source_0d200003");
    const status = details.status === "issue_created"
      ? l10n("local.task_created_a3e3e968")
      : enumLabel(String(details.status ?? ""), "lower");
    return `${source} · ${status}`;
  }
  return Object.entries(details).filter(([key]) => !/id$/i.test(key)).slice(0, 3)
    .map(([key, value]) => `${enumLabel(key.replace(/([a-z])([A-Z])/g, "$1_$2"), "lower")}: ${formatDetailValue(value)}`)
    .join(" · ");
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(formatDetailValue).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return l10n("local.unserializable_value_10301617");
  }
}

const actionLabels: Record<string, string> = {
  "routine.webhook_test_received": l10n("local.connection_test_passed_97f70ab0"),
  "routine.webhook_test_rejected": l10n("local.connection_test_rejected_e726428f"),
  "routine.webhook_received": l10n("local.webhook_event_received_acc54100"),
  "routine.webhook_rejected": l10n("local.webhook_authentication_failed_912bfefc"),
  "routine.created": l10n("local.routine_created_73aa7818"), "routine.updated": l10n("local.routine_updated_72f4c9a3"),
  "routine.trigger_created": l10n("local.trigger_added_bdfe6f71"), "routine.trigger_updated": l10n("local.trigger_updated_73c266d5"),
  "routine.trigger_deleted": l10n("local.trigger_removed_7d0dec12"), "routine.trigger_removed": l10n("local.trigger_removed_7d0dec12"), "routine.trigger_restored": l10n("local.trigger_restored_ebac38f2"), "routine.trigger_setup_finished": l10n("local.webhook_setup_finished_64a3b5cd"), "routine.trigger_secret_rotated": l10n("local.webhook_key_replaced_404458cb"),
  "routine.run_triggered": l10n("local.routine_started_768fcb18"), "routine.run_created": l10n("local.run_created_4c211da8"),
  "routine.run.completed": l10n("local.routine_activity_run_completed_10301605"),
  "routine.run_skipped": l10n("local.routine_activity_run_skipped_10301606"),
  "routine.revision_created": l10n("local.routine_activity_revision_created_10301607"),
  "routine.revision_restored": l10n("local.routine_activity_revision_restored_10301608"),
  "routine.origin_stamped": l10n("local.routine_activity_origin_stamped_10301609"),
  "routine.origin_cleared": l10n("local.routine_activity_origin_cleared_10301610"),
  "routine.webhook_ignored": l10n("local.routine_activity_webhook_ignored_10301611"),
  "routine.document_annotation_thread_created": l10n("local.routine_activity_annotation_thread_created_10301612"),
  "routine.document_annotation_comment_added": l10n("local.routine_activity_annotation_comment_added_10301613"),
  "routine.document_annotation_thread_resolved": l10n("local.routine_activity_annotation_thread_resolved_10301614"),
  "routine.document_annotation_thread_reopened": l10n("local.routine_activity_annotation_thread_reopened_10301615"),
  "routine.document_annotation_remapped": l10n("local.routine_activity_annotation_remapped_10301616"),
};
export function routineActivityActionLabel(action: string) {
  return actionLabels[action] ?? enumLabel(action.replace(/^routine[._]/, "").replaceAll(".", "_"), "sentence");
}

/** Activity log row with an expandable JSON payload (§3.7). */
export function RoutineActivityRow({ event }: { event: RoutineActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.details != null && Object.keys(event.details).length > 0;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        disabled={!hasPayload}
        aria-expanded={hasPayload ? expanded : undefined}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex min-w-0 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs whitespace-nowrap",
          hasPayload ? "hover:bg-accent/30" : "cursor-default",
        )}
      >
        <span className="w-16 shrink-0 whitespace-nowrap font-mono tabular-nums text-muted-foreground">
          {formatTime(event.createdAt)}
        </span>
        <span title={event.action} className="min-w-0 max-w-1/2 shrink-0 truncate font-medium text-foreground">
          {routineActivityActionLabel(event.action)}
        </span>
        <span title={routineActivitySummary(event)} className="min-w-0 flex-1 truncate text-muted-foreground">
          {routineActivitySummary(event)}
        </span>
        {hasPayload ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {expanded && hasPayload ? (
        <pre className="mx-2 mb-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
