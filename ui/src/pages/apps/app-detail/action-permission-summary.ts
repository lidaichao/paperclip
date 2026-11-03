import type { ToolCatalogEntry } from "@paperclipai/shared";
import { l10n } from "../../../i18n";

export type ActionPermissionSummary = {
  allowedCount: number;
  askFirstCount: number;
  offCount: number;
};

export function summarizeActionPermissions(
  entries: ToolCatalogEntry[],
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
): ActionPermissionSummary {
  let allowedCount = 0;
  let askFirstCount = 0;
  let offCount = 0;

  for (const entry of entries) {
    if (!enabledIds.has(entry.id)) {
      offCount += 1;
    } else if (askFirstIds.has(entry.id)) {
      askFirstCount += 1;
    } else {
      allowedCount += 1;
    }
  }

  return { allowedCount, askFirstCount, offCount };
}

function summaryCount(label: string, count: number): string {
  return `${label} ${count}${count === 1 ? ` ${l10n("local.action_bd938c68")}` : ""}`;
}

export function formatActionPermissionSummary(summary: ActionPermissionSummary): string {
  return [
    summaryCount(l10n("local.allowed_for_10300382"), summary.allowedCount),
    summaryCount(l10n("local.ask_first_for_10300383"), summary.askFirstCount),
    summaryCount(l10n("local.off_for_10300384"), summary.offCount),
  ].join(" · ");
}
