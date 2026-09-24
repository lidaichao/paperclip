import { l10n } from "../i18n";
import { displayLocale } from "../i18n/display";
import { useEffect, useState } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DUE_NOW_GRACE_MS = MINUTE_MS;

type MonitorDate = Date | string;

type MonitorDetails = {
  nextCheckAt?: MonitorDate | null;
  attemptCount?: number | null;
  serviceName?: string | null;
  status?: "scheduled" | "triggered" | "cleared" | null;
};

type MonitorPolicy = {
  nextCheckAt?: MonitorDate | null;
  serviceName?: string | null;
};

type ScheduledRetry = {
  status?: "scheduled_retry" | "queued" | "running" | "cancelled" | null;
  scheduledRetryAt?: MonitorDate | null;
  scheduledRetryAttempt?: number | null;
};

export interface MonitorIssueLike {
  status?: string;
  executionState?: { monitor?: MonitorDetails | null } | null;
  executionPolicy?: { monitor?: MonitorPolicy | null } | null;
  monitorNextCheckAt?: MonitorDate | null;
  monitorAttemptCount?: number | null;
  scheduledRetry?: ScheduledRetry | null;
}

export type MonitorDisplayState =
  | "scheduled"
  | "retrying"
  | "due-now"
  | "overdue"
  | "cleared"
  | "none";

export interface DerivedMonitorState {
  state: MonitorDisplayState;
  source: "monitor" | "scheduled-retry" | "none";
  nextCheckAt: MonitorDate | null;
  attemptCount: number;
  serviceName: string | null;
}

export interface MonitorDateTimeFormatOptions {
  locale?: Intl.LocalesArgument;
  timeZone?: string;
}

function toTimestamp(value: MonitorDate): number {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new RangeError("Invalid monitor date");
  return timestamp;
}

