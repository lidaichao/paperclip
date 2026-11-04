import type { Agent, FeedbackVote } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { InlineEntityOption } from "../components/InlineEntitySelector";
import type { MentionOption } from "../components/MarkdownEditor";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";
import { l10n } from "../i18n";

function createAgent(
  id: string,
  name: string,
  icon: string,
  urlKey: string,
): Agent {
  const now = new Date("2026-04-06T12:00:00.000Z");
  return {
    id,
    companyId: "company-ux",
    name,
    urlKey,
    role: "engineer",
    title: null,
    icon,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
  };
}

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const merged: IssueChatComment = {
    id: "comment-default",
    companyId: "company-ux",
    issueId: "issue-ux",
    authorType: overrides.authorAgentId ? "agent" : "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
  return merged;
}

const primaryAgent = createAgent("agent-1", "CodexCoder", "code", "codexcoder");
const reviewAgent = createAgent("agent-2", "ClaudeFixer", "sparkles", "claudefixer");

export const issueChatUxAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewAgent.id, reviewAgent],
]);

export const issueChatUxMentions: MentionOption[] = [
  {
    id: "mention-agent-1",
    name: primaryAgent.name,
    kind: "agent",
    agentId: primaryAgent.id,
    agentIcon: primaryAgent.icon,
  },
  {
    id: "mention-agent-2",
    name: reviewAgent.name,
    kind: "agent",
    agentId: reviewAgent.id,
    agentIcon: reviewAgent.icon,
  },
  {
    id: "mention-project-1",
    name: l10n("local.alice_board_ui_10300747"),
    kind: "project",
    projectId: "project-1",
    projectColor: "#0f766e",
  },
];

export const issueChatUxReassignOptions: InlineEntityOption[] = [
  {
    id: `agent:${primaryAgent.id}`,
    label: primaryAgent.name,
    searchText: `${primaryAgent.name} codex engineer`,
  },
  {
    id: `agent:${reviewAgent.id}`,
    label: reviewAgent.name,
    searchText: `${reviewAgent.name} claude reviewer`,
  },
  {
    id: "user:user-1",
    label: l10n("local.board_859169b3"),
    searchText: "board user",
  },
];

export const issueChatUxLiveComments: IssueChatComment[] = [
  createComment({
    id: "comment-live-user",
    body: l10n("local.ship_issue_page_as_real_chat_10300748"),
    createdAt: new Date("2026-04-06T11:55:00.000Z"),
    updatedAt: new Date("2026-04-06T11:55:00.000Z"),
  }),
  createComment({
    id: "comment-live-agent",
    authorAgentId: primaryAgent.id,
    authorUserId: null,
    body: l10n("local.swapped_comment_stack_for_assistant_thread_10300749"),
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    runId: "run-history-1",
    runAgentId: primaryAgent.id,
  }),
  createComment({
    id: "comment-live-queued",
    body: l10n("local.make_dedicated_chat_review_page_10300750"),
    createdAt: new Date("2026-04-06T12:05:30.000Z"),
    updatedAt: new Date("2026-04-06T12:05:30.000Z"),
    clientId: "client-queued-1",
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: "run-live-1",
  }),
];

export const issueChatUxLiveEvents: IssueTimelineEvent[] = [
  {
    id: "event-live-1",
    createdAt: new Date("2026-04-06T11:54:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    statusChange: {
      from: "done",
      to: "todo",
    },
  },
  {
    id: "event-live-2",
    createdAt: new Date("2026-04-06T11:54:30.000Z"),
    actorType: "user",
    actorId: "user-1",
    assigneeChange: {
      from: { agentId: null, userId: null },
      to: { agentId: primaryAgent.id, userId: null },
    },
  },
];

export const issueChatUxLiveRuns: LiveRunForIssue[] = [
  {
    id: "run-live-1",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: "2026-04-06T12:04:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-06T12:04:00.000Z",
    agentId: primaryAgent.id,
    agentName: primaryAgent.name,
    adapterType: "codex_local",
    issueId: "issue-ux",
  },
];

export const issueChatUxLinkedRuns: IssueChatLinkedRun[] = [
  {
    runId: "run-history-1",
    status: "succeeded",
    agentId: primaryAgent.id,
    createdAt: new Date("2026-04-06T11:58:00.000Z"),
    startedAt: new Date("2026-04-06T11:58:00.000Z"),
    finishedAt: new Date("2026-04-06T12:00:00.000Z"),
  },
  {
    runId: "run-review-1",
    status: "failed",
    agentId: reviewAgent.id,
    createdAt: new Date("2026-04-06T12:31:00.000Z"),
    startedAt: new Date("2026-04-06T12:31:00.000Z"),
    finishedAt: new Date("2026-04-06T12:33:00.000Z"),
  },
];

