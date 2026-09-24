import { l10n, englishPluralSuffix } from "../i18n";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent } from "@paperclipai/shared";
import { AlertTriangle, ArrowUpRight, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock, ExternalLink, FileText, GitBranch, ImagePlus, KeyRound, Loader2, MessageSquareQuote, MinusCircle, ShieldAlert, ThumbsUp, TriangleAlert, Wrench, X, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { describeInteractionAudience, type InteractionAudienceDescription } from "../lib/interaction-audience";
import { interactionResolutionErrorMessage } from "../lib/interaction-resolution-error";
import {
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getCheckboxConfirmationSelectedLabels,
  getItemVerdictProgress,
  getQuestionAnswerLabels,
  shouldHideInteractionCard,
  normalizeRequestConfirmationTargetHref,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestConfirmationTarget,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictsItem,
  type RequestItemVerdictsResultItem,
  type RequestItemVerdictValue,
  type SuggestTasksInteraction,
  type SuggestTasksResultCreatedTask,
  type SuggestedTaskDraft,
  type SuggestedTaskTreeNode,
} from "../lib/issue-thread-interactions";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { InteractionAudienceLine } from "./InteractionAudienceLine";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { PriorityIcon } from "./PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ProposalJustification } from "../pages/secrets/proposal-review";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";

const OTHER_ANSWER_ID = "__paperclip_other__";

/**
 * The card's server-evaluated audience, shared with the per-kind subcards below
 * (PAP-17287). A subcard that catches a rejected resolution needs to name who
 * *can* respond, and re-deriving the audience per subcard would let two parts of
 * the same card describe one policy differently.
 */
const InteractionAudienceContext = createContext<InteractionAudienceDescription | null>(null);

/**
 * Turns a rejected resolution into copy for the inline error region: the
 * server's own denial reason, plus who can respond when the denial is an
 * audience refusal. Never invites a retry that policy will refuse again.
 */
function useResolutionErrorMessage() {
  const audience = useContext(InteractionAudienceContext);
  return (error: unknown) => interactionResolutionErrorMessage(error, audience);
}

/**
 * The inline resolution error. Announced through an `aria-live` region because a
 * denial is the only feedback a failed decision gets — the row stays put and no
 * toast fires on the attention surface.
 *
 * The live region is the *outer* wrapper, mounted whether or not there is a
 * message: a region has to be in the accessibility tree before its content
 * changes for the change to be announced. The styled inner div deliberately
 * carries no `role="alert"` — `alert` is itself an assertive live region, and
 * nesting one inside another makes some screen reader / browser pairs announce
 * the same denial twice (PAP-17289).
 */
function InteractionActionError({ message }: { message: string | null }) {
  return (
    <div aria-live="assertive" data-testid="interaction-action-error">
      {message ? (
        <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message}
        </div>
      ) : null}
    </div>
  );
}

interface IssueThreadInteractionCardProps {
  interaction: IssueThreadInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  /** Render confirmation CTAs with the primary action rightmost (task-chat grammar). */
  primaryActionOnRight?: boolean;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: { id: string; verdict: RequestItemVerdictValue; reason?: string }[],
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
}

function resolveActorLabel(args: {
  agentId?: string | null;
  userId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { agentId, userId, agentMap, currentUserId, userLabelMap } = args;
  if (agentId) {
    return agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
  }
  if (userId) {
    return formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ?? "Board";
  }
  return l10n("local.unknown_b764cdc0");
}

/**
 * Administrative terminal outcomes (P1): an interaction that was withdrawn by
 * its board/agent, or auto-expired when its issue reached a terminal state.
 * Both are stored as `status="cancelled"|"expired"` with the distinguishing
 * fact carried on `result.outcome` (there is no dedicated `withdrawn` status).
 */
function getAdministrativeOutcome(
  interaction: IssueThreadInteraction,
): "withdrawn" | "issue_closed" | null {
  const result = interaction.result;
  if (result && typeof result === "object" && "outcome" in result) {
    const outcome = (result as { outcome?: string | null }).outcome;
    if (outcome === "withdrawn" || outcome === "issue_closed") return outcome;
  }
  return null;
}

function getAdministrativeReason(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result;
  if (result && typeof result === "object" && "reason" in result) {
    const reason = (result as { reason?: string | null }).reason;
    if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  }
  return null;
}

function statusLabel(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "pending":
      return l10n("local.pending_331551b0");
    case "accepted":
      return l10n("local.accepted_a00fb0c5");
    case "rejected":
      return l10n("local.rejected_aea4a04a");
    case "answered":
      return l10n("local.answered_66559035");
    case "cancelled":
      return l10n("local.cancelled_d353a99e");
    case "expired":
      return l10n("local.expired_424a2551");
    case "failed":
      return l10n("local.failed_031a8f0f");
    default:
      return status;
  }
}

function interactionKindLabel(kind: IssueThreadInteraction["kind"]) {
  switch (kind) {
    case "suggest_tasks":
      return l10n("local.suggested_tasks_5addd6ff");
    case "ask_user_questions":
      return l10n("local.ask_user_questions_85f98263");
    case "request_confirmation":
      return l10n("local.confirmation_d7430705");
    case "request_checkbox_confirmation":
      return l10n("local.checkbox_confirmation_e977187a");
    case "request_item_verdicts":
      return l10n("local.item_verdicts_7023d105");
    case "connection_intent":
      return l10n("local.connection_request_cd97ea1c");
    default:
      return kind;
  }
}

function statusIcon(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return CheckCircle2;
    case "rejected":
    case "cancelled":
    case "failed":
      return XCircle;
    case "expired":
      return AlertTriangle;
    default:
      return CircleDashed;
  }
}

function statusClasses(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return {
        shell: "border-emerald-400/70 bg-transparent",
        badge: "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100",
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-rose-400/70 bg-transparent",
        badge: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
      };
    case "failed":
    case "expired":
      return {
        shell: "border-amber-400/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
      };
    default:
      return {
        shell: "border-sky-500/70 bg-transparent",
        badge: "border-sky-500/70 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
      };
  }
}

/**
 * A confirmation that targets the issue's `plan` document renders as a distinct
 * plan card (PAP-95g): a full state-coloured outline — violet while in review,
 * green once approved, red when changes are requested (PAP-75 palette) — with no
 * left stripe, so plans stand out from comments and status rows.
 */
function isPlanConfirmation(interaction: IssueThreadInteraction): boolean {
  if (interaction.kind !== "request_confirmation") return false;
  const target = interaction.payload.target;
  return target?.type === "issue_document" && target?.key === "plan";
}

function requestConfirmationResumeFailure(interaction: IssueThreadInteraction) {
  if (interaction.kind !== "request_confirmation" && interaction.kind !== "request_checkbox_confirmation") return null;
  return interaction.result?.resumeFailure ?? null;
}

function planStatusClasses(
  status: IssueThreadInteraction["status"],
  resumeFailure?: ReturnType<typeof requestConfirmationResumeFailure>,
  outcome?: string | null,
) {
  switch (status) {
    case "accepted":
    case "answered":
      if (resumeFailure) {
        return {
          shell: "border-2 border-amber-500/70 bg-transparent",
          badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
          label: l10n("local.approved_agent_resume_failed_03dbaee7"),
          Icon: AlertTriangle,
        };
      }
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: l10n("local.approved_87b42e40"),
        Icon: CheckCircle2,
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: outcome === "withdrawn" ? l10n("local.withdrawn_00c0b03f") : l10n("local.changes_requested_10a92a8a"),
        Icon: XCircle,
      };
    case "failed":
    case "expired":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: l10n("local.expired_424a2551"),
        Icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        label: l10n("local.in_review_c3905914"),
        Icon: FileText,
      };
  }
}

/**
 * A `request_confirmation` that carries a `payload.toolAction` block gates a
 * write/destructive MCP tool call (PAP-13726 §D1). It renders as a dedicated
 * tool-approval card (PAP-13745) instead of the generic confirmation rendering.
 * The governing rule: approve = run, so the card never terminally reads
 * "Accepted" — terminal states are Executed / Failed / Declined / Expired.
 */
function toolActionPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["toolAction"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.toolAction ?? null;
}

function isToolActionConfirmation(interaction: IssueThreadInteraction): boolean {
  return toolActionPayload(interaction) != null;
}

function secretProposalPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["secretProposal"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.secretProposal ?? null;
}

function isSecretProposalConfirmation(interaction: IssueThreadInteraction): boolean {
  return secretProposalPayload(interaction) != null;
}

/**
 * A `request_confirmation` carrying `payload.connectionAuthorization` is asking
 * one person to connect their own account so an agent can act as them
 * (PAP-17835). It keeps the interaction kind and the server-addressed audience;
 * only the presentation differs, and it reads that presentation from the payload
 * rather than parsing the title string.
 */
function connectionAuthorizationPayload(
  interaction: IssueThreadInteraction,
): NonNullable<RequestConfirmationInteraction["payload"]["connectionAuthorization"]> | null {
  if (interaction.kind !== "request_confirmation") return null;
  return interaction.payload.connectionAuthorization ?? null;
}

/**
 * The five states the connection-authorization card can be read in (PAP-17859).
 *
 * `actionable` and `waiting` are the *same* pending row seen by two different
 * readers: consent belongs to the addressed person alone, so who is looking
 * changes what may be offered — not merely whether a button is greyed out.
 */
type ConnectionAuthorizationCardState =
  | "actionable"
  | "waiting"
  | "connected"
  | "declined"
  | "expired";

function connectionAuthorizationCardState({
  interaction,
  isAddressee,
}: {
  interaction: RequestConfirmationInteraction;
  isAddressee: boolean;
}): ConnectionAuthorizationCardState {
  if (interaction.status === "accepted") return "connected";
  if (interaction.status === "rejected") return "declined";
  if (interaction.status === "pending") return isAddressee ? "actionable" : "waiting";
  // expired / cancelled / failed all mean the same thing to a reader here: the
  // authorization run this card carried is over.
  return "expired";
}

/**
 * True only when the signed-in reader *is* the person the server addressed.
 *
 * Deliberately strict: an unknown viewer (`currentUserId` not loaded yet) is
 * never treated as the addressee, so the Connect action cannot flash into view
 * for someone who may not consent. The server re-authorizes the callback
 * regardless; this only decides what the card offers.
 */
function isConnectionAuthorizationAddressee({
  interaction,
  currentUserId,
}: {
  interaction: RequestConfirmationInteraction;
  currentUserId?: string | null;
}): boolean {
  const addressee = interaction.addresseeUserId;
  if (!addressee || !currentUserId) return false;
  return addressee === currentUserId;
}

/**
 * The authorization URL this card may open, or `null`.
 *
 * A target is offered **only while the interaction is pending**. The server
 * re-upserts this row with a freshly minted `state` every time it starts a new
 * authorization run, so a pending card always carries a live target and a
 * resolved/declined/expired one always carries a spent one. Gating on the
 * status is therefore how "never reuse an expired OAuth URL" is enforced —
 * there is no client-visible expiry on the payload to check instead.
 */
function connectionAuthorizationHref(interaction: RequestConfirmationInteraction): string | null {
  if (interaction.status !== "pending") return null;
  const href = interaction.payload.target?.href;
  if (!href) return null;
  return normalizeRequestConfirmationTargetHref(href);
}

type ToolActionCardState =
  | "pending"
  | "running"
  | "executed"
  | "failed"
  | "cancelled"
  | "declined"
  | "expired";

/**
 * Derives the visible lifecycle state from the interaction status plus the
 * `result.toolAction.status` written back by the gateway. The card must render
 * the resolved state without polling — the lifecycle metadata is authoritative,
 * so an optimistic "running…" reconciles to the server's terminal state.
 */
function toolActionCardState(
  interaction: RequestConfirmationInteraction,
): ToolActionCardState {
  const execStatus = interaction.result?.toolAction?.status ?? null;
  if (interaction.status === "pending") return "pending";
  if (interaction.status === "rejected") return "declined";
  if (interaction.status === "cancelled") return "cancelled";
  if (interaction.status === "expired") return "expired";
  // Terminal execution outcomes take precedence over the coarse interaction
  // status so a self-resolving "running…" advances to its real result.
  if (execStatus === "executed") return "executed";
  if (execStatus === "failed") return "failed";
  if (execStatus === "expired") return "expired";
  if (interaction.status === "failed") return "failed";
  // accepted + approved/executing/unknown → the transient running state.
  return "running";
}

function toolActionStatusClasses(state: ToolActionCardState): {
  shell: string;
  badge: string;
  label: string;
  Icon: typeof CheckCircle2;
  spin?: boolean;
  dimmed?: boolean;
} {
  switch (state) {
    case "running":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: l10n("local.running_46c54136"),
        Icon: Loader2,
        spin: true,
      };
    case "executed":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: l10n("local.executed_3aa8b683"),
        Icon: CheckCircle2,
      };
    case "failed":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: l10n("local.failed_031a8f0f"),
        Icon: XCircle,
      };
    case "declined":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: l10n("local.declined_dce083a2"),
        Icon: XCircle,
        dimmed: true,
      };
    case "cancelled":
      return { shell: "border-2 border-border bg-transparent", badge: "border-border bg-muted text-muted-foreground", label: l10n("local.cancelled_d353a99e"), Icon: XCircle, dimmed: true };
    case "expired":
      return {
        shell: "border-2 border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: l10n("local.expired_424a2551"),
        Icon: Clock,
        dimmed: true,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        label: l10n("local.awaiting_approval_ae25c9b1"),
        Icon: ShieldAlert,
      };
  }
}