function formatDuration(durationMs: number): string {
  if (durationMs < MINUTE_MS) {
    return `${Math.max(1, Math.ceil(durationMs / SECOND_MS))}s`;
  }
  if (durationMs < HOUR_MS) {
    return `${Math.floor(durationMs / MINUTE_MS)}m`;
  }
  if (durationMs < DAY_MS) {
    const hours = Math.floor(durationMs / HOUR_MS);
    const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(durationMs / DAY_MS);
  const hours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function formatMonitorEta(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {
  const deltaMs = toTimestamp(nextCheckAt) - toTimestamp(now);
  if (deltaMs > 0) return `in ${formatDuration(deltaMs)}`;
  if (deltaMs > -DUE_NOW_GRACE_MS) return "due now";
  return `overdue by ${formatDuration(Math.abs(deltaMs))}`;
}


/** Localize a known monitor display string; raw ETA/offset contracts stay English. */
export function displayMonitorRelative(raw: string): string {
  if (displayLocale() !== "zh-CN") return raw;
  if (raw === "due now") return l10n("local.manual_monitor_due_now");
  if (raw === "now") return l10n("local.manual_monitor_now");
  const match = /^(?:(in |overdue by ))?(\d+[smhd](?: \d+[smhd])?)( ago)?$/.exec(raw);
  if (!match || (Boolean(match[1]) === Boolean(match[3]))) return raw;
  const duration = match[2].replace(/(\d+)([smhd])/g, (_token, count: string, unit: string) =>
    l10n(`local.manual_monitor_duration_${unit}`, { v0: count }),
  );
  if (match[1] === "in ") return l10n("local.manual_monitor_in", { v0: duration });
  if (match[1] === "overdue by ") return l10n("local.manual_monitor_overdue", { v0: duration });
  return l10n("local.manual_monitor_ago", { v0: duration });
}

export function formatMonitorEtaDisplay(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {
  return displayMonitorRelative(formatMonitorEta(nextCheckAt, now));
}

export function formatMonitorOffsetDisplay(nextCheckAt: MonitorDate): string {
  return displayMonitorRelative(formatMonitorOffset(nextCheckAt));
}

export function formatMonitorEtaLabel(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {
  const eta = formatMonitorEtaDisplay(nextCheckAt, now);
  return `${eta.charAt(0).toUpperCase()}${eta.slice(1)}`;
}

function zonedYmd(
  date: Date,
  locale: Intl.LocalesArgument,
  timeZone: string | undefined,
): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

/**
 * Compact absolute time for the monitor surfaces (wireframe 04). Renders
 * `Today, 8:16 PM` when the check lands on the reference day, otherwise prefixes
 * the weekday (`Mon Jul 20, 9:00 AM`) and only adds the year when it differs from
 * the reference year (`Mon Jul 20, 2027, 9:00 AM`). Day/year comparisons are made
 * in the display time zone so "Today" matches what the user sees.
 */
export function formatMonitorAbsolute(
  nextCheckAt: MonitorDate,
  options: MonitorDateTimeFormatOptions = {},
  now: MonitorDate = new Date(),
): string {
  const target = new Date(toTimestamp(nextCheckAt));
  const reference = new Date(toTimestamp(now));
  const targetYmd = zonedYmd(target, options.locale, options.timeZone);
  const referenceYmd = zonedYmd(reference, options.locale, options.timeZone);

  const time = new Intl.DateTimeFormat(options.locale ?? displayLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(target);

  const isToday =
    targetYmd.year === referenceYmd.year &&
    targetYmd.month === referenceYmd.month &&
    targetYmd.day === referenceYmd.day;
  if (isToday) return l10n("local.manual_today_time", {v0: time});

  const weekday = new Intl.DateTimeFormat(options.locale ?? displayLocale(), {
    weekday: "short",
    timeZone: options.timeZone,
  }).format(target);
  const date = new Intl.DateTimeFormat(options.locale ?? displayLocale(), {
    month: "short",
    day: "numeric",
    year: targetYmd.year === referenceYmd.year ? undefined : "numeric",
    timeZone: options.timeZone,
  }).format(target);

  return `${weekday} ${date}, ${time}`;
}

export function formatMonitorAbsoluteFull(
  nextCheckAt: MonitorDate,
  options: MonitorDateTimeFormatOptions = {},
): string {
  const date = new Date(toTimestamp(nextCheckAt));
  const datePart = new Intl.DateTimeFormat(options.locale ?? displayLocale(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: options.timeZone,
  }).format(date);
  const timePart = new Intl.DateTimeFormat(options.locale ?? displayLocale(), {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(date);
  return `${datePart}, ${timePart}`;
}

export function deriveMonitorState(issue: MonitorIssueLike, now: MonitorDate = new Date()): DerivedMonitorState {
  if (issue.status === "done" || issue.status === "cancelled") {
    return { state: "none", source: "none", nextCheckAt: null, attemptCount: 0, serviceName: null };
  }

  const runtimeMonitor = issue.executionState?.monitor ?? null;
  const policyMonitor = issue.executionPolicy?.monitor ?? null;
  const scheduledRetry = issue.scheduledRetry ?? null;
  // Promotion preserves scheduledRetryAt as history. Once queued or running,
  // the retry is no longer waiting for that timestamp and cannot be overdue.
  const retryIsScheduled = scheduledRetry?.status === "scheduled_retry";
  const nextCheckAt =
    runtimeMonitor?.nextCheckAt ??
    issue.monitorNextCheckAt ??
    policyMonitor?.nextCheckAt ??
    (retryIsScheduled ? scheduledRetry?.scheduledRetryAt : null) ??
    null;
  const hasMonitor = runtimeMonitor !== null || policyMonitor !== null || issue.monitorNextCheckAt != null;
  const source = hasMonitor ? "monitor" : retryIsScheduled ? "scheduled-retry" : "none";
  const attemptCount =
    runtimeMonitor?.attemptCount ??
    (hasMonitor ? issue.monitorAttemptCount : null) ??
    (retryIsScheduled ? scheduledRetry?.scheduledRetryAttempt : null) ??
    0;
  const serviceName = runtimeMonitor?.serviceName ?? policyMonitor?.serviceName ?? null;

  if (runtimeMonitor?.status === "cleared") {
    return { state: "cleared", source, nextCheckAt, attemptCount, serviceName };
  }

  if (!hasMonitor && !retryIsScheduled) {
    return { state: "none", source, nextCheckAt: null, attemptCount: 0, serviceName: null };
  }
  if (!nextCheckAt) {
    return { state: retryIsScheduled || attemptCount > 1 ? "retrying" : "scheduled", source, nextCheckAt, attemptCount, serviceName };
  }

  const deltaMs = toTimestamp(nextCheckAt) - toTimestamp(now);
  if (deltaMs <= -DUE_NOW_GRACE_MS) {
    return { state: "overdue", source, nextCheckAt, attemptCount, serviceName };
  }
  if (deltaMs <= 0) {
    return { state: "due-now", source, nextCheckAt, attemptCount, serviceName };
  }
  return {
    state: retryIsScheduled || attemptCount > 1 ? "retrying" : "scheduled",
    source,
    nextCheckAt,
    attemptCount,
    serviceName,
  };
}

function countdownCadence(nextCheckAt: MonitorDate): number {
  const deltaMs = toTimestamp(nextCheckAt) - Date.now();
  return deltaMs > -DUE_NOW_GRACE_MS && deltaMs < DUE_NOW_GRACE_MS ? SECOND_MS : 30 * SECOND_MS;
}

export function useMonitorCountdown(nextCheckAt: MonitorDate | null | undefined): Date {
  const [now, setNow] = useState(() => new Date(Date.now()));
  const nextCheckTimestamp = nextCheckAt == null ? null : toTimestamp(nextCheckAt);

  useEffect(() => {
    setNow(new Date(Date.now()));
    if (nextCheckTimestamp === null) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const scheduleNextTick = () => {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setNow(new Date(Date.now()));
        scheduleNextTick();
      }, countdownCadence(new Date(nextCheckTimestamp)));
    };

    scheduleNextTick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [nextCheckTimestamp]);

  return now;
}

export function formatMonitorOffset(nextCheckAt: MonitorDate): string {
  const now = new Date(Date.now());
  const deltaMs = toTimestamp(nextCheckAt) - now.getTime();
  if (Math.round(Math.abs(deltaMs) / MINUTE_MS) === 0) return "now";
  const eta = formatMonitorEta(nextCheckAt, now);
  if (eta === "due now") return "now";
  if (eta.startsWith("overdue by ")) return `${eta.slice("overdue by ".length)} ago`;
  return eta;
}