export const issueChatUxTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>([
  [
    "run-history-1",
    [
      {
        kind: "thinking",
        ts: "2026-04-06T11:58:03.000Z",
        text: l10n("local.reviewing_issue_thread_for_transcript_noise_10300751"),
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T11:58:07.000Z",
        name: "read_file",
        toolUseId: "tool-history-1",
        input: { path: "ui/src/lib/issue-chat-messages.ts" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T11:58:11.000Z",
        toolUseId: "tool-history-1",
        content: l10n("local.found_run_projection_path_10300752"),
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-04-06T11:59:24.000Z",
        text: l10n("local.kept_completed_run_context_attached_10300753"),
      },
    ],
  ],
  [
    "run-live-1",
    [
      {
        kind: "assistant",
        ts: "2026-04-06T12:04:02.000Z",
        text: l10n("local.reshaping_issue_page_as_conversation_10300754"),
      },
      {
        kind: "thinking",
        ts: "2026-04-06T12:04:05.000Z",
        text: l10n("local.need_remove_internal_scrollbox_10300755"),
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:04:08.000Z",
        name: "read_file",
        toolUseId: "tool-read-1",
        input: { path: "ui/src/components/IssueChatThread.tsx" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:04:11.000Z",
        toolUseId: "tool-read-1",
        content: l10n("local.loaded_chat_surface_found_viewport_constraint_10300756"),
        isError: false,
      },
      {
        kind: "tool_call",
        ts: "2026-04-06T12:04:14.000Z",
        name: "apply_patch",
        toolUseId: "tool-edit-1",
        input: {
          file: "ui/src/components/IssueChatThread.tsx",
          action: l10n("local.remove_scroll_pane_10300757"),
        },
      },
      {
        kind: "tool_result",
        ts: "2026-04-06T12:04:22.000Z",
        toolUseId: "tool-edit-1",
        content: l10n("local.updated_layout_classes_page_scrolling_10300758"),
        isError: false,
      },
      {
        kind: "stderr",
        ts: "2026-04-06T12:04:24.000Z",
        text: l10n("local.vite_warmup_rebuilding_route_chunks_10300759"),
      },
    ],
  ],
]);

export const issueChatUxSubmittingComments: IssueChatComment[] = [
  createComment({
    id: "comment-submitting-user-settled",
    body: l10n("local.let_me_know_thread_layout_locked_10300760"),
    createdAt: new Date("2026-04-06T12:40:00.000Z"),
    updatedAt: new Date("2026-04-06T12:40:00.000Z"),
  }),
  createComment({
    id: "comment-submitting-pending",
    body: l10n("local.looks_good_ship_when_ready_10300761"),
    createdAt: new Date("2026-04-06T12:42:00.000Z"),
    updatedAt: new Date("2026-04-06T12:42:00.000Z"),
    clientId: "client-pending-1",
    clientStatus: "pending",
  }),
];

export const issueChatUxReviewComments: IssueChatComment[] = [
  createComment({
    id: "comment-review-user",
    body: l10n("local.tighten_spacing_keep_composer_grounded_10300762"),
    createdAt: new Date("2026-04-06T12:28:00.000Z"),
    updatedAt: new Date("2026-04-06T12:28:00.000Z"),
  }),
  createComment({
    id: "comment-review-agent",
    authorAgentId: reviewAgent.id,
    authorUserId: null,
    body: [
      l10n("local.adjusted_treatment_product_conversation_10300763"),
      "",
      l10n("local.removed_count_from_heading_10300764"),
      l10n("local.let_page_own_scrolling_10300765"),
      l10n("local.added_dedicated_chat_review_page_10300766"),
    ].join("\n"),
    createdAt: new Date("2026-04-06T12:34:00.000Z"),
    updatedAt: new Date("2026-04-06T12:34:00.000Z"),
    runId: "run-review-1",
    runAgentId: reviewAgent.id,
  }),
  createComment({
    id: "comment-review-user-followup",
    body: l10n("local.want_empty_and_blocked_composer_states_10300767"),
    createdAt: new Date("2026-04-06T12:36:00.000Z"),
    updatedAt: new Date("2026-04-06T12:36:00.000Z"),
  }),
];

export const issueChatUxReviewEvents: IssueTimelineEvent[] = [
  {
    id: "event-review-1",
    createdAt: new Date("2026-04-06T12:27:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    assigneeChange: {
      from: { agentId: primaryAgent.id, userId: null },
      to: { agentId: reviewAgent.id, userId: null },
    },
  },
];

export const issueChatUxFeedbackVotes: FeedbackVote[] = [
  {
    id: "feedback-1",
    companyId: "company-ux",
    issueId: "issue-ux",
    targetType: "issue_comment",
    targetId: "comment-review-agent",
    authorUserId: "user-1",
    vote: "up",
    reason: null,
    sharedWithLabs: false,
    sharedAt: null,
    consentVersion: null,
    redactionSummary: null,
    createdAt: new Date("2026-04-06T12:35:00.000Z"),
    updatedAt: new Date("2026-04-06T12:35:00.000Z"),
  },
];
