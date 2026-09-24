import { l10n } from "../i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { nextCronFires, parseCronExpression } from "../lib/cron-fires";

export type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: "every_minute", label: l10n("local.every_minute_3c14fb8a") },
  { value: "every_hour", label: l10n("local.every_hour_a4bac465") },
  { value: "every_day", label: l10n("local.every_day_c4e42b97") },
  { value: "weekdays", label: l10n("local.weekdays_6f4b602b") },
  { value: "weekly", label: l10n("local.weekly_29751324") },
  { value: "monthly", label: l10n("local.monthly_9b11f6b7") },
  { value: "custom", label: l10n("local.custom_cron_6dc53fd8") },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: i === 0 ? l10n("local.12_am_0f6496fb") : i < 12 ? l10n("local.value_am_9fa35cc3", {v0: (i)}) : i === 12 ? l10n("local.12_pm_a7367471") : l10n("local.value_pm_7088914a", {v0: (i - 12)}),
}));

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAYS_OF_WEEK = [
  { value: "1", label: l10n("local.mon_f40d7f51") },
  { value: "2", label: l10n("local.tue_d1eb39b0") },
  { value: "3", label: l10n("local.wed_58339f45") },
  { value: "4", label: l10n("local.thu_7da11212") },
  { value: "5", label: l10n("local.fri_66dab40c") },
  { value: "6", label: l10n("local.sat_fdeb71b5") },
  { value: "0", label: l10n("local.sun_db18f17f") },
];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

function hasOption(options: Array<{ value: string }>, value: string): boolean {
  return options.some((option) => option.value === value);
}

export function parseCronToPreset(cron: string): {
  preset: SchedulePreset;
  hour: string;
  minute: string;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const defaults = { hour: "10", minute: "0", dayOfWeek: "1", dayOfMonth: "1" };

  if (!cron || !cron.trim()) {
    return { preset: "every_day", ...defaults };
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { preset: "custom", ...defaults };
  }

  const [min, hr, dom, month, dow] = parts;
  const selectableMinute = hasOption(MINUTES, min);
  const selectableHour = hasOption(HOURS, hr);

  // Every minute: "* * * * *"
  if (min === "*" && hr === "*" && dom === "*" && month === "*" && dow === "*") {
    return { preset: "every_minute", ...defaults };
  }

  // Every hour: "0 * * * *"
  if (hr === "*" && dom === "*" && month === "*" && dow === "*" && selectableMinute) {
    return { preset: "every_hour", ...defaults, minute: min };
  }

  // Every day: "M H * * *"
  if (dom === "*" && month === "*" && dow === "*" && selectableHour && selectableMinute) {
    return { preset: "every_day", ...defaults, hour: hr, minute: min };
  }

  // Weekdays: "M H * * 1-5"
  if (dom === "*" && month === "*" && dow === "1-5" && selectableHour && selectableMinute) {
    return { preset: "weekdays", ...defaults, hour: hr, minute: min };
  }

  // Weekly: "M H * * D" (single day)
  if (dom === "*" && month === "*" && hasOption(DAYS_OF_WEEK, dow) && selectableHour && selectableMinute) {
    return { preset: "weekly", ...defaults, hour: hr, minute: min, dayOfWeek: dow };
  }

  // Monthly: "M H D * *"
  if (month === "*" && hasOption(DAYS_OF_MONTH, dom) && dow === "*" && selectableHour && selectableMinute) {
    return { preset: "monthly", ...defaults, hour: hr, minute: min, dayOfMonth: dom };
  }

  return { preset: "custom", ...defaults };
}

export function buildCron(preset: SchedulePreset, hour: string, minute: string, dayOfWeek: string, dayOfMonth: string): string {
  switch (preset) {
    case "every_minute":
      return "* * * * *";
    case "every_hour":
      return `${minute} * * * *`;
    case "every_day":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom":
      return "";
  }
}

function describeSchedule(cron: string): string {
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const hourLabel = HOURS.find((h) => h.value === hour)?.label ?? `${hour}`;
  const timeStr = `${hourLabel.replace(/ (AM|PM)$/, "")}:${minute.padStart(2, "0")} ${hourLabel.match(/(AM|PM)$/)?.[0] ?? ""}`;

  switch (preset) {
    case "every_minute":
      return "Every minute";
    case "every_hour":
      return `Every hour at :${minute.padStart(2, "0")}`;
    case "every_day":
      return `Every day at ${timeStr}`;
    case "weekdays":
      return `Weekdays at ${timeStr}`;
    case "weekly": {
      const day = DAYS_OF_WEEK.find((d) => d.value === dayOfWeek)?.label ?? dayOfWeek;
      return `Every ${day} at ${timeStr}`;
    }
    case "monthly":
      return `Monthly on the ${dayOfMonth}${ordinalSuffix(Number(dayOfMonth))} at ${timeStr}`;
    case "custom":
      return cron || "No schedule set";
  }
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export { describeSchedule };

export function getScheduleCronValidation(cron: string): {
  valid: boolean;
  message: string;
  nextFires: Date[];
} {
  const trimmed = cron.trim();
  if (!trimmed) {
    return {
      valid: false,
      message: "Enter a 5-field cron expression.",
      nextFires: [],
    };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      message: `Use exactly 5 fields; this has ${fields.length}.`,
      nextFires: [],
    };
  }

  if (!parseCronExpression(trimmed)) {
    return {
      valid: false,
      message: "Cron fields must use valid numbers, ranges, lists, wildcards, or steps.",
      nextFires: [],
    };
  }

  const nextFires = nextCronFires(trimmed, 3, { timeZone: "UTC" });
  return {
    valid: true,
    message: nextFires.length > 0 ? "Valid cron." : "Valid cron, but no upcoming fires were found.",
    nextFires,
  };
}

