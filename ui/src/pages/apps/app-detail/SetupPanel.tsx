import { l10n } from "../../../i18n";
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { appDefinitionSlug } from "../app-definition-display";
import type { AppDetailSectionProps } from "./types";
import { googleSheetsConfigWithAllowlist, parseGoogleSheetIds } from "../google-sheets";

export function SetupPanel({
  connection,
  galleryEntry,
  onUpdateConfig,
  configUpdateDisabled,
  identities,
  agentsSummary,
  permissionsSummary,
  permissionsLoading,
  onOpenPermissions,
}: Pick<
  AppDetailSectionProps,
  "connection" | "galleryEntry"
> & {
  onUpdateConfig: (config: Record<string, unknown>) => void;
  configUpdateDisabled: boolean;
  /**
   * The fixed Identity section. It replaces the old generic OAuth "workspace
   * authorization" block and shows the identity type chosen during setup.
   */
  identities?: ReactNode;
  agentsSummary: string;
  permissionsSummary: string | null;
  permissionsLoading: boolean;
  onOpenPermissions: () => void;
}) {
  return (
    <div className="space-y-10">
      {identities}
      <SetupLinkSection title={l10n("local.agents_279b44d2")} summary={agentsSummary} onClick={onOpenPermissions} />
      <SetupLinkSection
        title={l10n("local.actions_ff8059dc")}
        summary={permissionsLoading ? l10n("local.loading_permissions_946f1570") : permissionsSummary ?? l10n("local.manage_permissions_2630ba4d")}
        onClick={onOpenPermissions}
      />
      {appDefinitionSlug(galleryEntry) === "google-sheets" && (
        <GoogleSheetsAllowlistSection
          connection={connection}
          disabled={configUpdateDisabled}
          onUpdateConfig={onUpdateConfig}
        />
      )}
      {appDefinitionSlug(galleryEntry) === "posthog" && (
        <PostHogConfigurationSection connection={connection} />
      )}
    </div>
  );
}

function SetupLinkSection({
  title,
  summary,
  onClick,
}: {
  title: string;
  summary: string;
  onClick: () => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 text-sm text-muted-foreground">{summary}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </section>
  );
}

/**
 * Provider label used in identity and revoke copy. Falls back to the app's own
 * display name so a pasted server never reads as a generic "OAuth".
 */
export function connectionProviderName(
  galleryEntry: Parameters<typeof appDefinitionSlug>[0],
  fallback: string,
): string {
  switch (appDefinitionSlug(galleryEntry)) {
    case "notion":
      return "Notion";
    case "posthog":
      return "PostHog";
    case "gmail":
      return "Gmail";
    case "google-sheets":
      return "Google Sheets";
    default:
      return fallback;
  }
}

function PostHogConfigurationSection({ connection }: { connection: ToolConnection }) {
  const raw = connection.config?.methodConfig;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const method = connection.config?.connectionMethodKey === "mcp-oauth" ? "PostHog sign-in" : "Personal API key";
  const features = typeof config.features === "string" ? config.features : "None";
  const tools = typeof config.tools === "string" && config.tools ? config.tools : "None";
  const rows = [
    ["Connection method", method],
    ["Project pin", typeof config.projectId === "string" ? config.projectId : "Use active project"],
    ["Read-only mode", config.readOnly === true ? "On" : "Off"],
    ["Feature groups", features],
    ["Individual tools", tools],
    ["Response mode", typeof config.mode === "string" ? config.mode : "tools"],
  ];
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground">{l10n("local.posthog_access_scope_8b34d1f1")}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {l10n("local.posthog_uses_its_normal_account_defaults_unle_84a94820")}</p>
      <dl className="mt-4 divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-2 sm:grid-cols-3 sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="break-words text-sm text-foreground sm:col-span-2">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function currentSpreadsheetIds(connection: ToolConnection): string[] {
  const raw = connection.config?.allowedSpreadsheetIds;
  return Array.isArray(raw) ? raw.map((value) => String(value).trim()).filter(Boolean) : [];
}

