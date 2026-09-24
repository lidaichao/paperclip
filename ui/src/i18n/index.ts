import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, FALLBACK_LOCALE, i18nextResources, supportedLocales } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";
export type InterfaceLocale = "zh-CN" | "en";

function initialLocale(): InterfaceLocale {
  try {
    const storage = typeof window === "undefined" ? globalThis.localStorage : window.localStorage;
    const saved = storage?.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return DEFAULT_LOCALE;
}

function syncDocumentLanguage(locale: string) {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

const locale = initialLocale();
syncDocumentLanguage(locale);
i18n.on("languageChanged", syncDocumentLanguage);

const i18nextOptions: InitOptions = {
  resources: i18nextResources,
  lng: locale,
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/** Presentation-only translation for components and module-level label maps. */
export function l10n(key: string, params: Record<string, unknown> = {}): string {
  return String(i18n.t(key, { ...params, returnObjects: false }));
}

/** Only generated English plural suffix expressions call this helper. */
export function englishPluralSuffix(value: string): string {
  return i18n.language === "zh-CN" && (value === "s" || value === "es") ? "" : value;
}

/** Reload so labels evaluated when modules load also adopt the chosen language. */
export function setInterfaceLocale(nextLocale: InterfaceLocale): boolean {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