export function ScheduleEditor({
  value,
  onChange,
  onValidityChange,
}: {
  value: string;
  onChange: (cron: string) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const parsed = useMemo(() => parseCronToPreset(value), [value]);
  const [preset, setPreset] = useState<SchedulePreset>(parsed.preset);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [dayOfWeek, setDayOfWeek] = useState(parsed.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(parsed.dayOfMonth);
  const [customCron, setCustomCron] = useState(preset === "custom" ? value : "");
  const customValidation = useMemo(() => getScheduleCronValidation(customCron), [customCron]);

  useEffect(() => {
    onValidityChange?.(preset !== "custom" || customValidation.valid);
  }, [customValidation.valid, onValidityChange, preset]);

  // Sync from external value changes
  useEffect(() => {
    const p = parseCronToPreset(value);
    setPreset(p.preset);
    setHour(p.hour);
    setMinute(p.minute);
    setDayOfWeek(p.dayOfWeek);
    setDayOfMonth(p.dayOfMonth);
    if (p.preset === "custom") setCustomCron(value);
  }, [value]);

  const emitChange = useCallback(
    (p: SchedulePreset, h: string, m: string, dow: string, dom: string, custom: string) => {
      if (p === "custom") {
        onChange(custom);
      } else {
        onChange(buildCron(p, h, m, dow, dom));
      }
    },
    [onChange],
  );

  const handlePresetChange = (newPreset: SchedulePreset) => {
    setPreset(newPreset);
    if (newPreset === "custom") {
      setCustomCron(value);
    } else {
      emitChange(newPreset, hour, minute, dayOfWeek, dayOfMonth, customCron);
    }
  };

  return (
    <div className="space-y-3">
      <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
        <SelectTrigger className="w-full" aria-label={l10n("local.schedule_frequency_feed2d11")}>
          <SelectValue placeholder={l10n("local.choose_frequency_55479844")} />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <div className="space-y-1.5">
          <Input
            value={customCron}
            onChange={(e) => {
              const nextCron = e.target.value;
              setCustomCron(nextCron);
              // Report validity synchronously with the keystroke so consumers can gate
              // their submit affordance in the same render. Relying solely on the
              // effect below leaves a one-tick window where an invalid draft still
              // reads as valid to the parent.
              const nextValidation = getScheduleCronValidation(nextCron);
              onValidityChange?.(nextValidation.valid);
              if (nextValidation.valid) {
                emitChange("custom", hour, minute, dayOfWeek, dayOfMonth, nextCron);
              }
            }}
            placeholder="0 10 * * *"
            aria-label={l10n("local.cron_expression_9e6e7de6")}
            aria-invalid={!customValidation.valid}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {l10n("local.five_fields_minute_hour_day_of_month_month_da_7abb912a")}</p>
          <p
            className={customValidation.valid ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
            aria-live="polite"
          >
            {customValidation.message}
            {customValidation.valid && customValidation.nextFires.length > 0
              ? (" " + l10n("local.next_value_f3d03fd9", {v0: (customValidation.nextFires.map((fire) => fire.toLocaleString()).join(", "))}))
              : null}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{l10n("local.at_b1d6b91b")}</span>
              <Select
                value={hour}
                onValueChange={(h) => {
                  setHour(h);
                  emitChange(preset, h, minute, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-120px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">:</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{l10n("local.at_minute_5f2ed72d")}</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      :{m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">{l10n("local.on_b8d31e85")}</span>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((d) => (
                  <Button
                    key={d.value}
                    type="button"
                    variant={dayOfWeek === d.value ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    aria-pressed={dayOfWeek === d.value}
                    onClick={() => {
                      setDayOfWeek(d.value);
                      emitChange(preset, hour, minute, d.value, dayOfMonth, customCron);
                    }}
                  >
                    {d.label}
                  </Button>
                ))}
              </div>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">{l10n("local.on_day_ada1fca3")}</span>
              <Select
                value={dayOfMonth}
                onValueChange={(dom) => {
                  setDayOfMonth(dom);
                  emitChange(preset, hour, minute, dayOfWeek, dom, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OF_MONTH.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
