import { useState } from "react";
import { Languages } from "lucide-react";
import { i18n, l10n, setInterfaceLocale, type InterfaceLocale } from "@/i18n";

/** 语言名称保留原文，便于用户在界面语言错误时仍能识别。 */
export function LanguageSwitcher() {
  const [storageUnavailable, setStorageUnavailable] = useState(false);

  function changeLanguage(locale: InterfaceLocale) {
    if (locale === i18n.language) return;
    setStorageUnavailable(!setInterfaceLocale(locale));
  }

  return (
    <div className="px-3 py-3">
      <label className="flex items-center gap-3">
        <span className="rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Languages className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{l10n("local.interface_language_20261105")}</span>
          <select
            aria-label={l10n("local.interface_language_20261105")}
            value={i18n.language === "en" ? "en" : "zh-CN"}
            onChange={(event) => changeLanguage(event.target.value as InterfaceLocale)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            {l10n("local.language_switch_refreshes_page_20261105")}
          </span>
        </span>
      </label>
      {storageUnavailable ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {l10n("local.language_preference_storage_unavailable_20261105")}
        </p>
      ) : null}
    </div>
  );
}
