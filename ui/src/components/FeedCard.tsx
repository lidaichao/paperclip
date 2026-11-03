import { l10n } from "../i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import {
  FileText,
  UserPlus,
  Loader2,
  Package,
  User,
  Settings,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  PencilLine,
  PauseCircle,
  PlayCircle,
  MessageCircle,
  LogIn,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

/* ------------------------------------------------------------------ */
/*  Canonical verb table — one verb per action, used on every card.    */
/* ------------------------------------------------------------------ */

type VerbContext = "pinned" | "chronological";

function humanize(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  const localizedValues: Record<string, string> = {
    backlog: l10n("local.activity_value_backlog_5e40a987"),
    todo: l10n("local.activity_value_todo_fcbeb5e4"),
    in_progress: l10n("local.activity_value_in_progress_c52991ca"),
    in_review: l10n("local.activity_value_in_review_981b70be"),
    done: l10n("local.activity_value_done_bdb81916"),
    blocked: l10n("local.activity_value_blocked_03d788dc"),
    cancelled: l10n("local.activity_value_cancelled_651bcc39"),
    idle: l10n("local.activity_value_idle_1284334a"),
    low: l10n("local.activity_value_low_705b7d33"),
    medium: l10n("local.activity_value_medium_6a07020d"),
    high: l10n("local.activity_value_high_280cc574"),
    critical: l10n("local.activity_value_critical_9fa48cf0"),
  };
  return localizedValues[value] ?? value.replace(/_/g, " ");
}

/** One verb per action. Pinned context (Tier 0) swaps a couple of verbs to
 *  emphasize that user action is needed. */
function formatVerb(
  action: string,
  details: Record<string, unknown> | null | undefined,
  context: VerbContext = "chronological",
): string {
  switch (action) {
    case "issue.created":
      return l10n("local.activity_opened_6777801e");
    case "issue.updated": {
      const status = details?.status;
      if (status === "in_review" && details?.externalConversationState === "waiting") return l10n("local.activity_moved_to_idle_f206e7a6");
      if (typeof status === "string") return l10n("local.activity_moved_to_value_dbb053ec", { v0: humanize(status) });
      const priority = details?.priority;
      if (typeof priority === "string") return l10n("local.activity_set_priority_to_value_on_47060a53", { v0: humanize(priority) });
      return l10n("local.updated_27eb5e51");
    }
    case "issue.document_created":
      return l10n("local.activity_wrote_document_on_0e777623");
    case "issue.document_updated":
      return l10n("local.activity_edited_document_on_2d183074");
    case "issue.document_deleted":
      return l10n("local.activity_deleted_document_from_347825ec");
    case "issue.work_product_created":
      return l10n("local.activity_delivered_work_on_fd9e6b42");
    case "issue.work_product_updated":
      return l10n("local.activity_updated_work_on_311d014b");
    case "issue.work_product_deleted":
      return l10n("local.activity_removed_work_from_d7e97e8c");
    case "issue.checked_out":
      return l10n("local.activity_picked_up_f83fe835");
    case "issue.released":
      return l10n("local.released_d29eae13");
    case "issue.commented":
    case "issue.comment_added":
      return l10n("local.activity_commented_on_cabc1b9c");
    case "issue.attachment_added":
      return l10n("local.activity_attached_file_to_92f0c191");
    case "issue.attachment_removed":
      return l10n("local.activity_removed_attachment_from_56f11c60");
    case "issue.deleted":
      return l10n("local.deleted_1185f37d");

    case "approval.created":
      return context === "pinned"
        ? l10n("local.activity_needs_approval_on_8c559adc")
        : l10n("local.activity_requested_approval_on_dfeaf6d7");
    case "approval.approved":
      return l10n("local.approved_2687f86e");
    case "approval.rejected":
      return l10n("local.rejected_20cd938a");
    case "approval.revision_requested":
      return l10n("local.activity_requested_changes_on_b38dfba9");

    case "agent.created":
      return context === "pinned"
        ? l10n("local.activity_wants_to_hire_4777c942")
        : l10n("local.activity_hired_805b0135");
    case "agent.paused":
      return l10n("local.paused_a7a9dc5b");
    case "agent.resumed":
      return l10n("local.resumed_cf8ad4d9");
    case "agent.updated":
      return l10n("local.updated_27eb5e51");
    case "agent.terminated":
      return l10n("local.terminated_e8c95a2a");

    case "heartbeat.invoked":
      return l10n("local.activity_started_run_on_600047e2");
    case "heartbeat.cancelled":
      return l10n("local.activity_cancelled_run_on_45be003d");

    case "project.created":
      return l10n("local.activity_created_project_845e6099");
    case "project.updated":
      return l10n("local.activity_updated_project_a24d2541");
    case "project.deleted":
      return l10n("local.activity_deleted_project_220df8b9");
    case "goal.created":
      return l10n("local.activity_created_goal_563cdb80");
    case "goal.updated":
      return l10n("local.activity_updated_goal_cfa493bd");
    case "goal.deleted":
      return l10n("local.activity_deleted_goal_555a3d64");
    case "company.created":
      return l10n("local.activity_created_organization_863270c8");
    case "company.updated":
      return l10n("local.activity_updated_organization_9a11bd84");
    case "company.archived":
      return l10n("local.activity_archived_organization_ebf8bdd1");
    case "company.budget_updated":
      return l10n("local.activity_updated_organization_budget_7ccafcc6");

    default:
      return action.replace(/[._]/g, " ");
  }
}

