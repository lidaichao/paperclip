import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";
import { l10n } from "../i18n";

export const LONG_THREAD_COMMENT_COUNT = 469;
export const LONG_THREAD_MARKDOWN_COMMENT_COUNT = 150;
export const LONG_THREAD_EVENT_COUNT = 12;
export const LONG_THREAD_LINKED_RUN_COUNT = 6;

const baseTime = new Date("2026-04-28T14:00:00.000Z").getTime();

function atMinute(offset: number) {
  return new Date(baseTime + offset * 60_000);
}

function createAgent(id: string, name: string, icon: string, urlKey: string): Agent {
  const now = new Date("2026-04-28T14:00:00.000Z");
  return {
    id,
    companyId: "company-long-thread",
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

const primaryAgent = createAgent("agent-perf-codex", "CodexCoder", "code", "codexcoder");
const reviewerAgent = createAgent("agent-perf-reviewer", "ReviewBot", "sparkles", "reviewbot");

export const issueChatLongThreadAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewerAgent.id, reviewerAgent],
]);

function markdownBody(index: number) {
  return [
    `## ${l10n("local.baseline_note_10300827", { number: index })}`,
    "",
    l10n("local.long_thread_markdown_row_10300828", { identifier: `PAP-${2600 + index}` }),
    "",
    `- ${l10n("local.parsed_checklist_inline_code_10300829")}`,
    `- ${l10n("local.parsed_checklist_rich_text_10300830")}`,
    `- ${l10n("local.parsed_checklist_alice_link_10300831")}`,
    "",
    `| ${l10n("local.metric_10300832")} | ${l10n("local.value_10300833")} |`,
    "| --- | ---: |",
    `| ${l10n("local.fixture_row_10300834")} | ${index} |`,
    `| ${l10n("local.synthetic_tokens_10300835")} | ${1200 + index} |`,
    "",
    "```ts",
    `const fixtureRow${index} = { markdown: true, deterministic: true };`,
    "```",
  ].join("\n");
}

function plainUserBody(index: number) {
  return l10n("local.board_checkpoint_long_thread_10300836", { number: index });
}

function plainAssistantBody(index: number) {
  return l10n("local.processed_checkpoint_long_thread_10300837", { number: index });
}

function createComment(index: number): IssueChatComment {
  const isMarkdown = index < LONG_THREAD_MARKDOWN_COMMENT_COUNT;
  const isAssistant = isMarkdown || index % 4 === 1 || index % 4 === 2;
  const authorAgentId = isAssistant
    ? (index % 7 === 0 ? reviewerAgent.id : primaryAgent.id)
    : null;

  return {
    id: `long-thread-comment-${String(index + 1).padStart(3, "0")}`,
    companyId: "company-long-thread",
    issueId: "issue-long-thread",
    authorType: authorAgentId ? "agent" : "user",
    authorAgentId,
    authorUserId: authorAgentId ? null : "user-board",
    body: isMarkdown
      ? markdownBody(index + 1)
      : authorAgentId
        ? plainAssistantBody(index + 1)
        : plainUserBody(index + 1),
    presentation: null,
    metadata: null,
    createdAt: atMinute(index),
    updatedAt: atMinute(index),
  };
}

export const issueChatLongThreadComments: IssueChatComment[] = Array.from(
  { length: LONG_THREAD_COMMENT_COUNT },
  (_, index) => createComment(index),
);

export const issueChatLongThreadMarkdownCommentIds = new Set(
  issueChatLongThreadComments
    .slice(0, LONG_THREAD_MARKDOWN_COMMENT_COUNT)
    .map((comment) => comment.id),
);

export const issueChatLongThreadEvents: IssueTimelineEvent[] = Array.from(
  { length: LONG_THREAD_EVENT_COUNT },
  (_, index) => ({
    id: `long-thread-event-${index + 1}`,
    createdAt: atMinute(index * 36 + 18),
    actorType: index % 3 === 0 ? "user" : "agent",
    actorId: index % 3 === 0 ? "user-board" : primaryAgent.id,
    statusChange: index % 2 === 0
      ? { from: index === 0 ? "todo" : "in_progress", to: "in_progress" }
      : undefined,
    assigneeChange: index % 2 === 1
      ? {
          from: { agentId: null, userId: null },
          to: { agentId: index % 4 === 1 ? primaryAgent.id : reviewerAgent.id, userId: null },
        }
      : undefined,
  }),
);

export const issueChatLongThreadLinkedRuns: IssueChatLinkedRun[] = Array.from(
  { length: LONG_THREAD_LINKED_RUN_COUNT },
  (_, index) => ({
    runId: `long-thread-run-${index + 1}`,
    status: index % 3 === 0 ? "failed" : index % 3 === 1 ? "timed_out" : "succeeded",
    agentId: index % 2 === 0 ? primaryAgent.id : reviewerAgent.id,
    agentName: index % 2 === 0 ? primaryAgent.name : reviewerAgent.name,
    adapterType: "codex_local",
    createdAt: atMinute(index * 72 + 12),
    startedAt: atMinute(index * 72 + 12),
    finishedAt: atMinute(index * 72 + 16),
    hasStoredOutput: true,
  }),
);

export const issueChatLongThreadLiveRuns: LiveRunForIssue[] = [];

export const issueChatLongThreadTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>(
  issueChatLongThreadLinkedRuns.map((run, index) => [
    run.runId,
    [
      {
        kind: "thinking",
        ts: atMinute(index * 72 + 13).toISOString(),
        text: l10n("local.inspecting_long_thread_segment_10300838", { number: index + 1 }),
      },
      {
        kind: "tool_call",
        ts: atMinute(index * 72 + 14).toISOString(),
        name: "read_file",
        toolUseId: `long-thread-tool-${index + 1}`,
        input: { path: "ui/src/components/IssueChatThread.tsx" },
      },
      {
        kind: "tool_result",
        ts: atMinute(index * 72 + 15).toISOString(),
        toolUseId: `long-thread-tool-${index + 1}`,
        content: l10n("local.confirmed_direct_render_fixture_10300839"),
        isError: run.status !== "succeeded",
      },
      {
        kind: "assistant",
        ts: atMinute(index * 72 + 16).toISOString(),
        text: l10n("local.run_produced_compact_transcript_10300840", { number: index + 1 }),
      },
    ],
  ]),
);

export const issueChatLongThreadFixtureContext = {
  issue: {
    identifier: "PAP-PERF",
    title: l10n("local.long_thread_rendering_fixture_10300841"),
    status: "in_progress",
    priority: "medium",
    projectName: "Alice",
  },
  documents: [
    l10n("local.implementation_plan_10300842"),
    l10n("local.profiler_notes_10300843"),
    l10n("local.release_checklist_10300844"),
    l10n("local.qa_readout_10300845"),
  ],
  subIssues: [
    l10n("local.long_thread_phase_one_10300846"),
    l10n("local.long_thread_phase_two_10300847"),
    l10n("local.long_thread_phase_three_10300848"),
    l10n("local.long_thread_phase_four_10300849"),
  ],
  sidebarStats: [
    [l10n("local.comments_10300850"), String(LONG_THREAD_COMMENT_COUNT)],
    [l10n("local.markdown_bodies_10300851"), String(LONG_THREAD_MARKDOWN_COMMENT_COUNT)],
    [l10n("local.timeline_events_10300852"), String(LONG_THREAD_EVENT_COUNT)],
    [l10n("local.linked_runs_10300853"), String(LONG_THREAD_LINKED_RUN_COUNT)],
  ],
} as const;
