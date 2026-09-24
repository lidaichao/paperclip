import { i18n, l10n } from "./index";
import displayKeys from "./display-keys.json";

/** Exact lookup at explicit presentation sites; never use for persisted values. */
export function displayText(english: string): string {
  if (i18n.language !== "zh-CN") return english;
  const key = (displayKeys as Record<string, string>)[english.toLowerCase()];
  return key ? l10n(key) : english;
}

/** Render known enum labels without changing the enum passed to controls/APIs. */
export function enumLabel(value: string, style: "title" | "sentence" | "lower" = "title"): string {
  const english = value.replace(/[_-]/g, " ");
  const fallback = style === "lower" ? english : style === "sentence" ? english.charAt(0).toUpperCase() + english.slice(1) : english.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return displayText(fallback);
}

export function displayLocale(): string {
  return i18n.language === "zh-CN" ? "zh-CN" : "en-US";
}
