import {
  AlertTriangle,
  BookOpen,
  Bot,
  Box,
  Clock3,
  Database,
  FileCheck2,
  FilePenLine,
  FileText,
  GitBranch,
  ListChecks,
  PackageCheck,
  Search,
  ShieldCheck,
  TerminalSquare,
  Users,
} from "lucide-react";
import { l10n } from "../../i18n";
import type {
  TaskChatMaterializedResourceItem,
  TaskChatProtocolItem,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
  TaskChatWorkspaceFileItem,
} from "./task-chat-model";
import {
  humanizeToolName,
  isGenericToolName,
  mcpToolIdentity,
  toolActivityPresentation,
  type ToolIcon,
} from "./tool-taxonomy";

export interface TaskChatActivityPresentation {
  icon: ToolIcon;
  runningLabel: string;
  completedLabel: string;
  failedLabel?: string;
  interruptedLabel?: string;
  detail?: string;
}

function activity(
  key: string,
  icon: ToolIcon,
  detail?: string,
): TaskChatActivityPresentation {
  return {
    icon,
    runningLabel: l10n(`local.manual_task_activity_${key}_running`),
    completedLabel: l10n(`local.manual_task_activity_${key}_completed`),
    failedLabel: l10n(`local.manual_task_activity_${key}_failed`),
    interruptedLabel: l10n(`local.manual_task_activity_${key}_interrupted`),
    detail,
  };
}

function simpleActivity(
  key: string,
  icon: ToolIcon,
  detail?: string,
): TaskChatActivityPresentation {
  return {
    icon,
    runningLabel: l10n(`local.manual_task_activity_${key}_running`),
    completedLabel: l10n(`local.manual_task_activity_${key}_completed`),
    detail,
  };
}

function providerDetail(item: TaskChatProviderActivityItem, ...labels: string[]): string | undefined {
  return item.details.find((entry) => labels.includes(entry.label))?.value;
}

function meaningfulToolDetail(value: string | undefined): string | undefined {
  if (!value || isGenericToolName(value) || /^tool(?:\s+|_)call\b/i.test(value)) return undefined;
  return value;
}

