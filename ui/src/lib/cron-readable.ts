import { l10n } from "../i18n";

/**
 * Tiny best-effort cron → plain-English helper for the routine Triggers section.
 * Not a full cron parser: it covers the common shapes Paperclip schedule triggers
 * produce (every N minutes/hours, daily at HH:MM, weekday/weekend, day-of-week).
 * Falls back to the raw expression when it can't confidently describe it.
 */

const DOW_NAMES = [
  l10n("local.sunday_0ca00007"),
  l10n("local.monday_0ca00001"),
  l10n("local.tuesday_0ca00002"),
  l10n("local.wednesday_0ca00003"),
  l10n("local.thursday_0ca00004"),
  l10n("local.friday_0ca00005"),
  l10n("local.saturday_0ca00006"),
];

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function describeTime(minute: string, hour: string): string | null {
  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h)) return null;
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

function describeDayOfWeek(dow: string): string | null {
  if (dow === "*" || dow === "?") return l10n("local.every_day_lower_10301347");
  if (dow === "1-5") return l10n("local.every_weekday_lower_10301348");
  if (dow === "0,6" || dow === "6,0" || dow === "0,7") {
    return l10n("local.every_weekend_lower_10301349");
  }
  const parts = dow.split(",").map((part) => part.trim());
  const names = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n)) return null;
    return DOW_NAMES[n % 7];
  });
  if (names.some((name) => name === null)) return null;
  if (names.length === 1) return l10n("local.every_named_day_10301350", { v0: names[0] });
  return l10n("local.every_named_days_10301351", {
    v0: names.slice(0, -1).join(l10n("local.list_separator_10301352")),
    v1: names[names.length - 1],
  });
}

export function describeCron(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);
  // Standard 5-field cron: minute hour day-of-month month day-of-week
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;

  // Every N minutes
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return l10n("local.every_minutes_10301353", { v0: everyMinutes[1] });
  }

  // Every N hours, on the minute
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (everyHours && /^\d+$/.test(minute) && dom === "*" && month === "*" && dow === "*") {
    return l10n("local.every_hours_at_minute_10301354", {
      v0: everyHours[1],
      v1: pad2(Number(minute)),
    });
  }

  // Hourly
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return l10n("local.every_hour_at_minute_10301355", { v0: pad2(Number(minute)) });
  }

  // Daily / weekly at a fixed time
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === "*") {
    const time = describeTime(minute, hour);
    if (!time) return null;
    if (dom === "*" && (dow === "*" || dow === "?")) {
      return l10n("local.every_day_at_time_10301356", { v0: time });
    }
    if (dom === "*") {
      const dowText = describeDayOfWeek(dow);
      if (dowText) return l10n("local.schedule_days_at_time_10301357", { v0: dowText, v1: time });
    }
    if (/^\d+$/.test(dom) && (dow === "*" || dow === "?")) {
      return l10n("local.day_of_month_at_time_10301359", { v0: dom, v1: time });
    }
  }

  return null;
}
