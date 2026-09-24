import { l10n } from "../../i18n";
/**
 * Canonical state inventory for the chat-style task thread (the default task
 * view; the classic legacy view sits behind enableClassicTaskInterface).
 *
 * This list is the single source of truth for:
 *   - the dev harness state switcher (/dev/task-chat-lab), and
 *   - the finish-line test that asserts every state renders without error.
 *
 * Each id traces to a real agent-protocol state (plan Deliverable 1). `tier`
 * marks whether the state already streams live ("live") or is emitted upstream
 * but dropped by acpx today ("tier-b", driven by synthetic events in the
 * harness, live wiring flagged). `surface` says where the state renders.
 */

export const TASK_CHAT_STATES = [
  "session-start",
  "human-message",
  "agent-message",
  "thinking",
  "responding",
  "responding-burst",
  "tool-call",
  "diff",
  "working",
  "running",
  "completed",
  "activity-phases",
  "awaiting-approval",
  "plan-todo",
  "interrupted",
  "refused",
  "truncated",
  "live-token-cost",
] as const;

export type TaskChatStateId = (typeof TASK_CHAT_STATES)[number];

export type TaskChatStateTier = "live" | "tier-b";
export type TaskChatStateSurface = "thread" | "plan";

export interface TaskChatStateMeta {
  id: TaskChatStateId;
  label: string;
  tier: TaskChatStateTier;
  surface: TaskChatStateSurface;
  /** Real protocol source, quoted for the harness inspector. */
  protocol: string;
}

export const TASK_CHAT_STATE_META: Record<TaskChatStateId, TaskChatStateMeta> = {
  "session-start": {
    id: "session-start",
    label: l10n("local.session_start_6f269d14"),
    tier: "live",
    surface: "thread",
    protocol: 'acpx.session → TranscriptEntry kind:"init"',
  },
  "human-message": {
    id: "human-message",
    label: l10n("local.human_message_e9b8caed"),
    tier: "live",
    surface: "thread",
    protocol: 'IssueComment authorType:"user"',
  },
  "agent-message": {
    id: "agent-message",
    label: l10n("local.final_response_e34cfffa"),
    tier: "live",
    surface: "thread",
    protocol: 'PRP item.delta kind:"agentMessage" channel:"final"',
  },
  thinking: {
    id: "thinking",
    label: l10n("local.thinking_a20d12c5"),
    tier: "live",
    surface: "thread",
    protocol: "text_delta stream:thought (ACP agent_thought_chunk)",
  },
  responding: {
    id: "responding",
    label: l10n("local.progress_update_streaming_f30914fc"),
    tier: "live",
    surface: "thread",
    protocol: 'PRP item.delta kind:"agentMessage" channel:"progress"',
  },
  "responding-burst": {
    id: "responding-burst",
    label: l10n("local.progress_update_burst_df7d4b71"),
    tier: "live",
    surface: "thread",
    protocol: "text_delta stream:output ×N, tool calls between (PAP-368 dwell)",
  },
  "tool-call": {
    id: "tool-call",
    label: l10n("local.tool_call_17011048"),
    tier: "live",
    surface: "thread",
    protocol: "acpx.tool_call (ACP tool_call / tool_call_update)",
  },
  diff: {
    id: "diff",
    label: l10n("local.diff_7ecf4628"),
    tier: "live",
    surface: "thread",
    protocol: 'ToolCallContent type:"diff" → TranscriptEntry kind:"diff"',
  },
  working: {
    id: "working",
    label: l10n("local.working_a92f0449"),
    tier: "live",
    surface: "thread",
    protocol: "heartbeat.run.progress + acpx.status",
  },
  running: {
    id: "running",
    label: l10n("local.running_f4ccae29"),
    tier: "live",
    surface: "thread",
    protocol: 'message.status.type === "running"',
  },
  completed: {
    id: "completed",
    label: l10n("local.completed_collapsed_12b8d2f9"),
    tier: "live",
    surface: "thread",
    protocol: "acpx.result (StopReason in subtype)",
  },
  "activity-phases": {
    id: "activity-phases",
    label: l10n("local.long_run_activity_phases_c6fe5bd6"),
    tier: "live",
    surface: "thread",
    protocol: "assistant boundaries + chronological tool calls",
  },
  "awaiting-approval": {
    id: "awaiting-approval",
    label: l10n("local.awaiting_approval_ae25c9b1"),
    tier: "tier-b",
    surface: "thread",
    protocol: "ACP RequestPermissionRequest + PermissionOptionKind",
  },
  "plan-todo": {
    id: "plan-todo",
    label: l10n("local.plan_todo_3e891e27"),
    tier: "tier-b",
    surface: "plan",
    protocol: "ACP Plan { entries: PlanEntry[] }, PlanEntryStatus",
  },
  interrupted: {
    id: "interrupted",
    label: l10n("local.interrupted_132d124d"),
    tier: "tier-b",
    surface: "thread",
    protocol: 'AcpRuntimeTurnResult.status:"cancelled" / StopReason "cancelled"',
  },
  refused: {
    id: "refused",
    label: l10n("local.refused_66b87354"),
    tier: "tier-b",
    surface: "thread",
    protocol: 'StopReason "refusal"',
  },
  truncated: {
    id: "truncated",
    label: l10n("local.truncated_d9d9fcf3"),
    tier: "tier-b",
    surface: "thread",
    protocol: 'StopReason "max_tokens" | "max_turn_requests"',
  },
  "live-token-cost": {
    id: "live-token-cost",
    label: l10n("local.live_token_cost_5bbaf785"),
    tier: "tier-b",
    surface: "thread",
    protocol: "ACP UsageUpdate { used, size, cost }",
  },
};

export const TASK_CHAT_STATE_LIST: TaskChatStateMeta[] = TASK_CHAT_STATES.map(
  (id) => TASK_CHAT_STATE_META[id],
);