export function providerActivityPresentation(item: TaskChatProviderActivityItem): TaskChatActivityPresentation {
  const detail = item.summary
    ?? providerDetail(item, "Query", "URL", "Target", "Name", "Reference", "Reason", "Summary");
  switch (item.family) {
    case "research": {
      const action = providerDetail(item, "Action")?.toLowerCase();
      if (action === "open_page") {
        return activity("open_web_page", Search, detail);
      }
      if (action === "find_in_page") {
        return activity("search_page", Search, detail);
      }
      return activity("search_web", Search, detail);
    }
    case "tool_execution": {
      const name = providerDetail(item, "Name");
      const target = providerDetail(item, "Target");
      const progress = providerDetail(item, "Progress");
      const tool = toolActivityPresentation({
        name,
        transport: providerDetail(item, "Transport"),
        namespace: providerDetail(item, "Namespace"),
        operation: providerDetail(item, "Operation"),
        target,
        progress,
      });
      const boundedActivity = meaningfulToolDetail(item.summary)
        ?? meaningfulToolDetail(progress)
        ?? meaningfulToolDetail(target);
      const activityIsIdentity = Boolean(
        boundedActivity && name && humanizeToolName(boundedActivity) === humanizeToolName(name),
      );
      const technicalName = name ? mcpToolIdentity(name)?.name ?? name : tool.displayName;
      const source = tool.sourceLabel
        ? `${tool.sourceLabel} · ${technicalName}`
        : name && !isGenericToolName(name) && humanizeToolName(name) !== tool.runningLabel.replace(/^Running /, "")
          ? name
          : undefined;
      return {
        icon: tool.icon,
        runningLabel: tool.runningLabel,
        completedLabel: tool.completedLabel,
        failedLabel: tool.failedLabel,
        interruptedLabel: tool.interruptedLabel,
        detail: [activityIsIdentity ? undefined : boundedActivity, source].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "plan":
      return activity("update_plan", ListChecks, detail);
    case "delegation": {
      const action = providerDetail(item, "Action")?.toLowerCase();
      if (action === "message") return activity("message_subagent", Users, detail);
      if (action === "resume") return activity("resume_subagent", Users, detail);
      if (action === "close") return activity("close_subagent", Users, detail);
      if (action === "wait") return activity("wait_subagents", Users, detail);
      return activity("start_subagent", Users, detail);
    }
    case "model_identity":
      return item.eventType === "model.route.changed"
        ? activity("switch_model", Bot, detail)
        : activity("verify_model", Bot, detail);
    case "context":
      return activity("compact_context", Database, detail);
    case "artifact": {
      const viewed = item.eventType === "artifact.viewed";
      return viewed
        ? activity("view_artifact", Box, detail)
        : activity("generate_artifact", Box, detail);
    }
    case "review": {
      const state = providerDetail(item, "State")?.toLowerCase();
      return state === "exited"
        ? activity("leave_review", FileCheck2, detail)
        : activity("enter_review", FileCheck2, detail);
    }
    case "hook":
      return activity("run_hook", GitBranch, detail);
    case "memory":
      return activity("check_memory", BookOpen, detail);
    case "safety":
      return activity("review_safety", ShieldCheck, detail);
    case "terminal":
      return activity("send_terminal_input", TerminalSquare, detail);
    case "wait":
      return activity("wait", Clock3, detail);
    case "provider_notice":
      return activity("provider_notice", AlertTriangle, detail);
  }
}

function workspaceChangePresentation(item: TaskChatWorkspaceChangeItem): TaskChatActivityPresentation {
  const count = item.totals.files || item.files.length;
  const detail = count > 0
    ? l10n(count === 1 ? "local.manual_task_activity_one_file" : "local.manual_task_activity_many_files", { v0: count })
    : undefined;
  return simpleActivity("edit_files", FilePenLine, detail);
}

function workspaceFilePresentation(item: TaskChatWorkspaceFileItem): TaskChatActivityPresentation {
  return simpleActivity(
    "reference_file",
    FileText,
    item.line == null ? item.path : `${item.path}:${item.line}`,
  );
}

function resourcePresentation(item: TaskChatMaterializedResourceItem): TaskChatActivityPresentation {
  return simpleActivity(
    item.resourceKind === "document" ? "save_document" : "save_deliverable",
    item.resourceKind === "document" ? FileText : PackageCheck,
    item.title,
  );
}

export function protocolActivityPresentation(item: TaskChatProtocolItem): TaskChatActivityPresentation | null {
  switch (item.surface) {
    case "provider_activity": return providerActivityPresentation(item);
    case "workspace_change": return workspaceChangePresentation(item);
    case "workspace_file": return workspaceFilePresentation(item);
    case "resource": return resourcePresentation(item);
    case "runtime_request":
    case "run_result":
    case "run_terminal":
      return null;
  }
}

export function protocolActivityIsRunning(item: TaskChatProtocolItem): boolean {
  if (item.surface === "provider_activity") return item.status === "running";
  if (item.surface === "workspace_change") return !item.complete;
  return false;
}

export function protocolActivityLabel(item: TaskChatProtocolItem, presentation: TaskChatActivityPresentation): string {
  if (item.surface !== "provider_activity") {
    return protocolActivityIsRunning(item) ? presentation.runningLabel : presentation.completedLabel;
  }
  if (item.status === "failed") return presentation.failedLabel ?? l10n("local.manual_task_activity_fallback_failed", { v0: presentation.completedLabel });
  if (item.status === "interrupted") return presentation.interruptedLabel ?? l10n("local.manual_task_activity_fallback_interrupted", { v0: presentation.completedLabel });
  return item.status === "running" ? presentation.runningLabel : presentation.completedLabel;
}