function TaskField({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "subtle";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow)",
        tone === "default"
          ? "border-border/70 bg-transparent text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground",
      )}
    >
      {label}: {value}
    </span>
  );
}

function createdTaskMap(
  createdTasks: readonly SuggestTasksResultCreatedTask[] | undefined,
) {
  return new Map(
    (createdTasks ?? []).map((entry) => [entry.clientKey, entry] as const),
  );
}

function TaskTreeNode({
  node,
  createdByClientKey,
  agentMap,
  currentUserId,
  userLabelMap,
  depth = 0,
  selectedClientKeys,
  skippedClientKeys,
  showSelection,
  onToggleSelection,
}: {
  node: SuggestedTaskTreeNode;
  createdByClientKey: ReadonlyMap<string, SuggestTasksResultCreatedTask>;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  depth?: number;
  selectedClientKeys?: ReadonlySet<string>;
  skippedClientKeys?: ReadonlySet<string>;
  showSelection?: boolean;
  onToggleSelection?: (node: SuggestedTaskTreeNode, checked: boolean) => void;
}) {
  const visibleChildren = node.children.filter((child) => !child.task.hiddenInPreview);
  const hiddenChildCount = node.children
    .filter((child) => child.task.hiddenInPreview)
    .reduce((sum, child) => sum + countSuggestedTaskNodes(child), 0);
  const createdTask = createdByClientKey.get(node.task.clientKey);
  const isSelected = selectedClientKeys?.has(node.task.clientKey) ?? false;
  const isSkipped = skippedClientKeys?.has(node.task.clientKey) ?? false;
  const assigneeLabel = resolveActorLabel({
    agentId: node.task.assigneeAgentId,
    userId: node.task.assigneeUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const hasExplicitAssignee = Boolean(
    node.task.assigneeAgentId || node.task.assigneeUserId,
  );
  const labels = node.task.labels ?? [];
  const hasMetadata = hasExplicitAssignee
    || Boolean(node.task.billingCode)
    || Boolean(node.task.projectId)
    || labels.length > 0;

  return (
    <>
      <div
        className={cn(
          "relative border-b border-border/60 px-3 py-2.5 last:border-b-0",
          depth > 0 && "before:absolute before:left-3 before:top-0 before:h-full before:w-px before:bg-border/70",
        )}
        style={depth > 0 ? { paddingLeft: `${depth * 24 + 12}px` } : undefined}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              {showSelection ? (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(checked) => onToggleSelection?.(node, checked === true)}
                  aria-label={l10n("local.include_value_8890b6d6", {v0: (node.task.title)})}
                  className="mt-0.5"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
                  {SHOW_TASK_PRIORITY_UI && node.task.priority ? (
                    <PriorityIcon
                      priority={node.task.priority}
                      className="mt-px"
                    />
                  ) : null}
                  <div className="min-w-0 truncate text-sm font-medium text-foreground">
                    {node.task.title}
                  </div>
                </div>
                {depth > 0 ? (
                  <div className="mt-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {l10n("local.child_task_4e6d7bdb")}</div>
                ) : null}
                {node.task.description ? (
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                    {node.task.description}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {createdTask?.issueId ? (
            <Link
              to={`/issues/${createdTask.identifier ?? createdTask.issueId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-(length:--text-micro) font-medium text-emerald-900 transition-colors hover:bg-emerald-500/15 dark:text-emerald-100"
            >
              {createdTask.identifier ?? createdTask.issueId.slice(0, 8)}
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : isSkipped ? (
            <span className="inline-flex shrink-0 items-center rounded-sm border border-amber-500/60 bg-amber-500/10 px-2.5 py-1 text-(length:--text-micro) font-medium text-amber-900 dark:text-amber-100">
              {l10n("local.skipped_12698ce1")}</span>
          ) : null}
        </div>

        {hasMetadata ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasExplicitAssignee ? (
              <TaskField label={l10n("local.responsible_bc110a6d")} value={assigneeLabel} />
            ) : null}
            {node.task.billingCode ? (
              <TaskField label={l10n("local.billing_3ac8bbca")} value={node.task.billingCode} />
            ) : null}
            {node.task.projectId ? (
              <TaskField label={l10n("local.project_98595978")} value={node.task.projectId} tone="subtle" />
            ) : null}
            {labels.map((label) => (
              <TaskField key={label} label={l10n("local.label_0e66373f")} value={label} tone="subtle" />
            ))}
          </div>
        ) : null}

        {hiddenChildCount > 0 ? (
          <div className="mt-2 flex items-center gap-2 rounded-sm border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>
              {hiddenChildCount === 1
                ? l10n("local.1_follow_on_task_hidden_in_preview_20e5cdeb")
                : l10n("local.value_follow_on_tasks_hidden_in_preview_6f1282d8", {v0: (hiddenChildCount)})}
            </span>
          </div>
        ) : null}
      </div>

      {visibleChildren.length > 0 ? (
        <>
          {visibleChildren.map((child) => (
            <TaskTreeNode
              key={child.task.clientKey}
              node={child}
              createdByClientKey={createdByClientKey}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              depth={depth + 1}
              selectedClientKeys={selectedClientKeys}
              skippedClientKeys={skippedClientKeys}
              showSelection={showSelection}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function SuggestTasksCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: SuggestTasksInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(
    interaction.result?.rejectionReason ?? "",
  );

  useEffect(() => {
    setRejectReason(interaction.result?.rejectionReason ?? "");
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.result?.rejectionReason, interaction.status]);

  const roots = useMemo(
    () =>
      buildSuggestedTaskTree(interaction.payload.tasks).filter(
        (node) => !node.task.hiddenInPreview,
      ),
    [interaction.payload.tasks],
  );
  const createdByClientKey = useMemo(
    () => createdTaskMap(interaction.result?.createdTasks),
    [interaction.result?.createdTasks],
  );
  const skippedClientKeys = useMemo(
    () => new Set(interaction.result?.skippedClientKeys ?? []),
    [interaction.result?.skippedClientKeys],
  );
  const totalTasks = interaction.payload.tasks.length;
  const [selectedClientKeys, setSelectedClientKeys] = useState<Set<string>>(
    () => new Set(interaction.payload.tasks.map((task) => task.clientKey)),
  );
  const taskSelectionSeed = useMemo(
    () => interaction.payload.tasks.map((task) => task.clientKey).join("\n"),
    [interaction.payload.tasks],
  );

  useEffect(() => {
    setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)));
  }, [interaction.id, interaction.status, taskSelectionSeed]);

  const taskByClientKey = useMemo(
    () => new Map(interaction.payload.tasks.map((task) => [task.clientKey, task] as const)),
    [interaction.payload.tasks],
  );
  const selectedCount = selectedClientKeys.size;
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const createdCount = interaction.result?.createdTasks?.length ?? 0;
  const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction, [...selectedClientKeys]);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, rejectReason.trim() || undefined);
      setRejecting(false);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  function handleToggleSelection(node: SuggestedTaskTreeNode, checked: boolean) {
    const subtreeClientKeys = collectSuggestedTaskClientKeys(node);
    setSelectedClientKeys((current) => {
      const next = new Set(current);
      if (!checked) {
        for (const clientKey of subtreeClientKeys) {
          next.delete(clientKey);
        }
        return next;
      }

      for (const clientKey of subtreeClientKeys) {
        next.add(clientKey);
      }

      let parentClientKey = taskByClientKey.get(node.task.clientKey)?.parentClientKey ?? null;
      while (parentClientKey) {
        next.add(parentClientKey);
        parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{totalTasks === 1 ? l10n("local.1_draft_issue_142b5c43") : l10n("local.value_draft_issues_c27e5374", {v0: (totalTasks)})}</span>
        {interaction.payload.defaultParentId ? (
          <TaskField label={l10n("local.default_parent_ac981ebf")} value={interaction.payload.defaultParentId} tone="subtle" />
        ) : null}
      </div>

      <div className="overflow-hidden border border-border/70">
        {roots.map((root) => (
          <TaskTreeNode
            key={root.task.clientKey}
            node={root}
            createdByClientKey={createdByClientKey}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            selectedClientKeys={selectedClientKeys}
            skippedClientKeys={skippedClientKeys}
            showSelection={interaction.status === "pending"}
            onToggleSelection={handleToggleSelection}
          />
        ))}
      </div>

      {interaction.status === "accepted" ? (
        <div className="rounded-sm border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-emerald-700">
            {l10n("local.resolution_summary_5ac338f0")}</div>
          <p className="mt-1 leading-6">
            {skippedCount > 0
              ? l10n("local.created_value_draft_value_and_skipped_value_d_2c668cad", {v0: (createdCount), v1: (createdCount === 1 ? "issue" : "issues"), v2: (skippedCount)})
              : l10n("local.created_all_value_draft_value_1a9911a9", {v0: (createdCount), v1: (createdCount === 1 ? "issue" : "issues")})}
          </p>
        </div>
      ) : null}

      {interaction.status === "rejected" ? (
        <div className="rounded-sm border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-rose-700">
            {l10n("local.rejection_reason_e5749926")}</div>
          <p className={cn(
            "mt-1 leading-6",
            !interaction.result?.rejectionReason && "text-rose-900/75",
          )}>
            {interaction.result?.rejectionReason || l10n("local.no_reason_provided_a63c933a")}
          </p>
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selectedCount === totalTasks
                  ? l10n("local.all_value_draft_value_selected_37bc6d6a", {v0: (totalTasks), v1: (totalTasks === 1 ? "issue" : "issues")})
                  : l10n("local.value_of_value_draft_value_selected_c2e32bf9", {v0: (selectedCount), v1: (totalTasks), v2: (totalTasks === 1 ? "issue" : "issues")})}
              </span>
              {selectedCount < totalTasks ? (
                <span>
                  {totalTasks - selectedCount} {l10n("local.will_be_skipped_if_you_accept_this_interactio_7088fd3a")}</span>
              ) : null}
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                disabled={!onAcceptInteraction || working !== null || selectedCount === 0}
                onClick={() => void handleAccept()}
              >
                {working === "accept" ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {l10n("local.accepting_31409c77")}</>
                ) : (
                  selectedCount === totalTasks ? l10n("local.accept_drafts_43a26ceb") : l10n("local.accept_selected_drafts_3db4cde1")
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => setRejecting((current) => !current)}
              >
                {l10n("local.reject_ab604a36")}</Button>
              {selectedCount < totalTasks ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)))}
                >
                  {l10n("local.reset_selection_2e924686")}</Button>
              ) : null}
            </div>
          </div>

          {rejecting ? (
            <div className="space-y-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder={l10n("local.add_a_short_reason_for_rejecting_this_suggest_11886cf2")}
                className="min-h-24 bg-background text-sm"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onRejectInteraction || working !== null}
                  onClick={() => void handleReject()}
                >
                  {working === "reject" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {l10n("local.saving_dc85af8f")}</>
                  ) : (
                    l10n("local.save_rejection_6fc943c1")
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          <InteractionActionError message={actionError} />
        </div>
      ) : null}
    </div>
  );
}

function QuestionOptionButton({
  id,
  label,
  description,
  selected,
  selectionMode,
  onClick,
}: {
  id: string;
  label: string;
  description?: string | null;
  selected: boolean;
  selectionMode: "single" | "multi";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={selectionMode === "single" ? "radio" : "checkbox"}
      aria-checked={selected}
      className={cn(
        "w-full rounded-sm border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
        selected
          ? "border-sky-500/80 bg-sky-500/10 text-sky-950 dark:border-sky-400/80 dark:bg-sky-400/15 dark:text-sky-50"
          : "border-border/70 bg-transparent text-foreground hover:border-sky-500/70 hover:bg-sky-500/10 dark:hover:border-sky-400/70 dark:hover:bg-sky-400/10",
      )}
      id={id}
      onClick={onClick}
    >
      <div
        className={cn(
          "text-sm font-medium",
          selected ? "text-sky-950 dark:text-sky-50" : "text-foreground",
        )}
      >
        {label}
      </div>
      {description ? (
        <div
          className={cn(
            "mt-1 text-sm leading-6",
            selected
              ? "text-sky-900/80 dark:text-sky-100/80"
              : "text-muted-foreground",
          )}
        >
          {description}
        </div>
      ) : null}
    </button>
  );
}

function AskUserQuestionsCard({
  interaction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  externalReferences,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? []).map((answer) => [
        answer.questionId,
        [...answer.optionIds],
      ]),
    ),
  );
  const [draftOtherAnswers, setDraftOtherAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, answer.otherText ?? ""]),
    ),
  );
  const [otherActiveQuestions, setOtherActiveQuestions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, true]),
    ),
  );
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

  useEffect(() => {
    setDraftAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? []).map((answer) => [
          answer.questionId,
          [...answer.optionIds],
        ]),
      ),
    );
    setDraftOtherAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, answer.otherText ?? ""]),
      ),
    );
    setOtherActiveQuestions(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, true]),
      ),
    );
  }, [interaction.result?.answers]);

  const questions = interaction.payload.questions;
  const requiredQuestions = questions.filter((question) => question.required);
  const canSubmit = requiredQuestions.every(
    (question) =>
      (draftAnswers[question.id] ?? []).length > 0
      || (
        otherActiveQuestions[question.id] === true
        && (draftOtherAnswers[question.id]?.trim().length ?? 0) > 0
      ),
  );

  function toggleOption(
    questionId: string,
    optionId: string,
    selectionMode: "single" | "multi",
    isFreeText = false,
  ) {
    // A free-text option is a first-class version of the built-in "Other"
    // affordance: selecting it reveals the inline text field and its typed
    // value is submitted as the question's `otherText`.
    if (optionId === OTHER_ANSWER_ID || isFreeText) {
      setOtherActiveQuestions((current) => ({
        ...current,
        [questionId]: !current[questionId],
      }));
      if (selectionMode === "single") {
        setDraftAnswers((current) => ({ ...current, [questionId]: [] }));
      }
      return;
    }

    setDraftAnswers((current) => {
      const existing = current[questionId] ?? [];
      if (selectionMode === "single") {
        return { ...current, [questionId]: [optionId] };
      }
      const next = existing.includes(optionId)
        ? existing.filter((value) => value !== optionId)
        : [...existing, optionId];
      return { ...current, [questionId]: next };
    });
    if (selectionMode === "single") {
      setOtherActiveQuestions((current) => ({ ...current, [questionId]: false }));
    }
  }

  async function handleSubmit() {
    if (!onSubmitInteractionAnswers || !canSubmit) return;
    setWorking(true);
    setActionError(null);
    try {
      await onSubmitInteractionAnswers(
        interaction,
        questions.map((question) => {
          const otherText = otherActiveQuestions[question.id] === true
            ? draftOtherAnswers[question.id]?.trim() ?? ""
            : "";
          return {
            questionId: question.id,
            optionIds: draftAnswers[question.id] ?? [],
            ...(otherText ? { otherText } : {}),
          };
        }),
      );
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function handleCancel() {
    if (!onCancelInteraction) return;
    setCancelling(true);
    setActionError(null);
    try {
      await onCancelInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="border-border/70 bg-background/70 px-2.5 py-1 uppercase tracking-(--tracking-eyebrow) text-foreground/70">
          <MessageSquareQuote className="h-3 w-3" />
          {l10n("local.ask_user_questions_85f98263")}</Badge>
        <span>
          {questions.length === 1
            ? l10n("local.1_question_d69c3b18")
            : l10n("local.value_questions_0d98d85d", {v0: (questions.length)})}
        </span>
      </div>

      {interaction.status === "pending" ? (
        <div className="space-y-4">
          {questions.map((question, index) => {
            const hasFreeTextOption = question.options.some(
              (option) => option.freeText === true,
            );
            return (
            <div
              key={question.id}
              className="rounded-2xl border border-border/70 bg-background/82 p-4 shadow-(--shadow-extract-9)"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    {l10n("local.question_289aff12")}{" "}{index + 1}
                  </div>
                  <div
                    id={`${interaction.id}-${question.id}-prompt`}
                    className="mt-1 text-sm font-semibold text-foreground"
                  >
                    {question.prompt}
                  </div>
                  {question.helpText ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {question.helpText}
                    </p>
                  ) : null}
                </div>
                <TaskField
                  label={question.selectionMode === "single" ? l10n("local.pick_831a9d52") : l10n("local.pick_many_1c791936")}
                  value={question.required ? "Required" : "Optional"}
                  tone="subtle"
                />
              </div>

              <div className="mt-3 space-y-3">
                <div
                  className="grid gap-3"
                  role={question.selectionMode === "single" ? "radiogroup" : "group"}
                  aria-labelledby={`${interaction.id}-${question.id}-prompt`}
                >
                  {question.options.map((option) => {
                    const isFreeText = option.freeText === true;
                    const optionSelected = isFreeText
                      ? otherActiveQuestions[question.id] === true
                      : (draftAnswers[question.id] ?? []).includes(option.id);
                    return (
                      <div key={option.id} className="space-y-2">
                        <QuestionOptionButton
                          id={`${interaction.id}-${question.id}-${option.id}`}
                          label={option.label}
                          description={option.description}
                          selected={optionSelected}
                          selectionMode={question.selectionMode}
                          onClick={() =>
                            toggleOption(question.id, option.id, question.selectionMode, isFreeText)}
                        />
                        {isFreeText && optionSelected ? (
                          <Textarea
                            aria-label={l10n("local.describe_your_answer_for_value_09887c17", {v0: (question.prompt)})}
                            value={draftOtherAnswers[question.id] ?? ""}
                            onChange={(event) =>
                              setDraftOtherAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))}
                            placeholder={l10n("local.type_your_answer_d078bf75")}
                            className="min-h-24 bg-background text-sm"
                            autoFocus
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {/*
                 * The built-in "Other" link is the fallback free-text affordance.
                 * Suppress it when the agent already authored a first-class
                 * free-text option so the card never shows two ways to type an
                 * answer (PAP-419).
                 */}
                {hasFreeTextOption || question.allowOther === false ? null : (
                  <>
                    <button
                      type="button"
                      id={`${interaction.id}-${question.id}-other`}
                      aria-expanded={otherActiveQuestions[question.id] === true}
                      className={cn(
                        "text-sm font-medium underline underline-offset-4 transition-colors outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
                        otherActiveQuestions[question.id]
                          ? "text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() =>
                        toggleOption(question.id, OTHER_ANSWER_ID, question.selectionMode)}
                    >
                      {l10n("local.other_f97e9da0")}</button>
                    {otherActiveQuestions[question.id] ? (
                      <Textarea
                        aria-label={l10n("local.other_answer_for_value_0b982573", {v0: (question.prompt)})}
                        value={draftOtherAnswers[question.id] ?? ""}
                        onChange={(event) =>
                          setDraftOtherAnswers((current) => ({
                            ...current,
                            [question.id]: event.target.value,
                          }))}
                        placeholder={l10n("local.type_your_answer_d078bf75")}
                        className="min-h-24 bg-background text-sm"
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="text-sm text-muted-foreground">
              {l10n("local.submit_once_after_you_finish_the_full_form_02885ec7")}</div>
            <div className="flex flex-wrap items-center gap-2">
              {onCancelInteraction ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || cancelling}
                  onClick={() => void handleCancel()}
                >
                  {cancelling ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {l10n("local.cancelling_7b261310")}</>
                  ) : (
                    l10n("local.cancel_question_437c1e56")
                  )}
                  </Button>
                ) : null}
              <Button
                size="sm"
                disabled={!onSubmitInteractionAnswers || !canSubmit || working || cancelling}
                onClick={() => void handleSubmit()}
              >
                {working ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {l10n("local.submitting_64115d5b")}</>
                ) : (
                  interaction.payload.submitLabel ?? l10n("local.submit_answers_6d232615")
                )}
              </Button>
            </div>
          </div>

          <InteractionActionError message={actionError} />
        </div>
      ) : interaction.status === "cancelled" ? (
        <div className="rounded-2xl border border-rose-300/60 bg-rose-50/85 p-4 text-sm leading-6 text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
          <div className="font-semibold">
            {interaction.result?.outcome === "withdrawn"
              ? questions.length === 1 ? l10n("local.question_withdrawn_7fb9da0d") : l10n("local.questions_withdrawn_5f00159e")
              : l10n("local.question_cancelled_e8960873")}
          </div>
          {interaction.result?.cancellationReason ? (
            <p className="mt-1">{interaction.result.cancellationReason}</p>
          ) : interaction.result?.reason ? (
            <p className="mt-1">{interaction.result.reason}</p>
          ) : (
            <p className="mt-1">{l10n("local.no_answer_was_recorded_9122bb87")}</p>
          )}
        </div>
      ) : interaction.status === "expired" ? (
        <div className="rounded-2xl border border-amber-300/70 bg-amber-50/85 p-4 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {interaction.result?.outcome === "issue_closed"
              ? questions.length === 1
                ? l10n("local.question_expired_when_the_issue_closed_25e10cc4")
                : l10n("local.questions_expired_when_the_issue_closed_0f7b109d")
              : questions.length === 1
                ? l10n("local.question_expired_by_comment_9a1e929d")
                : l10n("local.questions_expired_by_comment_89168554")}
          </div>
          <p className="mt-1">
            {interaction.result?.outcome === "issue_closed"
              ? l10n("local.this_question_request_expired_automatically_w_7dc5da5d")
              : l10n("local.a_later_board_user_comment_superseded_this_qu_890aebaa")}
          </p>
          {interaction.result?.commentId ? (
            <a
              href={`#comment-${interaction.result.commentId}`}
              className="mt-3 inline-flex text-sm font-medium underline underline-offset-4"
            >
              {l10n("local.jump_to_comment_c8799fd3")}</a>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {questions.map((question) => {
            const labels = getQuestionAnswerLabels({
              question,
              answers: interaction.result?.answers ?? [],
            });
            return (
              <div
                key={question.id}
                className="rounded-2xl border border-border/70 bg-background/82 p-4"
              >
                <div className="text-sm font-semibold text-foreground">
                  {question.prompt}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {labels.length > 0 ? (
                    labels.map((label) => (
                      <TaskField key={label} label={l10n("local.answer_b2a3aa60")} value={label} />
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">{l10n("local.no_answer_recorded_85dd2304")}</span>
                  )}
                </div>
              </div>
            );
          })}

          {interaction.result?.summaryMarkdown ? (
            <div className="rounded-2xl border border-emerald-300/60 bg-emerald-50/85 p-4">
              <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-emerald-700">
                {l10n("local.submitted_summary_6af3ea68")}</div>
              <MarkdownBody externalReferences={externalReferences}>{interaction.result.summaryMarkdown}</MarkdownBody>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function requestConfirmationTargetLabel(target: RequestConfirmationTarget) {
  if (target.label) return target.label;
  const revision = target.revisionNumber ? ` v${target.revisionNumber}` : "";
  if (target.type === "issue_document" && target.key === "plan") {
    return l10n("local.planvalue_f71243d8", {v0: (revision)});
  }
  return `${target.key}${revision}`;
}

function requestConfirmationTargetHref({
  interaction,
  target,
}: {
  interaction: Pick<IssueThreadInteraction, "issueId">;
  target: RequestConfirmationTarget;
}) {
  if (target.href) return target.href;
  if (target.type === "issue_document") {
    const issueId = target.issueId ?? interaction.issueId;
    return `/issues/${issueId}#document-${encodeURIComponent(target.key)}`;
  }
  return null;
}

function RequestConfirmationTargetChip({
  interaction,
  target,
  tone = "default",
}: {
  interaction: Pick<IssueThreadInteraction, "issueId">;
  target: RequestConfirmationTarget | null | undefined;
  tone?: "default" | "subtle";
}) {
  if (!target) return null;

  const href = requestConfirmationTargetHref({ interaction, target });
  const className = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow)",
    tone === "default"
      ? "border-border/70 bg-transparent text-foreground"
      : "border-border/60 bg-transparent text-muted-foreground",
    href && "transition-colors hover:border-sky-500/70 hover:bg-sky-500/10",
  );
  const content = (
    <>
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{requestConfirmationTargetLabel(target)}</span>
    </>
  );

  if (!href) return <span className={className}>{content}</span>;
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {content}
    </Link>
  );
}

function RequestConfirmationResolution({
  interaction,
}: {
  interaction: RequestConfirmationInteraction;
}) {
  const outcome = interaction.result?.outcome;
  const target = interaction.payload.target ?? null;
  const staleTarget = interaction.result?.staleTarget ?? null;

  if (interaction.status === "accepted") {
    const resumeFailure = requestConfirmationResumeFailure(interaction);
    if (resumeFailure) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
            <span className="font-medium">{l10n("local.confirmed_fe00b67b")}</span>
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
          <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
              {l10n("local.agent_resume_failed_a456bede")}</div>
            <p className="mt-1 leading-6">
              {resumeFailure.status === "retrying"
                ? l10n("local.paperclip_is_retrying_the_agent_resume_after_ff68a5b4", {v0: (resumeFailure.attempt), v1: (resumeFailure.maxAttempts)})
                : l10n("local.paperclip_needs_attention_before_the_agent_ca_d517e69a")}
            </p>
            {resumeFailure.errorCode ? (
              <p className="mt-1 leading-6">
                {l10n("local.latest_cause_961d0b2c")}{" "}<code className="font-mono text-(length:--text-micro)">{resumeFailure.errorCode}</code>
              </p>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">{l10n("local.confirmed_fe00b67b")}</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">{l10n("local.declined_dce083a2")}</span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {interaction.result?.reason ? (
          <div className="rounded-sm border-l-2 border-rose-500/70 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-900 dark:text-rose-100">
            <MarkdownBody>{interaction.result.reason}</MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "cancelled" && outcome === "withdrawn") {
    // Withdrawn is a neutral administrative retraction (P4 design review): the
    // card-level withdrawn footer carries the "Withdrawn by …" attribution and
    // reason, so this body only anchors the target chip — no rose/red styling
    // and no duplicated reason text.
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">{l10n("local.withdrawn_00c0b03f")}</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "expired") {
    const expiredByComment = outcome === "superseded_by_comment";
    const expiredByIssueClosed = outcome === "issue_closed";
    const expiredByTargetChange = outcome === "stale_target";
    return (
      <div className="space-y-3 rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        {/*
         * issue_closed already carries its label in the header status badge
         * ("Expired · issue closed"), so this eyebrow would duplicate it
         * verbatim — only render the eyebrow for the states the header shows
         * generically as "Expired".
         */}
        {expiredByIssueClosed ? null : (
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700">
            {expiredByComment ? l10n("local.expired_by_comment_2261bc69") : l10n("local.expired_by_target_change_29b61c07")}
          </div>
        )}
        <p className="leading-6">
          {expiredByComment
            ? l10n("local.a_board_comment_superseded_this_confirmation_93bcdf36")
            : expiredByIssueClosed
              ? l10n("local.this_confirmation_expired_automatically_when_d9d1a932")
              : l10n("local.the_requested_target_changed_before_this_conf_45202d1a")}
        </p>
        {expiredByComment && interaction.result?.commentId ? (
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-amber-950 hover:bg-amber-500/15 dark:text-amber-50">
            <a href={`#comment-${interaction.result.commentId}`}>{l10n("local.jump_to_comment_c8799fd3")}</a>
          </Button>
        ) : null}
        {expiredByTargetChange ? (
          <div className="flex flex-wrap items-center gap-2">
            <RequestConfirmationTargetChip
              interaction={interaction}
              target={staleTarget}
              tone="subtle"
            />
            {staleTarget && target ? (
              <ChevronRight className="h-3.5 w-3.5 text-amber-700" />
            ) : null}
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        {l10n("local.this_request_could_not_be_resolved_try_again_7056ad01")}</p>
    );
  }

  return null;
}

function ToolActionResolution({
  state,
  interaction,
}: {
  state: ToolActionCardState;
  interaction: RequestConfirmationInteraction;
}) {
  const result = interaction.result?.toolAction;
  const [resultOpen, setResultOpen] = useState(false);
  const output = state === "executed" ? result?.resultSummary?.trim() : null;
  let formattedOutput = output;
  if (output) {
    try { formattedOutput = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Plain-text results remain readable. */ }
  }
  const labels = {
    pending: l10n("local.waiting_for_approval_10c5739b"),
    running: l10n("local.approved_running_2a0bae3d"),
    executed: l10n("local.succeeded_6d9a6f97"),
    failed: l10n("local.execution_failed_19e5e642"),
    declined: l10n("local.declined_dce083a2"),
    expired: l10n("local.expired_424a2551"),
    cancelled: l10n("local.cancelled_d353a99e"),
  };
  const Icon = state === "running" ? Loader2 : state === "executed" ? CheckCircle2 : state === "failed" ? AlertTriangle : state === "expired" ? Clock : MinusCircle;
  const detail = state === "failed" ? result?.errorMessage?.trim() || l10n("local.the_action_could_not_complete_6a2bc383")
    : state === "declined" ? interaction.result?.reason?.trim()
    : null;
  const status = <>
    <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "running" && "animate-spin", state === "failed" && "text-destructive")} />
    {labels[state]}
    {result?.rememberedAction ? (" " + l10n("local._always_allowed_fe54b377")) : ""}
  </>;
  return (
    <div className="space-y-1 text-sm text-muted-foreground" aria-live="polite">
      {output ? (
        <Collapsible open={resultOpen} onOpenChange={setResultOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={resultOpen ? l10n("local.hide_result_details_1ff4e49e") : l10n("local.show_result_details_68254305")}>
              {status}<ChevronDown className={cn("h-3 w-3", resultOpen && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-foreground">{formattedOutput}</pre>
          </CollapsibleContent>
        </Collapsible>
      ) : <p className="flex items-center gap-1.5">{status}</p>}
      {detail ? <p className={cn("break-words", state === "failed" && "text-destructive")}>{detail}</p> : null}
      {state === "executed" && result?.resultHref?.trim() ? (
        <a className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground" href={result.resultHref} target="_blank" rel="noreferrer">{l10n("local.view_result_fdb7eafd")}<ExternalLink className="h-3 w-3" /></a>
      ) : null}
    </div>
  );
}

function RequestToolActionCard({
  interaction,
  state,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  state: ToolActionCardState;
  onAcceptInteraction?: IssueThreadInteractionCardProps["onAcceptInteraction"];
  onRejectInteraction?: (interaction: RequestConfirmationInteraction, reason?: string) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const payload = interaction.payload.toolAction!;
  const [working, setWorking] = useState<"accept" | "always" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const isPending = state === "pending";
  const variant = payload.risk === "destructive" ? "destructive" : "cta";

  useEffect(() => {
    if (!isPending) setWorking(null);
  }, [interaction.id, isPending]);

  async function decide(decision: "accept" | "always" | "reject") {
    setWorking(decision);
    setActionError(null);
    try {
      if (decision === "reject") await onRejectInteraction?.(interaction);
      else await onAcceptInteraction?.(interaction, undefined, undefined, decision === "always");
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="text-foreground">
      <div className="flex items-start gap-3">
        <span role="img" aria-label={payload.appDisplayName || payload.toolDisplayName}>
          <AppLogo name={payload.appDisplayName || payload.toolDisplayName} size={36} />
        </span>
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          <MarkdownBody externalReferences={externalReferences}>{payload.previewMarkdown || payload.toolDisplayName}</MarkdownBody>
          {!isPending ? <ToolActionResolution state={state} interaction={interaction} /> : null}
        </div>
      </div>
      {isPending ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={!onRejectInteraction || working !== null} onClick={() => void decide("reject")}>
            {working === "reject" ? l10n("local.declining_fb03c72b") : l10n("local.decline_a2d285b3")}
          </Button>
          <div className="inline-flex" role="group" aria-label={l10n("local.approve_request_9ed200ae")}>
            <Button size="sm" variant={variant} className={payload.rememberActionScope ? "rounded-r-none" : undefined} disabled={!onAcceptInteraction || working !== null} onClick={() => void decide("accept")}>
              {working === "accept" || working === "always" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />{working === "always" ? l10n("local.saving_23e39291") : l10n("local.approving_e99dcb0a")}</> : l10n("local.approve_run_e31adde5")}
            </Button>
            {payload.rememberActionScope ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant={variant} className="rounded-l-none border-l border-background/30" aria-label={l10n("local.approval_options_b8cd0e4b")} disabled={!onAcceptInteraction || working !== null}>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void decide("always")} title={payload.rememberActionScope} aria-description={payload.rememberActionScope}>
                    {l10n("local.always_allow_977618bd")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}
      <InteractionActionError message={actionError} />
    </div>
  );
}

type SecretProposalCardState = ToolActionCardState;

function secretProposalCardState(
  interaction: RequestConfirmationInteraction,
): SecretProposalCardState {
  const proposalStatus = interaction.result?.secretProposal?.status ?? null;
  if (interaction.status === "pending") return "pending";
  if (proposalStatus === "executed") return "executed";
  if (proposalStatus === "failed" || interaction.status === "failed") return "failed";
  if (proposalStatus === "expired" || interaction.status === "expired") return "expired";
  if (
    proposalStatus === "rejected"
    || proposalStatus === "withdrawn"
    || interaction.status === "rejected"
    || interaction.status === "cancelled"
  ) {
    return "declined";
  }
  return "running";
}

function secretProposalStatusClasses(state: SecretProposalCardState) {
  if (state === "failed") {
    return {
      shell: "border-2 border-red-500/80 bg-transparent",
      badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
      label: l10n("local.failed_02bd3492"),
      Icon: XCircle,
    };
  }
  return toolActionStatusClasses(state);
}

function SecretProposalIdentityHeader({
  state,
}: {
  state: SecretProposalCardState;
}) {
  const dimmed = state === "declined" || state === "expired";
  return (
    <div className={cn("flex items-start gap-3", dimmed && "opacity-60 grayscale")}>
      <div
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-foreground"
      >
        <KeyRound className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-bold leading-tight text-foreground">
          {l10n("local.bind_an_existing_secret_2aea300f")}</div>
      </div>
    </div>
  );
}

function SecretProposalDetails({
  payload,
}: {
  payload: NonNullable<RequestConfirmationInteraction["payload"]["secretProposal"]>;
}) {
  return (
    <dl className="grid gap-3 rounded-sm border border-border/70 bg-muted/30 p-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {l10n("local.source_secret_60e1f18d")}</dt>
        <dd className="truncate text-sm font-medium text-foreground">{payload.sourceSecretLabel}</dd>
      </div>
      <div className="min-w-0 space-y-1">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {l10n("local.target_agent_d5390914")}</dt>
        <dd className="truncate text-sm font-medium text-foreground">{payload.targetAgentName}</dd>
      </div>
      <div className="min-w-0 space-y-1 sm:col-span-2">
        <dt className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {l10n("local.new_config_path_be59ea68")}</dt>
        <dd className="break-all font-mono text-sm text-foreground">{payload.configPath}</dd>
      </div>
    </dl>
  );
}

function SecretProposalResolution({
  interaction,
  state,
  resolvedByLabel,
}: {
  interaction: RequestConfirmationInteraction;
  state: SecretProposalCardState;
  resolvedByLabel: string | null;
}) {
  const result = interaction.result?.secretProposal ?? null;
  const who = resolvedByLabel ?? "the board";
  const when = interaction.resolvedAt
    ? formatDateTime(interaction.resolvedAt)
    : result?.updatedAt
      ? formatDateTime(result.updatedAt)
      : null;

  if (state === "running") {
    return (
      <div aria-live="polite" className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div>
          <div className="font-medium">{l10n("local.approved_by_8e838c46")}{" "}{who} {l10n("local._creating_the_binding_aa4e87c4")}</div>
          <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
            {l10n("local.paperclip_is_re_checking_authority_and_the_pr_5117fae9")}</p>
        </div>
      </div>
    );
  }

  if (state === "executed") {
    return (
      <div aria-live="polite" className="flex items-start gap-2 rounded-sm border border-green-500/50 bg-green-500/10 px-4 py-3 text-sm text-green-900 dark:text-green-100">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">{l10n("local.binding_created_approved_by_debd1faf")}{" "}{who}</div>
          <p className="mt-1 text-green-900/80 dark:text-green-100/80">
            {l10n("local.the_target_agent_can_now_use_the_proposed_con_c91e5f78")}{when ? ` · ${when}` : ""}.
          </p>
        </div>
      </div>
    );
  }

  if (state === "failed") {
    const errorCode = result?.errorCode?.trim();
    return (
      <div aria-live="assertive" className="space-y-2 rounded-sm border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold uppercase tracking-(--tracking-eyebrow)">
              {l10n("local.failed_binding_was_not_created_0c4d9095")}</div>
            <p className="mt-1 text-red-900/80 dark:text-red-100/80">
              {l10n("local.the_request_was_accepted_but_execution_failed_2b886203")}</p>
          </div>
        </div>
        {errorCode ? (
          <div className="rounded-sm border border-red-500/50 bg-background/60 px-3 py-2">
            <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)">
              {l10n("local.error_code_0570b384")}</span>{" "}
            <code className="font-mono text-foreground">{errorCode}</code>
          </div>
        ) : null}
      </div>
    );
  }

  if (state === "declined") {
    const reason = interaction.result?.reason?.trim();
    return (
      <div className="space-y-2 rounded-sm border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{l10n("local.rejected_by_2ad44c3f")}{" "}{who}</div>
            <p className="mt-1 text-red-900/80 dark:text-red-100/80">{l10n("local.the_binding_was_not_created_38364995")}</p>
          </div>
        </div>
        {reason ? (
          <div className="rounded-sm border border-red-500/40 bg-background/60 px-3 py-2 text-foreground">
            <MarkdownBody>{reason}</MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-sm border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
      <Clock className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-medium text-foreground">{l10n("local.proposal_expired_63284dbb")}{when ? ` · ${when}` : ""}</div>
        <p className="mt-1">{l10n("local.the_binding_was_not_created_a_fresh_proposal_76768784")}</p>
      </div>
    </div>
  );
}

function RequestSecretProposalCard({
  interaction,
  state,
  resolvedByLabel,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: RequestConfirmationInteraction;
  state: SecretProposalCardState;
  resolvedByLabel: string | null;
  onAcceptInteraction?: (interaction: RequestConfirmationInteraction) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const payload = interaction.payload.secretProposal!;
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const isPending = state === "pending";

  useEffect(() => {
    setActionError(null);
    if (!isPending) setWorking(null);
  }, [interaction.id, isPending]);

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason?: string) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      <SecretProposalIdentityHeader state={state} />
      <SecretProposalDetails payload={payload} />
      <ProposalJustification justification={payload.justification} />
      <div className="flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        {l10n("local.expires_f6725f3a")}{" "}{formatDateTime(payload.expiresAt)}
      </div>

      {isPending ? (
        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? l10n("local.approve_bind_6c8c7479")}
          reviseLabel={l10n("local.add_reason_ac3b68fa")}
          rejectLabel={interaction.payload.rejectLabel ?? l10n("local.reject_ab604a36")}
          approveVariant="cta"
          allowRevise={interaction.payload.allowDeclineReason !== false}
          rejectRequiresReason={interaction.payload.rejectRequiresReason === true}
          reasonPlaceholder={interaction.payload.declineReasonPlaceholder ?? "Optional: explain why this binding should not be created."}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
          stackActionsOnMobile
        />
      ) : (
        <SecretProposalResolution
          interaction={interaction}
          state={state}
          resolvedByLabel={resolvedByLabel}
        />
      )}
    </div>
  );
}

/**
 * The single approval grammar shared by every plan / task-approval card
 * (PAP-418): **Approve · Revise… · Reject**. "Revise…" reveals an attached text
 * field for the changes you want (the former "decline with a reason" path);
 * bare "Reject" sends the work back with no note. These are the default words —
 * producers may still override the accept/reject labels for domain-specific
 * confirmations (e.g. "Delete selected"), but the shape stays consistent.
 */
const CONFIRMATION_APPROVE_LABEL = l10n("local.approve_6007acbe");
const CONFIRMATION_REVISE_LABEL = l10n("local.revise_62e1da04");
const CONFIRMATION_REJECT_LABEL = l10n("local.reject_ab604a36");

/**
 * The one action control every confirmation card renders (PAP-418), collapsing
 * what used to be a two-button card plus a separate sticky Plan-pane bar into a
 * single consistent surface. Producer flags tune which affordances appear:
 * `allowDeclineReason: false` drops the Revise… path so only Approve/Reject
 * remain; `rejectRequiresReason: true` drops the bare Reject so every rejection
 * carries a note. The revise text stays attached to the card.
 */
function ConfirmationActionRow({
  resetKey,
  approveLabel,
  reviseLabel = CONFIRMATION_REVISE_LABEL,
  rejectLabel,
  approveVariant = "default",
  primaryActionOnRight = false,
  allowRevise,
  rejectRequiresReason,
  reasonPlaceholder,
  working,
  actionError,
  approveDisabled = false,
  canApprove,
  canReject,
  onApprove,
  onReject,
  composeReason,
  extraReasonSatisfied = false,
  revisePanelChildren,
  stackActionsOnMobile = false,
}: {
  /** Changing this (interaction id + status) collapses the revise panel and
   * clears its draft text — the row is reused across interaction updates. */
  resetKey: string;
  approveLabel: string;
  reviseLabel?: string;
  rejectLabel: string;
  approveVariant?: React.ComponentProps<typeof Button>["variant"];
  primaryActionOnRight?: boolean;
  allowRevise: boolean;
  rejectRequiresReason: boolean;
  reasonPlaceholder: string;
  working: "accept" | "reject" | null;
  actionError: string | null;
  approveDisabled?: boolean;
  canApprove: boolean;
  canReject: boolean;
  onApprove: () => void;
  onReject: (reason: string | undefined) => void;
  /** Compose the final reject reason from the typed text (plan cards append
   * screenshot markdown here). */
  composeReason?: (text: string) => string | undefined;
  /** A required reason is already satisfied by an attachment (e.g. screenshots),
   * so an empty text box should not block sending the revision. */
  extraReasonSatisfied?: boolean;
  /** Extra affordances rendered inside the revise panel (e.g. screenshot attach). */
  revisePanelChildren?: ReactNode;
  /** Give domain cards with longer action labels an intentional narrow-screen
   * hierarchy instead of relying on opportunistic flex wrapping. */
  stackActionsOnMobile?: boolean;
}) {
  const [revising, setRevising] = useState(false);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    setRevising(false);
    setReason("");
    setAttempted(false);
  }, [resetKey]);

  const trimmed = reason.trim();
  const reasonMissing = rejectRequiresReason && trimmed.length === 0 && !extraReasonSatisfied;

  function submitRevision() {
    setAttempted(true);
    if (!canReject || reasonMissing) return;
    onReject(composeReason ? composeReason(reason) : trimmed || undefined);
  }

  return (
    <div className="space-y-3">
      <div
        data-testid="confirmation-actions"
        data-mobile-layout={stackActionsOnMobile ? "stacked" : "inline"}
        className={cn(
          stackActionsOnMobile
            ? "grid grid-cols-2 items-stretch gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
            : "flex flex-wrap items-center justify-end gap-2",
          primaryActionOnRight && "flex-row-reverse justify-start",
        )}
      >
        <Button
          size="sm"
          variant={revising ? "outline" : approveVariant}
          className={stackActionsOnMobile ? "col-span-2 w-full sm:col-auto sm:w-auto" : undefined}
          disabled={!canApprove || working !== null || approveDisabled}
          onClick={onApprove}
        >
          {working === "accept" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {l10n("local.approving_e99dcb0a")}</>
          ) : (
            approveLabel
          )}
        </Button>
        {allowRevise ? (
          <Button
            size="sm"
            variant="outline"
            className={stackActionsOnMobile ? "w-full sm:w-auto" : undefined}
            disabled={!canReject || working !== null}
            onClick={() => {
              setAttempted(false);
              setRevising((current) => !current);
            }}
          >
            {reviseLabel}
          </Button>
        ) : null}
        {!rejectRequiresReason ? (
          <Button
            size="sm"
            variant="ghost"
            className={stackActionsOnMobile ? "w-full sm:w-auto" : undefined}
            disabled={!canReject || working !== null}
            onClick={() => onReject(undefined)}
          >
            {working === "reject" && !revising ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                {l10n("local.rejecting_09868524")}</>
            ) : (
              rejectLabel
            )}
          </Button>
        ) : null}
      </div>

      {revising ? (
        <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={reasonPlaceholder}
            aria-invalid={attempted && reasonMissing}
            className={cn(
              "min-h-24 bg-background text-sm",
              attempted && reasonMissing && "border-rose-500 focus-visible:ring-rose-500/25",
            )}
          />
          {attempted && reasonMissing ? (
            <p className="text-xs text-destructive">{l10n("local.add_a_note_describing_the_changes_you_want_d5ef6ba9")}</p>
          ) : null}
          {revisePanelChildren}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => {
                setRevising(false);
                setAttempted(false);
              }}
            >
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canReject || working !== null}
              onClick={submitRevision}
            >
              {working === "reject" ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  {l10n("local.sending_b8ed5279")}</>
              ) : (
                l10n("local.send_revision_953cc98c")
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <InteractionActionError message={actionError} />
    </div>
  );
}

function connectionAuthorizationStatusClasses(
  state: ConnectionAuthorizationCardState,
  copy: { providerName: string; addresseeLabel: string },
): {
  shell: string;
  badge: string;
  label: string;
  Icon: typeof CheckCircle2;
} {
  switch (state) {
    case "actionable":
      return {
        shell: "border-2 border-sky-500/70 bg-transparent",
        badge: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
        label: l10n("local.action_required_adf69e75"),
        Icon: KeyRound,
      };
    case "waiting":
      // Not a warning and not a failure: someone else's decision is simply
      // outstanding. The calm inert lane keeps it out of the reader's queue.
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: l10n("local.waiting_for_value_499293fe", {v0: (copy.addresseeLabel)}),
        Icon: Clock,
      };
    case "connected":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: l10n("local.value_connected_db4ed330", {v0: (copy.providerName)}),
        Icon: CheckCircle2,
      };
    case "declined":
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: l10n("local.not_connected_0303e182"),
        Icon: MinusCircle,
      };
    case "expired":
    default:
      return {
        shell: "border-border bg-transparent",
        badge: "border-border bg-muted/60 text-muted-foreground",
        label: l10n("local.authorization_expired_92b4263f"),
        Icon: CircleDashed,
      };
  }
}

/**
 * Connection authorization — "Connect your Gmail to continue" (PAP-17796
 * Surface F, corrected in PAP-17859).
 *
 * This is deliberately *not* the generic Approve / Revise… / Reject grammar it
 * used to fall through to. Authorization is not a review: there is nothing to
 * revise, "Reject" is the wrong word for declining to link your own account,
 * and only one person in the company can answer at all. So the card composes
 * one title, one body, and exactly the affordances the reader legitimately has:
 *
 * - the addressed person gets the single primary **Connect <Provider>** target
 *   plus a plain **Not now**;
 * - anybody else gets **Waiting for <Person>** and no action at all — a
 *   policy-forbidden action is omitted, never rendered disabled, and the card
 *   must not imply a teammate can consent on their behalf;
 * - once resolved it states the outcome, who resolved it, and when.
 *
 * The primary action is a link to the server-minted authorization URL, not an
 * accept call: the OAuth callback is what resolves this interaction, so the
 * card never claims success the provider has not granted.
 */
function RequestConnectionAuthorizationCard({
  interaction,
  state,
  isAddressee,
  providerName,
  addresseeLabel,
  requestingAgentLabel,
  resolvedByLabel,
  resolvedByAgent,
  onRejectInteraction,
}: {
  interaction: RequestConfirmationInteraction;
  state: ConnectionAuthorizationCardState;
  /** Is the signed-in reader the person the server addressed? */
  isAddressee: boolean;
  providerName: string;
  addresseeLabel: string;
  requestingAgentLabel: string | null;
  resolvedByLabel: string | null;
  resolvedByAgent: boolean;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const href = connectionAuthorizationHref(interaction);
  const declineReason = getAdministrativeReason(interaction);

  useEffect(() => {
    setActionError(null);
    setWorking(false);
  }, [interaction.id, interaction.status]);

  async function handleNotNow() {
    if (!onRejectInteraction) return;
    setWorking(true);
    setActionError(null);
    try {
      await onRejectInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  // One body, composed here rather than split between the header summary and a
  // payload prompt that repeats the title.
  //
  // The server's summary is written in the second person ("needs *your* Gmail
  // identity for work running as *you*") because the server addressed one
  // person. Shown to a teammate it names the wrong account, so a reader who is
  // not the addressee gets the same fact stated about them. Caught by rendering
  // the card, not by reading it.
  const agentLabel = requestingAgentLabel ?? l10n("local.an_agent_ea6a0363");
  const lead = isAddressee
    ? interaction.summary?.trim()
      || `${agentLabel} needs your ${providerName} identity for work running as you.`
    : `${agentLabel} ${state === "connected" ? "needed" : "needs"} ${addresseeLabel}'s ${providerName} identity for work running as them.`;
  // Only the actionable state needs the consent boundary spelled out; the other
  // states carry it in their own status line.
  const consentSentence = state === "actionable" ? "No one else can complete this step." : null;

  return (
    <div className="space-y-4">
      <p
        className="max-w-3xl text-sm leading-6 text-muted-foreground"
        data-testid="connection-authorization-body"
      >
        {consentSentence ? `${lead} ${consentSentence}` : lead}
      </p>

      {state === "actionable" ? (
        <div className="space-y-3">
          {href ? (
            <div
              data-testid="connection-authorization-actions"
              className="grid grid-cols-1 items-stretch gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end"
            >
              <Button asChild size="sm" variant="cta" className="w-full sm:w-auto">
                <a href={href} target="_blank" rel="noreferrer">
                  {l10n("local.connect_1a2303ed")}{" "}{providerName}
                  <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full sm:w-auto"
                disabled={!onRejectInteraction || working}
                onClick={() => void handleNotNow()}
              >
                {working ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {l10n("local.saving_23e39291")}</>
                ) : (
                  l10n("local.not_now_a0e63d7c")
                )}
              </Button>
            </div>
          ) : (
            // A pending card with no usable target is a server-side gap, not an
            // invitation to reuse an old URL.
            <ConnectionAuthorizationStatusLine
              Icon={TriangleAlert}
              testId="connection-authorization-no-target"
              headline="This authorization link is unavailable"
              detail={l10n("local.ask_value_to_send_a_fresh_value_authorization_4a48611e", {v0: (requestingAgentLabel ?? "the agent"), v1: (providerName)})}
            />
          )}
          <InteractionActionError message={actionError} />
        </div>
      ) : state === "waiting" ? (
        <ConnectionAuthorizationStatusLine
          Icon={Clock}
          testId="connection-authorization-waiting"
          headline={`Waiting for ${addresseeLabel}`}
          detail={l10n("local.only_value_can_connect_their_own_value_accoun_fc6c2f7c", {v0: (addresseeLabel), v1: (providerName)})}
        />
      ) : state === "connected" ? (
        <ConnectionAuthorizationStatusLine
          Icon={CheckCircle2}
          testId="connection-authorization-connected"
          headline={`${providerName} connected`}
          detail={
            <>
              {l10n("local.connected_by_9952ce52")}{" "}
              <span className="font-medium text-foreground">
                {/* "You" is display-cased for a badge; this is mid-sentence. */}
                {(resolvedByLabel ?? addresseeLabel) === "You" ? l10n("local.you_bb0347a4") : resolvedByLabel ?? addresseeLabel}
              </span>
              {resolvedByAgent ? <ResolvedByAgentChip /> : null}
              {interaction.resolvedAt ? (" " + l10n("local.on_value_dc137047", {v0: (formatDateTime(interaction.resolvedAt))})) : ""}
            </>
          }
        />
      ) : (
        // Declined or expired. No Connect action: the authorization target this
        // card carried is spent, and the agent asks again with a fresh one
        // rather than the board replaying a dead URL.
        <ConnectionAuthorizationStatusLine
          Icon={state === "declined" ? MinusCircle : CircleDashed}
          testId={state === "declined" ? "connection-authorization-declined" : "connection-authorization-expired"}
          headline={state === "declined" ? `${providerName} was not connected` : "This authorization request expired"}
          detail={
            declineReason
              ?? l10n("local.value_can_ask_again_with_a_new_value_authoriz_91084260", {v0: (requestingAgentLabel ?? "The agent"), v1: (providerName)})
          }
        />
      )}
    </div>
  );
}

function ConnectionAuthorizationStatusLine({
  Icon,
  testId,
  headline,
  detail,
}: {
  Icon: typeof CheckCircle2;
  testId: string;
  headline: string;
  detail: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-2 rounded-sm border border-border/70 bg-muted/30 p-3"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-0.5 text-sm">
        <div className="font-medium text-foreground">{headline}</div>
        <div className="leading-6 text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function RequestConfirmationCard({
  interaction,
  isPlan = false,
  primaryActionOnRight = false,
  onAcceptInteraction,
  onRejectInteraction,
  onUploadImage,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  isPlan?: boolean;
  primaryActionOnRight?: boolean;
  onAcceptInteraction?: (
    interaction: RequestConfirmationInteraction,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();
  const [shots, setShots] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Screenshots ride along in the revise note as markdown image refs so the
  // board can attach images when sending a plan back — no schema change needed.
  const allowScreenshots = isPlan && Boolean(onUploadImage);
  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowRevise = interaction.payload.allowDeclineReason !== false;
  const reasonPlaceholder =
    interaction.payload.declineReasonPlaceholder
    ?? (interaction.payload.acceptLabel === "Approve plan"
      ? "Optional: what would you like revised?"
      : "Optional: tell the agent what you'd change.");

  useEffect(() => {
    setActionError(null);
    setShots([]);
    setUploadError(null);
    if (interaction.status !== "pending") {
      setWorking(null);
    }
  }, [interaction.id, interaction.result?.reason, interaction.status]);

  async function handleAddScreenshots(files: FileList | null) {
    if (!onUploadImage || !files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded: { name: string; url: string }[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const url = await onUploadImage(file);
        uploaded.push({ name: file.name || "screenshot", url });
      }
      if (uploaded.length > 0) setShots((current) => [...current, ...uploaded]);
    } catch {
      setUploadError(l10n("local.couldn_t_upload_that_image_try_again_0764ae5a"));
    } finally {
      setUploading(false);
    }
  }

  function composeReason(text: string) {
    const trimmed = text.trim();
    if (shots.length === 0) return trimmed || undefined;
    const images = shots.map((s) => `![${s.name}](${s.url})`).join("\n");
    return [trimmed, images].filter(Boolean).join("\n\n");
  }

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason: string | undefined) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      {interaction.status === "pending" ? (
        <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
          <div className="text-sm leading-6 text-foreground">
            {interaction.payload.prompt}
          </div>
          {interaction.payload.detailsMarkdown ? (
            <div className="border-t border-border/60 pt-3 text-sm">
              <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
            </div>
          ) : null}
          <RequestConfirmationTargetChip
            interaction={interaction}
            target={interaction.payload.target}
          />
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? CONFIRMATION_APPROVE_LABEL}
          rejectLabel={CONFIRMATION_REJECT_LABEL}
          approveVariant={isPlan ? "cta" : "default"}
          primaryActionOnRight={primaryActionOnRight}
          allowRevise={allowRevise}
          rejectRequiresReason={rejectRequiresReason}
          reasonPlaceholder={reasonPlaceholder}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
          composeReason={composeReason}
          extraReasonSatisfied={shots.length > 0}
          revisePanelChildren={
            allowScreenshots ? (
              <div className="space-y-2">
                {shots.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {shots.map((shot, index) => (
                      <div
                        key={`${shot.url}-${index}`}
                        className="group relative h-16 w-16 overflow-hidden rounded-sm border border-border/70"
                      >
                        <img
                          src={shot.url}
                          alt={shot.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          aria-label={l10n("local.remove_value_86790c6d", {v0: (shot.name)})}
                          className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() =>
                            setShots((current) => current.filter((_, i) => i !== index))
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleAddScreenshots(event.target.value ? event.target.files : null);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={working !== null || uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {l10n("local.uploading_72cb29c9")}</>
                  ) : (
                    <>
                      <ImagePlus className="mr-2 h-3.5 w-3.5" />
                      {l10n("local.attach_screenshots_d0f8e01d")}</>
                  )}
                </Button>
                {uploadError ? (
                  <p className="text-xs text-destructive">{uploadError}</p>
                ) : null}
              </div>
            ) : null
          }
        />
      ) : (
        <RequestConfirmationResolution interaction={interaction} />
      )}
    </div>
  );
}

const CHECKBOX_SUMMARY_LABEL_LIMIT = 8;

function RequestCheckboxConfirmationResolution({
  interaction,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
}) {
  const target = interaction.payload.target ?? null;
  const [expanded, setExpanded] = useState(false);

  if (interaction.status === "accepted") {
    const totalOptions = interaction.payload.options.length;
    const selectedLabels = getCheckboxConfirmationSelectedLabels({
      payload: interaction.payload,
      result: interaction.result,
    });
    const selectedCount = interaction.result?.selectedOptionIds?.length ?? selectedLabels.length;
    const visibleLabels = expanded
      ? selectedLabels
      : selectedLabels.slice(0, CHECKBOX_SUMMARY_LABEL_LIMIT);
    const hiddenCount = selectedLabels.length - CHECKBOX_SUMMARY_LABEL_LIMIT;
    const hasHiddenLabels = hiddenCount > 0;
    const chipClassName =
      "inline-flex items-center rounded-sm border border-border/60 bg-transparent px-2 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">
            {selectedCount === 0
              ? l10n("local.confirmed_with_no_options_selected_1962f778")
              : l10n("local.confirmed_value_of_value_value_6e1d685a", {v0: (selectedCount), v1: (totalOptions), v2: (totalOptions === 1 ? "option" : "options")})}
          </span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {visibleLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleLabels.map((label, index) => (
              <TaskField key={`${label}-${index}`} label={l10n("local.selected_57fd7a0c")} value={label} />
            ))}
            {hasHiddenLabels ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className={cn(
                  chipClassName,
                  "cursor-pointer transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
                aria-expanded={expanded}
              >
                {expanded ? l10n("local.show_less_94ea9b1d") : l10n("local._value_more_8769eb5d", {v0: (hiddenCount)})}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
  }

  if (interaction.status === "expired") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
  }

  if (interaction.status === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        {l10n("local.this_request_could_not_be_resolved_try_again_7056ad01")}</p>
    );
  }

  return null;
}

function CheckboxOptionRow({
  id,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  description?: string | null;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 border-b border-border/60 px-3 py-2 last:border-b-0 transition-colors",
        checked ? "bg-sky-500/10" : "hover:bg-sky-500/5",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
        aria-label={label}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-5 text-foreground">{label}</div>
        {description ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </label>
  );
}

function RequestCheckboxConfirmationCard({
  interaction,
  primaryActionOnRight = false,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  primaryActionOnRight?: boolean;
  onAcceptInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    selectedClientKeys: undefined,
    selectedOptionIds: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const options = interaction.payload.options;
  const optionIds = useMemo(() => options.map((option) => option.id), [options]);
  const validOptionIds = useMemo(() => new Set(optionIds), [optionIds]);
  const minSelected = interaction.payload.minSelected ?? 0;
  const maxSelected = interaction.payload.maxSelected ?? null;

  const defaultSelected = useMemo(
    () =>
      new Set(
        (interaction.payload.defaultSelectedOptionIds ?? []).filter((id) => validOptionIds.has(id)),
      ),
    [interaction.payload.defaultSelectedOptionIds, validOptionIds],
  );

  const [selectedOptionIds, setSelectedOptionIds] = useState<Set<string>>(() => new Set(defaultSelected));
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [acceptAttempted, setAcceptAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

  const optionSeed = useMemo(() => optionIds.join("\n"), [optionIds]);

  useEffect(() => {
    setSelectedOptionIds(new Set(defaultSelected));
    setAcceptAttempted(false);
    setActionError(null);
    if (interaction.status !== "pending") {
      setWorking(null);
    }
  }, [interaction.id, interaction.status, interaction.result?.reason, defaultSelected, optionSeed]);

  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowRevise = interaction.payload.allowDeclineReason !== false;
  const reasonPlaceholder =
    interaction.payload.declineReasonPlaceholder ?? "Optional: tell the agent what you'd change.";

  const selectedCount = selectedOptionIds.size;
  const totalOptions = options.length;
  const atMax = maxSelected != null && selectedCount >= maxSelected;
  const belowMin = selectedCount < minSelected;
  const aboveMax = maxSelected != null && selectedCount > maxSelected;
  const selectionValid = !belowMin && !aboveMax;

  const validationMessage = belowMin
    ? minSelected === 1
      ? l10n("local.select_at_least_1_option_b2ec3305")
      : l10n("local.select_at_least_value_options_de619825", {v0: (minSelected)})
    : aboveMax && maxSelected != null
      ? maxSelected === 1
        ? l10n("local.select_at_most_1_option_45f17e29")
        : l10n("local.select_at_most_value_options_91db3a57", {v0: (maxSelected)})
      : null;

  function toggleOption(optionId: string, checked: boolean) {
    setSelectedOptionIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(optionId);
      } else {
        next.delete(optionId);
      }
      return next;
    });
  }

  function handleSelectAll() {
    const capped = maxSelected != null ? optionIds.slice(0, maxSelected) : optionIds;
    setSelectedOptionIds(new Set(capped));
  }

  function handleClearSelection() {
    setSelectedOptionIds(new Set());
  }

  async function handleAccept() {
    setAcceptAttempted(true);
    if (!onAcceptInteraction || !selectionValid) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction, undefined, [...selectedOptionIds]);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function handleReject(reason: string | undefined) {
    if (!onRejectInteraction) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, reason);
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  if (interaction.status !== "pending") {
    return (
      <div className="space-y-4">
        <RequestCheckboxConfirmationResolution interaction={interaction} />
      </div>
    );
  }

  const selectionSummary = totalOptions > 0 && selectedCount === totalOptions
    ? l10n("local.all_value_options_selected_12566844", {v0: (totalOptions)})
    : l10n("local.value_of_value_value_selected_f15705fa", {v0: (selectedCount), v1: (totalOptions), v2: (totalOptions === 1 ? "option" : "options")});
  const boundsHint = maxSelected != null
    ? l10n("local.pick_value_b993b7e4", {v0: (minSelected === maxSelected ? `exactly ${maxSelected}` : `${minSelected}-${maxSelected}`)})
    : minSelected > 0
      ? l10n("local.pick_at_least_value_e4298a2b", {v0: (minSelected)})
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        {/* Show each piece of state once: a connection-authorization prompt is
            the same sentence as the card title, so repeating it here is noise. */}
        {interaction.payload.prompt === interaction.title ? null : (
          <div className="text-sm leading-6 text-foreground">{interaction.payload.prompt}</div>
        )}
        {interaction.payload.detailsMarkdown ? (
          <div className="border-t border-border/60 pt-3 text-sm">
            <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
          </div>
        ) : null}
        <RequestConfirmationTargetChip
          interaction={interaction}
          target={interaction.payload.target}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{selectionSummary}</span>
            {boundsHint ? <span>{boundsHint}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === totalOptions || (maxSelected != null && selectedCount >= maxSelected)}
              onClick={handleSelectAll}
            >
              {l10n("local.select_all_1fc9a387")}</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === 0}
              onClick={handleClearSelection}
            >
              {l10n("local.clear_selection_cea4d2e0")}</Button>
          </div>
        </div>

        <div
          role="group"
          aria-label={l10n("local.selectable_options_aaabfe0b")}
          className="max-h-80 overflow-y-auto rounded-sm border border-border/70"
        >
          {options.map((option) => {
            const checked = selectedOptionIds.has(option.id);
            return (
              <CheckboxOptionRow
                key={option.id}
                id={`${interaction.id}-${option.id}`}
                label={option.label}
                description={option.description}
                checked={checked}
                disabled={working !== null || (!checked && atMax)}
                onToggle={(value) => toggleOption(option.id, value)}
              />
            );
          })}
        </div>

        {acceptAttempted && validationMessage ? (
          <p className="text-xs text-destructive">{validationMessage}</p>
        ) : null}

        <ConfirmationActionRow
          resetKey={`${interaction.id}:${interaction.status}`}
          approveLabel={interaction.payload.acceptLabel ?? CONFIRMATION_APPROVE_LABEL}
          rejectLabel={interaction.payload.rejectLabel ?? CONFIRMATION_REJECT_LABEL}
          primaryActionOnRight={primaryActionOnRight}
          allowRevise={allowRevise}
          rejectRequiresReason={rejectRequiresReason}
          reasonPlaceholder={reasonPlaceholder}
          working={working}
          actionError={actionError}
          canApprove={Boolean(onAcceptInteraction)}
          canReject={Boolean(onRejectInteraction)}
          onApprove={() => void handleAccept()}
          onReject={(reason) => void handleReject(reason)}
        />
      </div>
    </div>
  );
}

// --- Per-item verdicts (C3) ---------------------------------------------

const VERDICT_LABEL: Record<RequestItemVerdictValue, string> = {
  approve: "Approve",
  reject: "Reject",
  defer: "Defer",
};

/** Present-tense past-participle label for a resolved verdict chip. */
const VERDICT_RESOLVED_LABEL: Record<RequestItemVerdictValue, string> = {
  approve: "Approved",
  reject: "Rejected",
  defer: "Deferred",
};

function verdictChipClasses(verdict: RequestItemVerdictValue) {
  switch (verdict) {
    case "approve":
      return "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100";
    case "reject":
      return "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100";
    default:
      return "border-border/70 bg-muted/40 text-muted-foreground";
  }
}

function VerdictConsequenceChip({ verdict }: { verdict: RequestItemVerdictValue }) {
  const Icon = verdict === "approve" ? CheckCircle2 : verdict === "reject" ? XCircle : MinusCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)",
        verdictChipClasses(verdict),
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {VERDICT_RESOLVED_LABEL[verdict]}
    </span>
  );
}

function ItemVerdictDeepLink({ item }: { item: RequestItemVerdictsItem }) {
  const href = item.href ? normalizeRequestConfirmationTargetHref(item.href) : null;
  if (!href) return null;
  const isInternal = href.startsWith("/") || href.startsWith("#");
  const className =
    "inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";
  const label = (
    <>
      {l10n("local.open_ed077f3d")}{isInternal ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ExternalLink className="h-3 w-3" aria-hidden />}
    </>
  );
  if (isInternal) {
    return (
      <Link to={href} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {label}
    </a>
  );
}

function ItemVerdictSegmentedControl({
  itemId,
  verdicts,
  value,
  disabled,
  onSelect,
}: {
  itemId: string;
  verdicts: RequestItemVerdictValue[];
  value: RequestItemVerdictValue | null;
  disabled: boolean;
  onSelect: (verdict: RequestItemVerdictValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label={l10n("local.choose_a_verdict_849de4eb")}
      className="flex shrink-0 flex-wrap items-center gap-2"
    >
      {verdicts.map((verdict) => {
        const active = value === verdict;
        const variant = verdict === "reject"
          ? (active ? "destructive" : "outline")
          : verdict === "approve"
            ? (active ? "default" : "outline")
            : (active ? "secondary" : "outline");
        const Icon = verdict === "approve" ? Check : verdict === "reject" ? X : MinusCircle;
        return (
          <Button
            key={verdict}
            type="button"
            size="sm"
            variant={variant}
            disabled={disabled}
            aria-pressed={active}
            aria-label={l10n("local.value_this_item_fb77b19d", {v0: (VERDICT_LABEL[verdict])})}
            className="min-h-11 min-w-24"
            onClick={() => onSelect(verdict)}
            data-verdict={verdict}
            data-item-id={itemId}
            data-active={active}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {VERDICT_LABEL[verdict]}
          </Button>
        );
      })}
    </div>
  );
}

interface VerdictDraft {
  verdict: RequestItemVerdictValue;
  reason: string;
}

function RequestItemVerdictsCard({
  interaction,
  onSubmitInteractionVerdicts,
  externalReferences,
}: {
  interaction: RequestItemVerdictsInteraction;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: { id: string; verdict: RequestItemVerdictValue; reason?: string }[],
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const payload = interaction.payload;
  const items = payload.items;
  const enabledVerdicts = useMemo<RequestItemVerdictValue[]>(
    () => payload.verdicts ?? ["approve", "reject"],
    [payload.verdicts],
  );
  const requireReasonOn = useMemo(
    () => new Set<RequestItemVerdictValue>(payload.requireReasonOn ?? ["reject"]),
    [payload.requireReasonOn],
  );
  const allowBulkApprove = payload.allowBulkApprove !== false && enabledVerdicts.includes("approve");
  const reasonLabel = payload.reasonLabel ?? l10n("local.reason_f81ab834");

  const resolvedById = useMemo(
    () => new Map<string, RequestItemVerdictsResultItem>((interaction.result?.items ?? []).map((item) => [item.id, item])),
    [interaction.result],
  );

  const [drafts, setDrafts] = useState<Map<string, VerdictDraft>>(new Map());
  const [applyingItemIds, setApplyingItemIds] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolutionErrorMessage = useResolutionErrorMessage();

  // When the server merges newly-resolved items, drop their local drafts and
  // clear the applying/working state so the terminal chips take over (S3 → S4).
  useEffect(() => {
    setDrafts((current) => {
      let changed = false;
      const next = new Map(current);
      for (const id of [...next.keys()]) {
        if (resolvedById.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setApplyingItemIds(new Set());
    setWorking(false);
    setActionError(null);
  }, [resolvedById]);

  const progress = getItemVerdictProgress({ payload, result: interaction.result });
  const isTerminal = interaction.status !== "pending";
  const isExpired = interaction.status === "expired";
  const isComplete = interaction.status === "answered" || progress.decided === progress.total;

  const draftEntries = [...drafts.entries()];
  const draftCount = draftEntries.length;
  const invalidDraftIds = new Set(
    draftEntries
      .filter(([, draft]) => requireReasonOn.has(draft.verdict) && draft.reason.trim().length === 0)
      .map(([id]) => id),
  );
  // Apply is enabled as soon as there is ≥1 draft (spec §1). If a required
  // reject reason is missing, clicking Apply reveals the inline error instead
  // of silently submitting — the reason gates the actual submit (spec AC).
  const hasDrafts = draftCount > 0 && !working && Boolean(onSubmitInteractionVerdicts);
  const canApply = hasDrafts && invalidDraftIds.size === 0;

  function toggleDraft(itemId: string, verdict: RequestItemVerdictValue) {
    setDrafts((current) => {
      const next = new Map(current);
      const existing = next.get(itemId);
      if (existing?.verdict === verdict) {
        next.delete(itemId); // per-item undo
      } else {
        next.set(itemId, { verdict, reason: existing?.reason ?? "" });
      }
      return next;
    });
  }

  function setDraftReason(itemId: string, reason: string) {
    setDrafts((current) => {
      const existing = current.get(itemId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(itemId, { ...existing, reason });
      return next;
    });
  }

  function handleApproveAll() {
    if (!allowBulkApprove) return;
    setDrafts((current) => {
      const next = new Map(current);
      for (const id of progress.pendingItemIds) {
        const existing = next.get(id);
        next.set(id, { verdict: "approve", reason: existing?.reason ?? "" });
      }
      return next;
    });
  }

  async function handleApply() {
    setAttempted(true);
    if (!onSubmitInteractionVerdicts || draftCount === 0 || invalidDraftIds.size > 0) return;
    const verdicts = draftEntries.map(([id, draft]) => ({
      id,
      verdict: draft.verdict,
      reason: draft.reason.trim() ? draft.reason.trim() : undefined,
    }));
    setWorking(true);
    setApplyingItemIds(new Set(verdicts.map((entry) => entry.id)));
    setActionError(null);
    try {
      await onSubmitInteractionVerdicts(interaction, verdicts);
      // Success: the parent refetch updates `interaction.result`, the effect
      // above clears drafts + applying state, and terminal chips render.
    } catch (error) {
      setActionError(resolutionErrorMessage(error));
      setApplyingItemIds(new Set());
      setWorking(false);
    }
  }

  const applyLabel = draftCount === 0
    ? l10n("local.apply_0_decisions_3797d7e6")
    : l10n("local.apply_value_decisionvalue_fb737472", {v0: (draftCount), v1: (englishPluralSuffix(draftCount === 1 ? "" : "s"))});

  return (
    <div className="space-y-4">
      {/* Prompt + details (S1) */}
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm leading-6 text-foreground">{payload.prompt}</div>
          <VerdictProgressBadge progress={progress} pendingReason={invalidDraftIds.size > 0} />
        </div>
        {payload.detailsMarkdown ? (
          <div className="border-t border-border/60 pt-3 text-sm">
            <MarkdownBody externalReferences={externalReferences}>{payload.detailsMarkdown}</MarkdownBody>
          </div>
        ) : null}
        {interaction.payload.target ? (
          <RequestConfirmationTargetChip interaction={interaction} target={interaction.payload.target} />
        ) : null}
      </div>

      {/* Stale / superseded notice (S6) */}
      {isExpired ? (
        <div className="rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            {interaction.result?.outcome === "superseded_by_comment"
              ? l10n("local.this_review_expired_after_a_later_comment_080c0897")
              : interaction.result?.outcome === "stale_target"
                ? l10n("local.this_review_expired_after_the_target_changed_66123ea9")
                : l10n("local.this_review_expired_36cd0712")}
          </div>
          {progress.decided > 0 ? (
            <p className="mt-1 text-xs leading-5">
              {progress.decided === 1 ? l10n("local.1_item_was_f4000d8c") : l10n("local.value_items_were_56aa0570", {v0: (progress.decided)})} {l10n("local.already_applied_and_cannot_be_reverted_remain_360a2fec")}</p>
          ) : null}
        </div>
      ) : null}

      {/* Item list (S1/S2/S3/S4) */}
      <ul className="space-y-2" aria-label={l10n("local.items_to_review_6cac728c")}>
        {items.map((item) => {
          const resolved = resolvedById.get(item.id);
          const applying = applyingItemIds.has(item.id);
          const draft = drafts.get(item.id);
          return (
            <li
              key={item.id}
              className={cn(
                "rounded-sm border border-border/70 bg-background/60 p-3",
                draft && !resolved && "border-border",
              )}
              data-item-id={item.id}
              data-item-state={resolved ? "resolved" : applying ? "applying" : draft ? "draft" : "pending"}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium leading-5 text-foreground">{item.label}</span>
                    <ItemVerdictDeepLink item={item} />
                  </div>
                  {item.description ? (
                    <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{item.description}</p>
                  ) : null}
                  {item.previewMarkdown ? (
                    <div className="mt-2 rounded-sm border border-border/50 bg-muted/20 px-2.5 py-2 text-xs">
                      <MarkdownBody externalReferences={externalReferences}>{item.previewMarkdown}</MarkdownBody>
                    </div>
                  ) : null}
                  {resolved?.reason ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      <span className="font-medium text-foreground">{reasonLabel}: </span>
                      {resolved.reason}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {resolved ? (
                    <VerdictConsequenceChip verdict={resolved.verdict} />
                  ) : applying ? (
                    <span className="inline-flex items-center gap-1.5 rounded-sm border border-border/70 bg-muted/40 px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                      {l10n("local.applying_3329a9bb")}</span>
                  ) : isTerminal ? (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-muted/30 px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                      {l10n("local.not_decided_4fb8e6bd")}</span>
                  ) : (
                    <ItemVerdictSegmentedControl
                      itemId={item.id}
                      verdicts={enabledVerdicts}
                      value={draft?.verdict ?? null}
                      disabled={working}
                      onSelect={(verdict) => toggleDraft(item.id, verdict)}
                    />
                  )}
                </div>
              </div>

              {/* Draft reason field (S2) — reveals when the draft verdict needs a reason */}
              {!resolved && !applying && draft && requireReasonOn.has(draft.verdict) ? (
                <div className="mt-3 space-y-1.5">
                  <label
                    htmlFor={`${interaction.id}-${item.id}-reason`}
                    className="text-xs font-medium text-foreground"
                  >
                    {reasonLabel}
                  </label>
                  <Textarea
                    id={`${interaction.id}-${item.id}-reason`}
                    value={draft.reason}
                    onChange={(event) => setDraftReason(item.id, event.target.value)}
                    placeholder={l10n("local.give_the_agent_a_reason_so_it_can_act_on_this_0149096b")}
                    aria-invalid={attempted && invalidDraftIds.has(item.id)}
                    className={cn(
                      "min-h-16 bg-background text-sm",
                      attempted && invalidDraftIds.has(item.id) && "border-rose-500 focus-visible:ring-rose-500/25",
                    )}
                  />
                  {attempted && invalidDraftIds.has(item.id) ? (
                    <p className="text-xs text-destructive">{l10n("local.a_reason_is_required_to_3301d901")}{" "}{VERDICT_LABEL[draft.verdict].toLowerCase()} {l10n("local.this_item_5f6fa014")}</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Complete summary (S5) */}
      {isComplete && !isExpired ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          <span className="font-medium">
            {progress.decided} {l10n("local.decided_5a06576f")}{" "}{progress.approved} {l10n("local.approved_1ecc7774")}{" "}{progress.rejected} {l10n("local.rejected_20cd938a")}{progress.deferred > 0 ? (" " + l10n("local._value_deferred_a5f3f44f", {v0: (progress.deferred)})) : ""}
          </span>
        </div>
      ) : null}

      {/* Pinned batch bar (S1/S2) — only while items remain actionable */}
      {!isTerminal && progress.pendingItemIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="text-xs text-muted-foreground">
            {draftCount > 0
              ? l10n("local.value_draft_verdictvalue_ready_to_apply_846180a4", {v0: (draftCount), v1: (englishPluralSuffix(draftCount === 1 ? "" : "s"))})
              : l10n("local.mark_verdicts_then_apply_them_in_one_pass_881de88b")}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {allowBulkApprove ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={working || progress.pendingItemIds.length === 0}
                onClick={handleApproveAll}
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />
                {l10n("local.approve_all_ae067b68")}</Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              aria-disabled={!canApply}
              disabled={!hasDrafts}
              onClick={() => void handleApply()}
            >
              {working ? (
                <>
                  <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  {l10n("local.applying_3329a9bb")}</>
              ) : (
                applyLabel
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <InteractionActionError message={actionError} />
    </div>
  );
}

function VerdictProgressBadge({
  progress,
  pendingReason,
}: {
  progress: ReturnType<typeof getItemVerdictProgress>;
  pendingReason: boolean;
}) {
  const pct = progress.total > 0 ? Math.round((progress.decided / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      {/* Von Restorff accent when a draft reject is missing its reason */}
      {pendingReason ? (
        <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-900 dark:text-amber-100">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {l10n("local.reason_needed_e2d71a28")}</span>
      ) : null}
      <div
        className="flex items-center gap-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.decided}
        aria-label={l10n("local.value_of_value_decided_d95cde7c", {v0: (progress.decided), v1: (progress.total)})}
      >
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
          {progress.decided} {l10n("local.of_28391d3b")}{" "}{progress.total} {l10n("local.decided_8d3c6686")}</span>
      </div>
    </div>
  );
}

export function IssueThreadInteractionCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  primaryActionOnRight,
  onSubmitInteractionVerdicts,
  onUploadImage,
  externalReferences,
}: IssueThreadInteractionCardProps) {
  // Single enforcement point (PAP-424, plan from PAP-420; extended by PAP-437):
  // a card that should never be drawn — a degenerate `ask_user_questions`
  // (placeholder junk like the onboarding `Test / A` card, no genuine question)
  // or a stale sibling the server auto-expired when its creator posted a newer
  // question (`superseded_by_newer_interaction`). Every render site (both thread
  // backbones + the attention resolver) routes through this component, so
  // suppressing here suppresses it everywhere at once. The interaction is still
  // created and stored server-side; only the render is suppressed. Composition
  // sites additionally filter it so no empty slot lingers.
  if (shouldHideInteractionCard(interaction)) return null;
  const isPlan = isPlanConfirmation(interaction);
  const isToolAction =
    interaction.kind === "request_confirmation" && isToolActionConfirmation(interaction);
  const isSecretProposal =
    interaction.kind === "request_confirmation" && isSecretProposalConfirmation(interaction);
  const connectionAuthorization = connectionAuthorizationPayload(interaction);
  const isConnectionAddressee =
    connectionAuthorization && interaction.kind === "request_confirmation"
      ? isConnectionAuthorizationAddressee({ interaction, currentUserId })
      : false;
  const connectionAuthorizationState =
    connectionAuthorization && interaction.kind === "request_confirmation"
      ? connectionAuthorizationCardState({ interaction, isAddressee: isConnectionAddressee })
      : null;
  const toolActionState =
    isToolAction && interaction.kind === "request_confirmation"
      ? toolActionCardState(interaction)
      : null;
  const toolActionStyles = toolActionState ? toolActionStatusClasses(toolActionState) : null;
  const secretProposalState =
    isSecretProposal && interaction.kind === "request_confirmation"
      ? secretProposalCardState(interaction)
      : null;
  const secretProposalStyles = secretProposalState
    ? secretProposalStatusClasses(secretProposalState)
    : null;
  const resumeFailure = requestConfirmationResumeFailure(interaction);
  const planStyles = isPlan
    ? planStatusClasses(
        interaction.status,
        resumeFailure,
        interaction.result && "outcome" in interaction.result ? interaction.result.outcome : null,
      )
    : null;
  // Interactions can be directed at a specific agent or board user. Resolved
  // before the status styling because the connection-authorization badge names
  // the addressee ("Waiting for Carol").
  const addresseeLabel = interaction.addresseeAgentId || interaction.addresseeUserId
    ? resolveActorLabel({
        agentId: interaction.addresseeAgentId,
        userId: interaction.addresseeUserId,
        agentMap,
        currentUserId,
        userLabelMap,
      })
    : null;
  const connectionAuthorizationStyles = connectionAuthorization && connectionAuthorizationState
    ? connectionAuthorizationStatusClasses(connectionAuthorizationState, {
        providerName: connectionAuthorization.providerName,
        addresseeLabel: addresseeLabel ?? "the addressed person",
      })
    : null;
  const activeStyles =
    connectionAuthorizationStyles ?? secretProposalStyles ?? toolActionStyles ?? planStyles;
  const adminOutcome = getAdministrativeOutcome(interaction);
  const adminReason = adminOutcome ? getAdministrativeReason(interaction) : null;
  // P4 (design review R2): a withdrawal is a neutral administrative retraction by
  // the requester — NOT a board "no". It must not inherit the `cancelled` card's
  // rose/red border + XCircle, which is pixel-identical to a rejected plan and
  // mis-signals a denial to anyone scanning the thread. Give withdrawn its own
  // inert lane (sibling to the calm `expired` state): muted border/badge +
  // MinusCircle ("retracted"). This overrides the plan/tool-action/status styling
  // so a withdrawn plan or confirmation reads "closed", not "changes requested".
  const withdrawnStyles =
    adminOutcome === "withdrawn"
      ? { shell: "border-border bg-transparent", badge: "border-border bg-muted/60 text-muted-foreground" }
      : null;
  const StatusIcon = withdrawnStyles
    ? MinusCircle
    : activeStyles
      ? activeStyles.Icon
      : statusIcon(interaction.status);
  const iconSpin = secretProposalStyles?.spin ?? toolActionStyles?.spin ?? false;
  const styles = withdrawnStyles ?? activeStyles ?? statusClasses(interaction.status);
  const createdByLabel = resolveActorLabel({
    agentId: interaction.createdByAgentId,
    userId: interaction.createdByUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const resolvedByLabel =
    interaction.resolvedByAgentId || interaction.resolvedByUserId
      ? resolveActorLabel({
          agentId: interaction.resolvedByAgentId,
          userId: interaction.resolvedByUserId,
          agentMap,
          currentUserId,
          userLabelMap,
        })
      : null;
  // P4: audit-visible distinction between agent and human resolution.
  const resolvedByAgent = Boolean(interaction.resolvedByAgentId);
  // PAP-17280: the effective audience, shown *before* anyone responds so a
  // reader never has to guess whether an open card is waiting on them. Derived
  // from the same server snapshot the resolver routes enforce, so the copy
  // cannot promise a wider audience than the API allows.
  const audience = describeInteractionAudience({
    interaction,
    creatorLabel: createdByLabel,
    addresseeLabel,
  });
  if (isToolAction && interaction.kind === "request_confirmation" && toolActionState) {
    return (
      <InteractionAudienceContext.Provider value={audience}>
        <RequestToolActionCard
          interaction={interaction}
          state={toolActionState}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          externalReferences={externalReferences}
        />
      </InteractionAudienceContext.Provider>
    );
  }
  const statusText =
    adminOutcome === "withdrawn"
      ? l10n("local.withdrawn_00c0b03f")
      : adminOutcome === "issue_closed"
        ? l10n("local.expired_issue_closed_9a128696")
        : activeStyles
          ? activeStyles.label
          : statusLabel(interaction.status);

  return (
    // Every nested subcard resolves the same interaction, so they all explain a
    // denial with the same audience the header states (PAP-17287).
    <InteractionAudienceContext.Provider value={audience}>
      <div className={cn("rounded-lg border p-5 shadow-none", styles.shell)}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="interaction-status-badge"
                className={cn(
                  "inline-flex items-center gap-1 rounded-sm border px-2.5 py-1 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)",
                  styles.badge,
                )}
              >
                <StatusIcon className={cn("h-3.5 w-3.5", iconSpin && "animate-spin")} />
                {isSecretProposal ? (
                  <span className="flex flex-col sm:flex-row sm:items-center sm:gap-1">
                    <span>{l10n("local.secret_binding_c7693628")}</span>
                    <span className="hidden text-current/60 sm:inline">/</span>
                    <span>{statusText}</span>
                  </span>
                ) : connectionAuthorization ? (
                  // One state, in the reader's own terms: "Action required",
                  // "Waiting for Carol", "Gmail connected". The interaction kind
                  // is machinery the person being asked does not need.
                  <span>{statusText}</span>
                ) : (
                  <>
                    {isPlan ? l10n("local.plan_fa8ed0bd") : interactionKindLabel(interaction.kind)}
                    <span className="text-current/60">/</span>
                    {statusText}
                  </>
                )}
              </span>
              {addresseeLabel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="gap-1"
                      data-testid="interaction-addressee-badge"
                    >
                      <Bot className="h-3 w-3" />
                      {l10n("local.for_ca15ebc0")}{" "}{addresseeLabel}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    {l10n("local.directed_to_0180ad83")}{" "}{addresseeLabel}{l10n("local._agent_addressed_interactions_are_owned_by_th_6aabcb21")}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <div className="mt-3 text-lg font-bold text-foreground">
              {interaction.title
                ?? (interaction.kind === "suggest_tasks"
                  ? l10n("local.suggested_task_tree_76731895")
                  : interaction.kind === "ask_user_questions"
                    // Only a human-only card is genuinely "for the operator";
                    // an open card is answerable by any teammate (PAP-17280).
                    ? interaction.payload.title
                      ?? (audience.policy === "human_only"
                        ? l10n("local.questions_for_the_operator_09c5a86e")
                        : l10n("local.questions_to_answer_9b3aa958"))
                  : interaction.kind === "request_checkbox_confirmation"
                    ? l10n("local.checkbox_confirmation_requested_afc8475c")
                    : isSecretProposal
                      ? l10n("local.secret_binding_requested_c2a0831b")
                    : connectionAuthorization
                      ? l10n("local.connect_your_value_to_continue_d0ded5fa", {v0: (connectionAuthorization.providerName)})
                    : isToolAction
                      ? l10n("local.tool_approval_requested_76497c62")
                      : interaction.kind === "request_item_verdicts"
                        ? l10n("local.review_these_items_2309d930")
                        : isPlan
                          ? l10n("local.plan_review_649e8b22")
                          : l10n("local.confirmation_requested_92e16918"))}
            </div>
            {/* A connection-authorization card composes its own single body
                below, because the closing sentence depends on whether the
                reader is the person who may consent. Rendering the summary here
                as well would be the second body PAP-17859 removed. */}
            {interaction.summary && !connectionAuthorization && interaction.kind !== "connection_intent" ? (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {interaction.summary}
              </p>
            ) : null}
            {interaction.status === "pending" ? (
              <InteractionAudienceLine audience={audience} className="mt-3" />
            ) : null}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-sm border border-border/70 bg-transparent px-3 py-2 text-right text-xs text-muted-foreground">
                <div className="font-medium text-foreground">{formatShortDate(interaction.createdAt)}</div>
                <div>{l10n("local.proposed_by_7d35fa87")}{" "}{createdByLabel}</div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {l10n("local.created_d70b9e24")}{" "}{formatDateTime(interaction.createdAt)}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mt-5">
          {interaction.kind === "suggest_tasks" ? (
            <SuggestTasksCard
              interaction={interaction}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
            />
          ) : interaction.kind === "ask_user_questions" ? (
            <AskUserQuestionsCard
              interaction={interaction}
              onSubmitInteractionAnswers={onSubmitInteractionAnswers}
              onCancelInteraction={onCancelInteraction}
              externalReferences={externalReferences}
            />
          ) : interaction.kind === "request_checkbox_confirmation" ? (
            <RequestCheckboxConfirmationCard
              interaction={interaction}
              primaryActionOnRight={primaryActionOnRight}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
              externalReferences={externalReferences}
            />
          ) : connectionAuthorization
            && interaction.kind === "request_confirmation"
            && connectionAuthorizationState ? (
            <RequestConnectionAuthorizationCard
              interaction={interaction}
              state={connectionAuthorizationState}
              isAddressee={isConnectionAddressee}
              providerName={connectionAuthorization.providerName}
              addresseeLabel={addresseeLabel ?? l10n("local.the_addressed_person_2d03804d")}
              requestingAgentLabel={connectionAuthorization.requestingAgentName ?? null}
              resolvedByLabel={resolvedByLabel}
              resolvedByAgent={resolvedByAgent}
              onRejectInteraction={onRejectInteraction}
            />
          ) : isSecretProposal && interaction.kind === "request_confirmation" && secretProposalState ? (
            <RequestSecretProposalCard
              interaction={interaction}
              state={secretProposalState}
              resolvedByLabel={resolvedByLabel}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
            />
          ) : interaction.kind === "connection_intent" ? (
            <ConnectionIntentInteractionBody
              interaction={interaction}
              currentUserId={currentUserId}
              addresseeLabel={addresseeLabel ?? l10n("local.the_addressed_person_2d03804d")}
            />
          ) : interaction.kind === "request_item_verdicts" ? (
            <RequestItemVerdictsCard
              interaction={interaction}
              onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
              externalReferences={externalReferences}
            />
          ) : (
            <RequestConfirmationCard
              interaction={interaction}
              isPlan={isPlan}
              primaryActionOnRight={primaryActionOnRight}
              onAcceptInteraction={onAcceptInteraction}
              onRejectInteraction={onRejectInteraction}
              onUploadImage={onUploadImage}
              externalReferences={externalReferences}
            />
          )}
        </div>

        {adminOutcome === "withdrawn" ? (
          <div
            className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-withdrawn-footer"
          >
            <div>
              {l10n("local.withdrawn_by_305109dc")}{" "}
              <span className="font-medium text-foreground">{resolvedByLabel ?? l10n("local.an_agent_647936ec")}</span>
              {resolvedByAgent ? <ResolvedByAgentChip /> : null}
              {interaction.resolvedAt ? (" " + l10n("local.on_value_dc137047", {v0: (formatShortDate(interaction.resolvedAt))})) : ""}
            </div>
            {adminReason ? (
              <div className="mt-1 italic text-muted-foreground/90">"{adminReason}"</div>
            ) : null}
          </div>
        ) : adminOutcome === "issue_closed" && interaction.resolvedAt ? (
          // The header badge + body already explain the issue-closed expiry;
          // the footer is just the audit timestamp.
          <div
            className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-issue-closed-footer"
          >
            {formatShortDate(interaction.resolvedAt)}
          </div>
        ) : resolvedByLabel && !isToolAction && !connectionAuthorization ? (
          // The connection-authorization card states its own resolver and
          // timestamp inside the "Gmail connected" block, so the shared footer
          // would repeat it.
          <div
            className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border/60 pt-3 text-xs text-muted-foreground"
            data-testid="interaction-resolved-footer"
          >
            {l10n("local.resolved_by_f266c7ec")}{" "}<span className="font-medium text-foreground">{resolvedByLabel}</span>
            {resolvedByAgent ? <ResolvedByAgentChip /> : null}
            {interaction.resolvedAt ? (" " + l10n("local.on_value_dc137047", {v0: (formatShortDate(interaction.resolvedAt))})) : ""}
          </div>
        ) : null}
      </div>
    </InteractionAudienceContext.Provider>
  );
}

/**
 * Small audit chip marking that an interaction was resolved by an agent (rather
 * than a human board member) — governed agent resolution introduced in P2.
 */
function ResolvedByAgentChip() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="ml-1 gap-1 border-indigo-500/50 py-0 text-[length:--text-micro] text-indigo-700 dark:text-indigo-200"
          data-testid="interaction-resolved-by-agent-chip"
        >
          <Bot className="h-3 w-3" />
          {l10n("local.agent_11b39c93")}</Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs">
        {l10n("local.resolved_by_an_agent_under_the_organization_s_a511fb10")}</TooltipContent>
    </Tooltip>
  );
}
