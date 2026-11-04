import { l10n } from "../../i18n";
/**
 * Synthetic fixtures for the Task Chat Redesign dev harness. No live agent is
 * required: every state in the inventory maps to a deterministic scenario the
 * harness renders and the finish-line test iterates. Tier-B states are driven
 * entirely from here (live protocol wiring is a flagged dependency).
 */
import type { TaskChatItem, TaskChatPlan } from "./task-chat-model";
import type { TaskChatStateId } from "./task-chat-states";

export interface TaskChatScenario {
  surface: "thread" | "plan";
  items: TaskChatItem[];
  plan?: TaskChatPlan;
}

const AGENT = "Atlas";

/** A short human→agent exchange used as context in several scenarios. */
function exchangePrefix(): TaskChatItem[] {
  return [
    { id: "m-user-1", kind: "message", author: "human", text: l10n("local.add_rate_limiter_to_login_route_10301036"), timestamp: "14:31" },
  ];
}

const SAMPLE_PLAN: TaskChatPlan = {
  revision: 2,
  updatedAt: "14:33",
  entries: [
    { id: "p1", content: l10n("local.read_login_route_existing_middleware_10301037"), status: "completed", priority: "medium" },
    { id: "p2", content: l10n("local.add_token_bucket_rate_limiter_util_10301038"), status: "in_progress", priority: "high" },
    { id: "p3", content: l10n("local.wire_limiter_into_post_login_10301039"), status: "pending", priority: "high" },
    { id: "p4", content: l10n("local.add_tests_limit_reset_window_10301040"), status: "pending", priority: "low" },
  ],
};

