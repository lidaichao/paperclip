import { l10n } from "../../i18n";
/**
 * Provider-neutral tool vocabulary shared by live status, transcript rows,
 * and canonical provider activity. Exact semantic tools get purpose-specific
 * copy; ACP kinds and normalized name prefixes cover future adapters.
 */
import {
  BookOpen,
  Brain,
  ChevronsLeftRightEllipsis,
  CircleHelp,
  Clock3,
  FilePenLine,
  Image,
  ListChecks,
  MessageSquareReply,
  Network,
  Search,
  SearchCode,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { McpIcon } from "./McpIcon";

/** Lucide icons and hand-rolled SVGs (the MCP logo) share this shape. */
export type ToolIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type ToolFamily =
  | "terminal"
  | "grep"
  | "search"
  | "read"
  | "edit"
  | "web"
  | "plan"
  | "question"
  | "agent"
  | "safety"
  | "image"
  | "wait"
  | "mcp"
  | "other";

export interface ToolTaxonomyEntry {
  family: ToolFamily;
  icon: ToolIcon;
  /** Progressive verb for the status pill, without the trailing ellipsis. */
  verbLabel: string;
}

export type ToolClassificationConfidence = "exact" | "kind" | "inferred" | "fallback" | "unnamed";

export interface ToolActivityPresentationInput {
  name?: string | null;
  transport?: string | null;
  namespace?: string | null;
  /** ACP kind or canonical operation. */
  operation?: string | null;
  target?: string | null;
  progress?: string | null;
}

export interface ToolSummaryGroup {
  key: string;
  singular: string;
  plural: string;
}

export interface ToolActivityPresentation {
  icon: ToolIcon;
  family: ToolFamily;
  runningLabel: string;
  completedLabel: string;
  failedLabel: string;
  interruptedLabel: string;
  displayName: string;
  sourceLabel?: string;
  technicalName?: string;
  confidence: ToolClassificationConfidence;
  summaryGroup: ToolSummaryGroup;
}

/** ACPX's placeholder title must never displace real lifecycle identity. */
const GENERIC_TOOL_NAMES = new Set(["tool", "tool call", "tool_call", "acp_tool"]);

export function isGenericToolName(name: string | undefined | null): boolean {
  const raw = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:pending|in[_ -]?progress|completed|failed|cancelled|canceled)\)$/, "");
  return !raw || GENERIC_TOOL_NAMES.has(raw);
}

interface McpIdentity {
  namespace: string;
  name: string;
}