/* ------------------------------------------------------------------ */
/*  Event-time task status (for issue events without a lifecycle wrap) */
/* ------------------------------------------------------------------ */

function deriveTaskStatus(
  action: string,
  details: Record<string, unknown> | null | undefined,
): string | null {
  switch (action) {
    case "issue.created":
      return "todo";
    case "issue.updated": {
      const status = details?.status;
      if (status === "in_review" && details?.externalConversationState === "waiting") return "idle";
      return typeof status === "string" ? status : null;
    }
    case "issue.document_created":
    case "issue.document_updated":
      return "in_progress";
    case "issue.work_product_created":
      return "in_review";
    case "approval.created":
      return "in_review";
    case "approval.approved":
      return "done";
    case "approval.rejected":
    case "approval.revision_requested":
      return "blocked";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Leading icon — carries entity type AND state via color/shape.      */
/* ------------------------------------------------------------------ */

type IconSpec =
  | { kind: "lucide"; Icon: LucideIcon; color: string; filled?: boolean; spin?: boolean }
  | { kind: "status-circle"; status: string };

function getIconSpec(
  event: ActivityEvent,
  details: Record<string, unknown> | null | undefined,
  isActive: boolean,
): IconSpec {
  const action = event.action;

  // Heartbeat — animated when active, static otherwise
  if (action.startsWith("heartbeat.")) {
    if (isActive && action === "heartbeat.invoked") {
      return { kind: "lucide", Icon: Loader2, color: "text-blue-600 dark:text-blue-400", spin: true };
    }
    return { kind: "lucide", Icon: Loader2, color: "text-muted-foreground" };
  }

  // Approval — distinct from task status icons (those still use StatusCircle).
  // Rendered unfilled so the stroke glyph (check / alert / slash) stays visible.
  switch (action) {
    case "approval.created":
      return { kind: "lucide", Icon: CircleAlert, color: "text-amber-600 dark:text-amber-400" };
    case "approval.approved":
      return { kind: "lucide", Icon: CircleCheck, color: "text-green-600 dark:text-green-400" };
    case "approval.rejected":
      return { kind: "lucide", Icon: CircleSlash, color: "text-red-600 dark:text-red-400" };
    case "approval.revision_requested":
      return { kind: "lucide", Icon: PencilLine, color: "text-amber-600 dark:text-amber-400", filled: true };
  }

  // Agent
  switch (action) {
    case "agent.created":
      return { kind: "lucide", Icon: UserPlus, color: "text-purple-600 dark:text-purple-400" };
    case "agent.paused":
      return { kind: "lucide", Icon: PauseCircle, color: "text-muted-foreground" };
    case "agent.resumed":
      return { kind: "lucide", Icon: PlayCircle, color: "text-muted-foreground" };
    case "agent.updated":
    case "agent.terminated":
      return { kind: "lucide", Icon: Settings, color: "text-muted-foreground" };
  }

  // Document on issue
  if (action === "issue.document_created" || action === "issue.document_updated") {
    return { kind: "lucide", Icon: FileText, color: "text-blue-600 dark:text-blue-400" };
  }

  // Work product / artifact on issue
  if (action.startsWith("issue.work_product_")) {
    return { kind: "lucide", Icon: Package, color: "text-indigo-600 dark:text-indigo-400" };
  }

  // Comments
  if (action === "issue.commented" || action === "issue.comment_added") {
    return { kind: "lucide", Icon: MessageCircle, color: "text-muted-foreground" };
  }

  // Issue check-out
  if (action === "issue.checked_out") {
    return { kind: "lucide", Icon: LogIn, color: "text-muted-foreground" };
  }

  // Generic issue lifecycle → StatusCircle with event-derived status
  if (event.entityType === "issue") {
    const status = deriveTaskStatus(action, details) ?? "backlog";
    return { kind: "status-circle", status };
  }

  if (event.entityType === "goal") {
    return { kind: "lucide", Icon: Target, color: "text-muted-foreground" };
  }

  return { kind: "lucide", Icon: Settings, color: "text-muted-foreground" };
}

function StatusCircle({ status }: { status: string }) {
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  const isFilled = status === "done";
  return (
    <span className={cn("relative inline-flex h-4 w-4 shrink-0 rounded-full border-2", colorClass)}>
      {isFilled && <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />}
    </span>
  );
}

function EntityIcon({ spec }: { spec: IconSpec }) {
  if (spec.kind === "status-circle") {
    return <StatusCircle status={spec.status} />;
  }
  const { Icon, color, filled, spin } = spec;
  return (
    <Icon
      className={cn("h-4 w-4 shrink-0", color, spin && "animate-spin")}
      fill={filled ? "currentColor" : "none"}
      strokeWidth={filled ? 1.5 : 2}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Content resolution — identifier (mono) + title                     */
/* ------------------------------------------------------------------ */

interface CardContent {
  actorName: string;
  actorType: ActivityEvent["actorType"];
  actor: Agent | null;
  identifier: string | null;
  /** When true, render identifier in JetBrains Mono. Reserved for task
   *  slugs (e.g. FOA-2) and agent names. */
  identifierMono: boolean;
  title: string | null;
  link: string | null;
}

function resolveContent(
  event: ActivityEvent,
  agentMap: Map<string, Agent>,
  entityNameMap: Map<string, string>,
  entityTitleMap: Map<string, string> | undefined,
): CardContent {
  const details = event.details as Record<string, unknown> | null;
  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) ?? null : null;
  const actorName =
    actor?.name ??
    (event.actorType === "system"
      ? l10n("local.system_6725e7bb")
      : event.actorType === "user"
        ? l10n("local.board_4816cbfd")
        : event.actorId || l10n("local.unknown_b764cdc0"));

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`) ?? null;

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (details?.agentId as string | undefined)
    : undefined;
  const entityName = isHeartbeatEvent
    ? heartbeatAgentId
      ? entityNameMap.get(`agent:${heartbeatAgentId}`) ?? null
      : null
    : entityNameMap.get(`${event.entityType}:${event.entityId}`) ?? null;

  const docKey = details?.key as string | undefined;
  const isDocEvent =
    event.action === "issue.document_created" || event.action === "issue.document_updated";
  const issueSlug = entityName ?? event.entityId;
  const hiredAgentId = details?.hiredAgentId as string | undefined;
  const approvalAgentId = details?.requestedByAgentId as string | undefined;
  const approvalAgentName = approvalAgentId ? agentMap.get(approvalAgentId)?.name ?? null : null;
  const approvalType = details?.type as string | undefined;

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : event.entityType === "issue"
      ? isDocEvent && docKey
        ? `/issues/${issueSlug}#document-${encodeURIComponent(docKey)}`
        : `/issues/${issueSlug}`
      : event.entityType === "agent"
        ? `/agents/${event.entityId}`
        : event.entityType === "approval"
          ? event.action === "approval.approved" && hiredAgentId
            ? `/agents/${hiredAgentId}`
            : `/approvals/${event.entityId}`
          : event.entityType === "project"
            ? `/projects/${deriveProjectUrlKey(entityName, event.entityId)}`
            : event.entityType === "goal"
              ? `/goals/${event.entityId}`
              : null;

  let identifier: string | null = null;
  let identifierMono = true;
  let title: string | null = null;

  if (event.entityType === "issue") {
    // Docs (e.g. FOA-2#hiring-plan) previously showed the doc key, but it
    // duplicates the human-readable title that follows. Show just the task
    // slug; the title carries the document name.
    identifier = entityName;
    title = entityTitle;
  } else if (event.entityType === "approval") {
    if (approvalAgentName) {
      identifier = approvalAgentName;
    } else {
      identifier = approvalType ? humanize(approvalType) : l10n("local.activity_approval_ebf13952");
      identifierMono = false;
    }
    title = entityTitle;
  } else if (event.entityType === "agent") {
    identifier = (details?.name as string | undefined) ?? entityName ?? event.entityId;
    title = null;
  } else if (isHeartbeatEvent) {
    identifier = entityName;
    title = null;
  } else {
    identifier = entityName;
    title = entityTitle;
  }

  return {
    actorName,
    actorType: event.actorType,
    actor,
    identifier,
    identifierMono,
    title,
    link,
  };
}

function ActorGlyph({ content }: { content: CardContent }) {
  if (content.actorType === "agent") {
    return (
      <AgentAvatar agent={content.actor} size={16}
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
    );
  }
  if (content.actorType === "user") {
    return <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface FeedCardProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  /** Retained for call-site compatibility; no longer read — the collapsed
   *  card always shows the event-derived status. Lifecycle aggregation (a
   *  later pass) will pass the live status through its own wrapper. */
  entityStatusMap?: Map<string, string>;
  isActive?: boolean;
  /** Tier 2 treatment: mutes the verb and title text. Actor name and
   *  timestamp retain their color; leading icon retains its color. */
  isMuted?: boolean;
  /** Tier 0 treatment: adds a trailing "Review →" affordance and swaps in
   *  pinned-context verb phrasing ("needs approval on", "wants to hire"). */
  isPinned?: boolean;
  className?: string;
}

export function FeedCard({
  event,
  agentMap,
  entityNameMap,
  entityTitleMap,
  isActive = false,
  isMuted = false,
  isPinned = false,
  className,
}: FeedCardProps) {
  const details = event.details as Record<string, unknown> | null;
  const content = resolveContent(event, agentMap, entityNameMap, entityTitleMap);
  const verb = formatVerb(event.action, details, isPinned ? "pinned" : "chronological");
  const iconSpec = getIconSpec(event, details, isActive);

  const mutedTextBase = isMuted ? "text-muted-foreground/70" : "text-(--hex-959596)";
  const mutedTextHover = isMuted ? "" : "group-hover:text-white";

  const card = (
    <Card
      data-fc="card"
      className={cn(
        "flex-row group ml-3 mr-3 md:ml-0 my-2 w-(--sz-calc-1) md:w-(--sz-calc-2) items-center gap-2 p-(--sz-18px) text-xs",
        "transition-(--tp-background-color-border-color) duration-150",
        content.link && "cursor-pointer hover:bg-accent hover:border-muted-foreground/30",
        className,
      )}
    >
      <EntityIcon spec={iconSpec} />
      <ActorGlyph content={content} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate">
        <span data-fc="actor" className={cn("font-medium", mutedTextBase, mutedTextHover)}>
          {content.actorName}
        </span>
        <span data-fc="verb" className={mutedTextBase}>{verb}</span>
        {content.identifier && (
          <span
            data-fc="id"
            className={cn(content.identifierMono && "font-mono", mutedTextBase, mutedTextHover)}
          >
            {content.identifier}
          </span>
        )}
        {content.title && (
          <span
            data-fc="title"
            className={cn("truncate", mutedTextBase, mutedTextHover)}
          >
            {content.title}
          </span>
        )}
      </span>
      {isPinned && (
        <span className="shrink-0 text-xs text-muted-foreground">{l10n("local.review_ab7681ea")}</span>
      )}
      <span data-fc="time" className="shrink-0 text-muted-foreground">
        {timeAgo(event.createdAt)}
      </span>
    </Card>
  );

  if (content.link) {
    return (
      <Link
        to={content.link}
        data-fc="link"
        className="block w-full no-underline text-inherit"
        issueQuicklookSide="left"
      >
        {card}
      </Link>
    );
  }
  return card;
}