function googleSheetsUrlForId(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

function GoogleSheetsAllowlistSection({
  connection,
  disabled,
  onUpdateConfig,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = currentSpreadsheetIds(connection);
  const saveIds = (nextIds: string[]) =>
    onUpdateConfig(googleSheetsConfigWithAllowlist(connection.config, nextIds));

  return (
    <section>
      <div>
        <h2 className="text-sm font-bold text-foreground">{l10n("local.sheets_agents_can_use_38b73bee")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {l10n("local.agents_can_only_use_the_sheets_listed_here_17ba1daf")}</p>
      </div>

      <div className="mt-4 space-y-2">
        {ids.length === 0 ? (
          <div className="text-sm text-muted-foreground">{l10n("local.no_sheets_are_connected_yet_ee54c8d9")}</div>
        ) : (
          ids.map((id) => {
            const sheetUrl = googleSheetsUrlForId(id);
            return (
              <div key={id} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 text-sm font-medium text-foreground underline-offset-2 hover:underline"
                >
                  <span className="block truncate">{l10n("local.open_sheet_f2df2497")}</span>
                  <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                    {sheetUrl}
                  </span>
                  <span className="block truncate font-mono text-(length:--text-micro) font-normal text-muted-foreground/80">
                    {l10n("local.id_3ea36adc")}{" "}{id}
                  </span>
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || ids.length <= 1}
                  title={ids.length <= 1 ? l10n("local.add_another_sheet_before_removing_this_one_a9ae307c") : undefined}
                  onClick={() => saveIds(ids.filter((current) => current !== id))}
                >
                  {l10n("local.remove_c3812fc4")}</Button>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          className="h-10"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            const parsed = parseGoogleSheetIds(draft);
            if (parsed.ids.length === 0) {
              setError(l10n("local.paste_a_google_sheets_link_3140b10e"));
              return;
            }
            if (parsed.invalidCount > 0) {
              setError(l10n("local.that_doesn_t_look_like_a_google_sheets_link_42b2bd84"));
              return;
            }
            saveIds(Array.from(new Set([...ids, ...parsed.ids])));
            setDraft("");
          }}
        >
          {l10n("local.add_sheet_e05a0e96")}</Button>
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  );
}

export function QuarantinedActionsReview({
  entries,
  disabled,
  onSubmit,
}: {
  entries: ToolCatalogEntry[];
  disabled: boolean;
  onSubmit: (enabledIds: string[]) => void;
}) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const count = entries.length;
  const selectedIds = entries.filter((entry) => enabledIds.has(entry.id)).map((entry) => entry.id);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {l10n("local.review_aff0766a")}{" "}{count} {l10n("local.new_11507a0e")}{" "}{count === 1 ? l10n("local.action_bd938c68") : l10n("local.actions_2b0dcdd4")}
          </div>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {l10n("local.turn_on_the_actions_agents_may_use_anything_l_6a8de879")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set(entries.map((entry) => entry.id)))}
          >
            {l10n("local.turn_all_on_08f6d3f5")}</button>
          <button
            type="button"
            className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
            disabled={disabled}
            onClick={() => setEnabledIds(new Set())}
          >
            {l10n("local.turn_all_off_59d74fd7")}</button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {entries.map((entry) => {
          const enabled = enabledIds.has(entry.id);
          const label = entry.title ?? entry.toolName;
          return (
            <div key={entry.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{label}</div>
                {entry.description && (
                  <div className="truncate text-xs text-muted-foreground">{entry.description}</div>
                )}
              </div>
              <ToggleSwitch
                aria-label={l10n("local.value_allowed_13a189ee", {v0: (label)})}
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(next) => {
                  setEnabledIds((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(entry.id);
                    else updated.delete(entry.id);
                    return updated;
                  });
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-amber-700 dark:text-amber-300">
          {selectedIds.length} {l10n("local.of_28391d3b")}{" "}{count} {l10n("local.will_be_on_fc51aab7")}</span>
        <Button size="sm" disabled={disabled} onClick={() => onSubmit(selectedIds)}>
          {disabled ? l10n("local.saving_23e39291") : l10n("local.save_choices_035882f1")}
        </Button>
      </div>
    </section>
  );
}