export function mcpToolIdentity(name: string): McpIdentity | null {
  const doubleUnderscore = name.match(/^mcp__(.+?)__(.+)$/i);
  if (doubleUnderscore) return { namespace: doubleUnderscore[1], name: doubleUnderscore[2] };
  const dotted = name.match(/^mcp\.([^.]+)\.(.+)$/i);
  return dotted ? { namespace: dotted[1], name: dotted[2] } : null;
}

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function sentenceCase(words: readonly string[]): string {
  if (words.length === 0) return "";
  const text = words.map((word) => {
    if (["api", "id", "lsp", "mcp", "pr", "url"].includes(word)) return word.toUpperCase();
    return word;
  }).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function humanizeToolName(name: string | undefined | null): string {
  const raw = (name ?? "").trim();
  if (isGenericToolName(raw)) return l10n("local.unnamed_tool_4e0f07e3");
  const mcp = mcpToolIdentity(raw);
  return sentenceCase(identifierWords(mcp?.name ?? raw));
}

/** Humanized MCP tool segment for both mcp__server__tool and mcp.server.tool. */
export function mcpToolSegment(name: string): string | null {
  const identity = mcpToolIdentity(name);
  return identity ? humanizeToolName(identity.name) : null;
}

type Action =
  | "read" | "list" | "search" | "fetch" | "open" | "update" | "create"
  | "delete" | "move" | "run" | "request" | "post" | "start" | "stop"
  | "wait" | "finish" | "block" | "think" | "switch" | "other";

interface ExactAction {
  action: Action;
  running?: string;
  completed?: string;
  group?: ToolSummaryGroup;
  family?: ToolFamily;
}

const group = (key: string, singular: string, plural: string): ToolSummaryGroup => ({ key, singular, plural });

const toolCopy = (key: string): { running: string; completed: string } => ({
  running: l10n(`local.manual_tool_${key}_running`),
  completed: l10n(`local.manual_tool_${key}_completed`),
});

const localizedGroup = (key: string, copyKey = key): ToolSummaryGroup => group(
  key,
  l10n(`local.manual_tool_group_${copyKey}_singular`),
  l10n(`local.manual_tool_group_${copyKey}_plural`),
);

const EXACT_ACTIONS: Record<string, ExactAction> = {
  bash: { action: "run" },
  terminal: { action: "run" },
  shell: { action: "run" },
  command: { action: "run" },
  run: { action: "run" },
  execute: { action: "run" },
  exec_command: { action: "run" },
  apply_patch: { action: "update", ...toolCopy("apply_patch") },
  read: { action: "read", ...toolCopy("read_file") },
  write: { action: "update", ...toolCopy("write_file") },
  edit: { action: "update", ...toolCopy("edit_file") },
  notebook_read: { action: "read", ...toolCopy("read_notebook") },
  notebook_edit: { action: "update", ...toolCopy("edit_notebook") },
  glob: { action: "search", ...toolCopy("search_files") },
  grep: { action: "search", ...toolCopy("search_file_contents"), family: "grep" },
  tool_search: { action: "search", ...toolCopy("search_tools"), group: localizedGroup("tool_search") },
  web_search: { action: "search", ...toolCopy("search_web"), family: "web" },
  web_fetch: { action: "fetch", ...toolCopy("fetch_web_page"), family: "web" },
  todo_write: { action: "update", ...toolCopy("update_task_list"), family: "plan", group: localizedGroup("task_operation") },
  task_create: { action: "create", ...toolCopy("create_task"), family: "plan", group: localizedGroup("task_operation") },
  task_update: { action: "update", ...toolCopy("update_task"), family: "plan", group: localizedGroup("task_operation") },
  task_list: { action: "list", ...toolCopy("list_tasks"), family: "plan", group: localizedGroup("task_operation") },
  task_get: { action: "read", ...toolCopy("read_task"), family: "plan", group: localizedGroup("task_operation") },
  enter_plan_mode: { action: "switch", ...toolCopy("enter_plan_mode"), family: "plan" },
  exit_plan_mode: { action: "switch", ...toolCopy("exit_plan_mode"), family: "plan" },
  skill: { action: "read", ...toolCopy("load_skill") },
  ask_user_question: { action: "request", ...toolCopy("request_input"), family: "question" },
  request_human_input: { action: "request", ...toolCopy("request_input"), family: "question", group: localizedGroup("task_operation") },
  agent: { action: "start", ...toolCopy("start_subagent"), family: "agent" },
  task: { action: "start", ...toolCopy("start_subagent"), family: "agent" },
  task_output: { action: "read", ...toolCopy("check_subagent_progress"), family: "agent" },
  task_stop: { action: "stop", ...toolCopy("stop_subagent"), family: "agent" },
  send_message: { action: "post", ...toolCopy("message_subagent"), family: "agent" },
  spawn_agent: { action: "start", ...toolCopy("start_subagent"), family: "agent" },
  wait_agent: { action: "wait", ...toolCopy("check_subagent_progress"), family: "agent" },
  wait_threads: { action: "wait", ...toolCopy("check_task_progress"), family: "agent" },
  interrupt_agent: { action: "stop", ...toolCopy("interrupt_subagent"), family: "agent" },
  report_findings: { action: "post", ...toolCopy("report_findings"), family: "safety" },
  guardian_review: { action: "think", ...toolCopy("review_safety"), family: "safety" },
  lsp: { action: "read", ...toolCopy("inspect_code_intelligence") },
  compact_conversation: { action: "think", ...toolCopy("compact_context") },
  image_generation: { action: "create", ...toolCopy("generate_image"), family: "image" },
  view_image: { action: "read", ...toolCopy("view_image"), family: "image" },
  multi_tool_use_parallel: { action: "run", ...toolCopy("run_tools_parallel") },
  get_task_context: { action: "read", ...toolCopy("read_task_context") },
  get_task_history: { action: "read", ...toolCopy("read_task_history") },
  list_documents: { action: "list", ...toolCopy("list_documents") },
  read_document: { action: "read", ...toolCopy("read_document") },
  list_document_revisions: { action: "list", ...toolCopy("list_document_revisions") },
  report_progress: { action: "post", ...toolCopy("report_progress") },
  answer_status_question: { action: "post", ...toolCopy("answer_status_question") },
  write_document: { action: "update", ...toolCopy("write_document") },
  register_deliverable: { action: "create", ...toolCopy("register_deliverable") },
  finish_task: { action: "finish", ...toolCopy("report_completion") },
  paperclip_finish: { action: "finish", ...toolCopy("report_completion") },
  block_task: { action: "block", ...toolCopy("report_blocker") },
  paperclip_block: { action: "block", ...toolCopy("report_blocker") },
  request_review: { action: "request", ...toolCopy("request_review") },
  list_agents: { action: "list", ...toolCopy("list_agents") },
  get_agent: { action: "read", ...toolCopy("read_agent_details") },
  search_tasks: { action: "search", ...toolCopy("search_tasks") },
  list_approvals: { action: "list", ...toolCopy("list_approvals") },
  get_approval: { action: "read", ...toolCopy("read_approval") },
  get_approval_context: { action: "read", ...toolCopy("read_approval_context") },
  get_workspace_runtime: { action: "read", ...toolCopy("read_workspace_status") },
  control_workspace_service: { action: "run", ...toolCopy("control_workspace_service") },
  set_dependencies: { action: "update", ...toolCopy("update_task_dependencies") },
  create_task: { action: "create", ...toolCopy("create_task") },
  request_approval: { action: "request", ...toolCopy("request_approval") },
  decide_approval: { action: "update", ...toolCopy("decide_approval") },
  comment_on_approval: { action: "post", ...toolCopy("comment_approval") },
  schedule_wake: { action: "create", ...toolCopy("schedule_wake"), family: "wait" },
  generic_api_request: { action: "request", ...toolCopy("call_alice_api") },
};

const ACTION_PREFIXES: Record<Action, readonly string[]> = {
  read: ["get", "read", "inspect", "view"],
  list: ["list", "glob"],
  search: ["find", "search", "grep", "query", "lookup"],
  fetch: ["fetch", "browse"],
  open: ["open"],
  update: ["write", "edit", "update", "set", "patch", "upsert", "sync"],
  create: ["create", "add", "register", "upload"],
  delete: ["delete", "remove"],
  move: ["move", "rename"],
  run: ["run", "execute", "bash", "shell", "command"],
  request: ["request", "ask", "prompt"],
  post: ["send", "message", "comment", "report", "answer"],
  start: ["start", "spawn", "delegate"],
  stop: ["stop", "cancel", "interrupt"],
  wait: ["wait", "sleep", "poll"],
  finish: ["finish", "complete"],
  block: ["block"],
  think: ["think", "reason", "compact", "review"],
  switch: ["switch", "enter", "exit"],
  other: [],
};

const OPERATION_ACTIONS: Record<string, Action> = {
  read: "read",
  edit: "update",
  delete: "delete",
  move: "move",
  search: "search",
  list: "list",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "switch",
};

function normalizedKey(name: string): string {
  return identifierWords(name).join("_");
}

function inferredAction(words: readonly string[]): Action | null {
  const first = words[0];
  if (!first) return null;
  for (const [action, prefixes] of Object.entries(ACTION_PREFIXES) as Array<[Action, readonly string[]]>) {
    if (prefixes.includes(first)) return action;
  }
  return null;
}

function actionFamily(action: Action): ToolFamily {
  if (action === "run") return "terminal";
  if (action === "read" || action === "list") return "read";
  if (action === "search") return "search";
  if (action === "fetch" || action === "open") return "web";
  if (["update", "create", "delete", "move"].includes(action)) return "edit";
  if (action === "request") return "question";
  if (action === "start" || action === "stop") return "agent";
  if (action === "wait") return "wait";
  return "other";
}

const FAMILY_ICONS: Record<ToolFamily, ToolIcon> = {
  terminal: Terminal,
  grep: SearchCode,
  search: Search,
  read: BookOpen,
  edit: FilePenLine,
  web: ChevronsLeftRightEllipsis,
  plan: ListChecks,
  question: CircleHelp,
  agent: Network,
  safety: ShieldCheck,
  image: Image,
  wait: Clock3,
  mcp: McpIcon,
  other: Wrench,
};

function actionCopy(action: Action, object: string | undefined): { running: string; completed: string } {
  const withTarget = (key: string, fallback: string) => {
    const target = object ?? l10n(`local.manual_tool_target_${fallback}`);
    return {
      running: l10n(`local.manual_tool_action_${key}_running`, { v0: target }),
      completed: l10n(`local.manual_tool_action_${key}_completed`, { v0: target }),
    };
  };
  switch (action) {
    case "read": return withTarget("read", "data");
    case "list": return withTarget("list", "items");
    case "search": return object ? withTarget("search", "items") : toolCopy("search_generic");
    case "fetch": return withTarget("fetch", "data");
    case "open": return withTarget("open", "item");
    case "update": return withTarget("update", "data");
    case "create": return withTarget("create", "item");
    case "delete": return withTarget("delete", "item");
    case "move": return withTarget("move", "item");
    case "run": return toolCopy("run_command");
    case "request": return withTarget("request", "input");
    case "post": return withTarget("post", "update");
    case "start": return withTarget("start", "operation");
    case "stop": return withTarget("stop", "operation");
    case "wait": return toolCopy("wait");
    case "finish": return toolCopy("report_completion");
    case "block": return toolCopy("report_blocker");
    case "think": return toolCopy("think");
    case "switch": return withTarget("switch", "mode");
    case "other": return toolCopy("run_generic");
  }
}

function defaultSummaryGroup(action: Action): ToolSummaryGroup {
  switch (action) {
    case "run": return localizedGroup("command");
    case "read":
    case "list": return localizedGroup("read");
    case "search": return localizedGroup("search");
    case "update":
    case "create":
    case "delete":
    case "move": return localizedGroup("file_change");
    case "start":
    case "stop": return localizedGroup("delegation");
    case "wait": return localizedGroup("wait");
    default: return localizedGroup("tool_action");
  }
}

function paperclipSummaryGroup(action: Action): ToolSummaryGroup {
  if (action === "read" || action === "list") return localizedGroup("paperclip_read", "alice_read");
  return localizedGroup("task_operation");
}

/**
 * Resolve one tool into status-specific copy and iconography. Precedence is:
 * exact aliases, canonical ACP operation/kind, normalized verb, then a named
 * fallback. MCP remains visible as the source icon without losing semantics.
 */
export function toolActivityPresentation(input: ToolActivityPresentationInput): ToolActivityPresentation {
  const rawName = (input.name ?? "").trim();
  const parsedMcp = mcpToolIdentity(rawName);
  const namespace = (input.namespace ?? parsedMcp?.namespace ?? "").trim();
  // The name itself is authoritative for historical ACPX records that were
  // persisted as builtin before MCP transport normalization existed.
  const transport = (parsedMcp ? "mcp" : input.transport ?? "builtin").toLowerCase();
  const semanticName = (parsedMcp?.name ?? rawName).trim();
  const words = identifierWords(semanticName);
  const key = normalizedKey(semanticName);
  const exact = EXACT_ACTIONS[key];
  const operationAction = OPERATION_ACTIONS[(input.operation ?? "").trim().toLowerCase()];
  const inferred = inferredAction(words);
  const action = exact?.action ?? operationAction ?? inferred ?? "other";
  const confidence: ToolClassificationConfidence = exact
    ? "exact"
    : operationAction
      ? "kind"
      : inferred
        ? "inferred"
        : isGenericToolName(semanticName)
          ? "unnamed"
          : "fallback";
  const displayName = isGenericToolName(semanticName) ? l10n("local.unnamed_tool_4e0f07e3") : humanizeToolName(semanticName);
  const identifierLikeName = /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(semanticName);
  const objectWords = inferred && identifierLikeName && words.length > 1 ? words.slice(1) : [];
  const object = objectWords.length ? sentenceCase(objectWords).replace(/^./, (letter) => letter.toLowerCase()) : undefined;
  const copy = exact?.running && exact.completed
    ? { running: exact.running, completed: exact.completed }
    : action === "other"
      ? isGenericToolName(semanticName)
        ? toolCopy("unnamed_tool")
        : {
            running: l10n("local.manual_tool_named_running", { v0: displayName }),
            completed: l10n("local.manual_tool_named_completed", { v0: displayName }),
          }
      : actionCopy(action, exact ? undefined : object);
  const semanticFamily = exact?.family ?? actionFamily(action);
  const family = transport === "mcp" ? "mcp" : semanticFamily;
  const sourceLabel = namespace
    ? namespace.toLowerCase() === "paperclip"
      ? l10n("local.paperclip_c34c3f73")
      : humanizeToolName(namespace)
    : transport === "mcp"
      ? l10n("local.mcp_53f13ae9")
      : undefined;
  const summaryGroup = namespace.toLowerCase() === "paperclip"
    ? paperclipSummaryGroup(action)
    : exact?.group ?? defaultSummaryGroup(action);

  return {
    icon: FAMILY_ICONS[family],
    family,
    runningLabel: copy.running,
    completedLabel: copy.completed,
    failedLabel: l10n("local.manual_task_activity_fallback_failed", { v0: copy.completed }),
    interruptedLabel: l10n("local.manual_tool_fallback_stopped", { v0: copy.running }),
    displayName,
    sourceLabel,
    technicalName: rawName || undefined,
    confidence,
    summaryGroup,
  };
}

/** Compact compatibility mapping used by legacy tool rows and live pills. */
export function toolTaxonomy(name: string | undefined | null): ToolTaxonomyEntry {
  const presentation = toolActivityPresentation({ name });
  return {
    family: presentation.family,
    icon: presentation.icon,
    verbLabel: presentation.runningLabel,
  };
}

/** Icons for tool-free informative statuses. */
export function statusLabelIcon(label: string | undefined | null): ToolIcon | null {
  const raw = (label ?? "").trim().toLowerCase();
  if (raw === "thinking") return Brain;
  if (raw === "responding" || raw.startsWith("responding (")) return MessageSquareReply;
  return null;
}
