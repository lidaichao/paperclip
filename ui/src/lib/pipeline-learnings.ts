import { l10n } from "../i18n";
import type { PipelineCompanyCaseEvent } from "../api/pipelines";
import { formatShortDate } from "./utils";

export type LearningEventPresentation = {
  sentence: string;
  kind: "review" | "forced_move" | "unknown";
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function eventItemTitle(event: PipelineCompanyCaseEvent): string {
  const payload = asRecord(event.payload);
  return (
    asString(event.case?.title) ??
    asString(payload.itemTitle) ??
    asString(payload.caseTitle) ??
    asString(payload.title) ??
    "Untitled item"
  );
}

function eventActorName(event: PipelineCompanyCaseEvent): string {
  const payload = asRecord(event.payload);
  return (
    asString(event.actorAgent?.name) ??
    asString(payload.actorName) ??
    asString(payload.reviewerName) ??
    asString(payload.decidedByName) ??
    "Someone"
  );
}

function payloadText(event: PipelineCompanyCaseEvent, ...keys: string[]): string | null {
  const payload = asRecord(event.payload);
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

function reviewVerb(decision: string | null): string {
  if (decision === "request_changes") return "sent back";
  if (decision === "reject" || decision === "drop") return "declined";
  return "approved";
}

export function formatLearningEvent(event: PipelineCompanyCaseEvent): LearningEventPresentation {
  const payload = asRecord(event.payload);
  const title = eventItemTitle(event);

  if (event.type === "review_decided") {
    const actor = eventActorName(event);
    const decision = asString(payload.decision);
    const toStageName =
      asString(event.toStage?.name) ?? payloadText(event, "toStageName", "stageName", "targetStageName");
    const stageCopy = toStageName ? (" " + l10n("local.moving_to_value_218ee732", {v0: (toStageName)})) : "";
    const note = payloadText(event, "reason", "note");
    const noteCopy = note ? (" " + l10n("local._note_value_4be06247", {v0: (note)})) : "";
    return {
      kind: "review",
      sentence: `${actor} ${reviewVerb(decision)} '${title}'${stageCopy}${noteCopy}.`,
    };
  }

  if (event.type === "transition_forced") {
    const fromStageName = asString(event.fromStage?.name) ?? payloadText(event, "fromStageName");
    const toStageName =
      asString(event.toStage?.name) ?? payloadText(event, "toStageName", "stageName", "targetStageName");
    const fromCopy = fromStageName ? (" " + l10n("local.from_value_09ac5ff6", {v0: (fromStageName)})) : "";
    const toCopy = toStageName ? (" " + l10n("local.to_value_bc283e29", {v0: (toStageName)})) : "";
    const reason = payloadText(event, "reason", "note");
    const reasonCopy = reason ? (" " + l10n("local._reason_value_ff8c539d", {v0: (reason)})) : "";
    return {
      kind: "forced_move",
      sentence: `'${title}' was moved by hand${fromCopy}${toCopy}${reasonCopy}.`,
    };
  }

  return {
    kind: "unknown",
    sentence: `'${title}' changed.`,
  };
}

export function learningDayKey(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toISOString().slice(0, 10);
}

export function learningDayLabel(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return l10n("local.unknown_b764cdc0");
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (diffDays === 0) return l10n("local.today_2b065c7c");
  if (diffDays === 1) return l10n("local.yesterday_56618125");
  return formatShortDate(date);
}

export function groupLearningEventsByDay<T extends { createdAt: string | Date }>(events: T[]) {
  const groups: Array<{ key: string; label: string; events: T[] }> = [];
  for (const event of events) {
    const key = learningDayKey(event.createdAt);
    const existing = groups.find((group) => group.key === key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    groups.push({ key, label: learningDayLabel(event.createdAt), events: [event] });
  }
  return groups;
}