export function buildScenario(id: TaskChatStateId): TaskChatScenario {
  switch (id) {
    case "session-start":
      return {
        surface: "thread",
        items: [
          { id: "mk-start", kind: "marker", variant: "session_start", label: l10n("local.session_started_a6a7c4b6"), detail: l10n("local.claude_auto_mode_10301062") },
          ...exchangePrefix(),
        ],
      };
    case "human-message":
      return { surface: "thread", items: exchangePrefix() };
    case "agent-message":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "m-agent-1", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", text: l10n("local.on_it_add_token_bucket_limiter_10301041"), timestamp: "14:31" },
        ],
      };
    case "thinking":
      // The surviving thinking signal (PAP-361): the live line's "Thinking…"
      // state — Brain icon + shimmer on the pill. Thinking rows no longer
      // render in the thread or nest under turns.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-thinking",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: { id: "st-thinking", kind: "status", status: "running", label: l10n("local.thinking_a20d12c5"), startedAtMs: Date.now() - 6100, tokens: { used: 18240, size: 200000 } },
            items: [
              { id: "th-grep", kind: "tool", name: "Grep", target: "rateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "responding":
      // A streaming interstitial update gets its own row directly above the
      // status line (PAP-361, amended): it wraps into the 1lh viewport
      // line-scroll while the gerund rotation below runs uninterrupted.
      // Ephemeral — when it finishes, the row slides out and the text renders
      // nowhere.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-responding",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: {
              id: "st-responding", kind: "status", status: "running", label: l10n("local.responding_98047c1e"), startedAtMs: Date.now() - 9300, tokens: { used: 18240, size: 200000 },
              selfTalk: l10n("local.found_existing_ip_rate_limit_helper_10301042"),
            },
            items: [
              { id: "resp-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
            ],
          },
        ],
      };
    case "responding-burst":
      // A run emitting several interstitial updates in quick succession
      // (PAP-368): the lab replay streams each blank-line-separated segment as
      // its own update with a short gap between. The pill HOLDS each finished
      // update until the next swaps in, paced by --motion-interstitial-dwell
      // (latest-wins when updates outpace the dwell).
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-responding-burst",
            kind: "turn",
            settled: false,
            summary: { toolCount: 2, added: 0, removed: 0 },
            liveStatus: {
              id: "st-responding-burst", kind: "status", status: "running", label: l10n("local.responding_98047c1e"), startedAtMs: Date.now() - 21400, tokens: { used: 18240, size: 200000 },
              selfTalk: [
                l10n("local.extend_existing_ip_rate_limit_helper_10301043"),
                l10n("local.wire_per_account_token_bucket_10301044"),
                l10n("local.failed_attempts_drain_bucket_twice_10301045"),
                l10n("local.update_login_route_and_add_tests_10301046"),
              ].join("\n\n"),
            },
            items: [
              { id: "burst-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "burst-grep", kind: "tool", name: "Grep", target: "ipRateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "tool-call":
      return {
        surface: "thread",
        items: [
          { id: "tool-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "in_progress" },
        ],
      };
    case "diff":
      return {
        surface: "thread",
        items: [
          {
            id: "tool-diff", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", decision: "allowed",
            diff: {
              path: "server/src/routes/auth.ts", added: 3, removed: 1,
              lines: [
                { kind: "context", text: "router.post('/login', async (req, res) => {" },
                { kind: "remove", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  await rateLimiter.consume(req.body.email);" },
                { kind: "add", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  if (!ok) return res.status(401).end();" },
              ],
            },
          },
        ],
      };
    case "working":
      // Parent-row live turn (PAP-354): the tool-state line owns the activity;
      // expanding nests the chronological history underneath.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-working",
            kind: "turn",
            settled: false,
            summary: { toolCount: 2, added: 0, removed: 0 },
            liveStatus: { id: "st-working", kind: "status", status: "working", label: l10n("local.editing_files_d868fdd0"), detail: "Edit · server/src/routes/auth.ts", toolName: "Edit", startedAtMs: Date.now() - 4200 },
            items: [
              { id: "w-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "w-edit", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "in_progress" },
            ],
          },
        ],
      };
    case "running":
      // Generic label → the parent row header rotates whimsical gerunds.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-running",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: { id: "st-running", kind: "status", status: "running", label: l10n("local.running_f4ccae29"), detail: l10n("local.no_output_for_three_seconds_still_running_10301063"), startedAtMs: Date.now() - 12000, tokens: { used: 18240, size: 200000 } },
            items: [
              { id: "r-grep", kind: "tool", name: "Grep", target: "rateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "completed":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          // Round 9: the settled turn attaches to the final reply bubble — the
          // "✓ Worked · …" summary renders on the bubble's always-visible
          // timestamp line ("2:34 PM · ✓ Worked · 38s · 2 tools").
          {
            id: "m-done",
            kind: "message",
            author: "agent",
            authorName: AGENT,
            agentIcon: "bot",
            text: l10n("local.done_added_token_bucket_limiter_tests_pass_10301047"),
            timestamp: "14:34",
            attachedTurn: {
              id: "turn-done",
              kind: "turn",
              settled: true,
              // "Worked · N tools" expands to exactly the tool rows (PAP-361):
              // toolCount matches the nested rows, no thinking row.
              summary: { durationLabel: l10n("local.duration_38_seconds_10301048"), toolCount: 2, added: 34, removed: 3, tokensLabel: l10n("local.tokens_12_3k_10301049") },
              items: [
                { id: "tool-done-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
                { id: "tool-done-2", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", diff: { path: "server/src/routes/auth.ts", added: 34, removed: 3 } },
              ],
            },
          },
        ],
      };
    case "awaiting-approval":
      return {
        surface: "thread",
        items: [
          {
            id: "st-approval", kind: "status", status: "awaiting_approval", label: l10n("local.approve_running_a_command_7347bea3"),
            detail: l10n("local.npm_run_migrate_modifies_database_10301050"),
            approval: {
              toolName: "execute",
              options: [
                { id: "reject", label: l10n("local.deny_05a2d733"), kind: "reject_once" },
                { id: "allow-always", label: l10n("local.always_allow_977618bd"), kind: "allow_always" },
                { id: "allow", label: l10n("local.allow_once_168511d2"), kind: "allow_once" },
              ],
            },
          },
        ],
      };
    case "activity-phases": {
      const phase = (id: string, text: string | undefined, active: boolean, tools: TaskChatItem[]) => ({
        id,
        kind: "activity_phase" as const,
        active,
        interstitial: text ? { id: `${id}:message`, kind: "message" as const, author: "agent" as const, authorName: AGENT, text, interstitial: true } : undefined,
        items: tools.filter((item): item is Extract<TaskChatItem, { kind: "tool" | "usage" }> => item.kind === "tool" || item.kind === "usage"),
        summary: active
          ? l10n("local.ran_one_command_called_one_tool_10301051")
          : id.endsWith("opening")
            ? l10n("local.called_two_tools_10301052")
            : l10n("local.read_three_files_edited_one_file_10301053"),
      });
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-long-run", kind: "turn", settled: false,
            summary: { toolCount: 8, added: 4, removed: 1 },
            liveStatus: { id: "long-status", kind: "status", status: "working", label: l10n("local.running_tests_6effe77e"), detail: "Bash · vitest", toolName: "Bash", startedAtMs: Date.now() - 48_000 },
            items: [
              phase("phase-opening", undefined, false, [
                { id: "generic-1", kind: "tool", name: "Tool", rawName: "tool call", status: "completed" },
                { id: "generic-2", kind: "tool", name: "Tool", rawName: "acp_tool", status: "failed", detail: l10n("local.adapter_interrupted_10301054") },
              ]),
              phase("phase-read", l10n("local.found_adapter_tracing_render_boundary_10301055"), false, [
                { id: "read-1", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/transcript-adapter.ts" },
                { id: "read-2", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/TaskChatTurn.tsx" },
                { id: "read-3", kind: "tool", name: "Read", status: "completed", target: "ui/src/components/task-chat/TaskChatThreadView.tsx" },
                { id: "edit-1", kind: "tool", name: "Edit", status: "completed", target: "ui/src/components/task-chat/task-chat-model.ts" },
              ]),
              phase("phase-active", l10n("local.grouping_wired_running_checks_10301056"), true, [
                { id: "bash-1", kind: "tool", name: "Bash", status: "in_progress", target: "vitest task-chat" },
                { id: "mcp-1", kind: "tool", name: "Search", rawName: "mcp__docs__search", status: "completed" },
              ]),
            ],
          },
        ],
      };
    }
    case "plan-todo":
      return { surface: "plan", items: [], plan: SAMPLE_PLAN };
    case "interrupted":
      return {
        surface: "thread",
        items: [
          { id: "m-int", kind: "message", author: "agent", authorName: AGENT, text: l10n("local.starting_migration_now_10301057") },
          { id: "mk-int", kind: "marker", variant: "interrupted", label: l10n("local.interrupted_132d124d"), detail: l10n("local.stopped_by_you_at_1435_10301058") },
        ],
      };
    case "refused":
      return {
        surface: "thread",
        items: [
          { id: "st-refused", kind: "status", status: "refused", label: l10n("local.turn_ended_refusal_fb399aa0"), detail: l10n("local.agent_declined_request_10301059") },
        ],
      };
    case "truncated":
      return {
        surface: "thread",
        items: [
          { id: "st-trunc", kind: "status", status: "truncated", label: l10n("local.turn_ended_max_tokens_216e3343"), detail: l10n("local.output_cut_off_continue_to_resume_10301060"), tokens: { used: 199120, size: 200000 } },
        ],
      };
    case "live-token-cost":
      return {
        surface: "thread",
        items: [
          { id: "usage-1", kind: "usage", usage: { used: 42800, size: 200000, inputTokens: 38200, outputTokens: 4600, costUsd: 0.1284 } },
        ],
      };
    default: {
      const _never: never = id;
      return _never;
    }
  }
}
