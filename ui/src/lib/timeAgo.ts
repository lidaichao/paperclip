import { l10n } from "../i18n";
import { displayText, displayLocale } from "../i18n/display";
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return l10n("local.manual_just_now");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return l10n("local.manual_minutes_ago", {v0: m});
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return l10n("local.manual_hours_ago", {v0: h});
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return l10n("local.manual_days_ago", {v0: d});
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return l10n("local.manual_weeks_ago", {v0: w});
  }
  const mo = Math.floor(seconds / MONTH);
  return l10n("local.manual_months_ago", {v0: mo});
}
