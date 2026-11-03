import { l10n } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import { Clock3, FileDiff, GitCommit, type LucideIcon } from "lucide-react";
import { healthApi, type HealthStatus } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return l10n("local.unavailable_ca184496");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return l10n("local.unavailable_ca184496");
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isValidTimestamp(value: string | null | undefined): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function restartTimestamp(health: HealthStatus | undefined): string | null {
  return health?.devServer?.lastRestartAt ?? health?.serverInfo?.processStartedAt ?? null;
}

function commitLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available) return l10n("local.commit_unavailable_ff6a6609");
  return `${git.shortSha} · ${git.subject}`;
}

function localChangesLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available) return l10n("local.unavailable_ca184496");
  const localChanges = git.localChanges;
  if (!localChanges) return l10n("local.change_status_unavailable_50e3e180");
  if (!localChanges.available) return l10n("local.change_status_unavailable_50e3e180");
  if (!localChanges.hasLocalChanges) return l10n("local.clean_checkout_f208aaf4");

  const parts = [
    [localChanges.stagedFileCount, l10n("local.staged_0e700001")],
    [localChanges.unstagedFileCount, l10n("local.unstaged_0e700002")],
    [localChanges.untrackedFileCount, l10n("local.untracked_0e700003")],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`);

  return parts.length > 0
    ? l10n("local.local_changes_present_details_0e700004", { v0: parts.join(", ") })
    : l10n("local.local_changes_present_0e700005");
}

function ServerInfoRow({
  icon: Icon,
  label,
  value,
  dateTime,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  dateTime?: string | null;
}) {
  return (
    <div className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left">
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {dateTime ? (
          <time dateTime={dateTime} className="block break-words text-xs text-muted-foreground">
            {value}
          </time>
        ) : (
          <span className="block break-words text-xs text-muted-foreground">{value}</span>
        )}
      </span>
    </div>
  );
}

export function SidebarServerInfo() {
  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const enabled = experimentalQuery.data?.enableServerInfoDebugView === true;
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled,
    // The drawer only mounts while the account popover is open, so it cannot
    // rely on Layout's background health poll (which is itself gated on
    // devServer.enabled). Always refetch on open and poll while open so a server
    // restart is reflected without leaving stale boot-time serverInfo on screen.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const data = query.state.data as HealthStatus | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
  });

  if (!enabled) return null;

  const health = healthQuery.data;
  const isWaitingForHealth = healthQuery.isLoading && !health;
  const healthUnavailable = healthQuery.isError;
  const restartedAt = restartTimestamp(health);
  const restartedAtIsValid = isValidTimestamp(restartedAt);
  const lastRestartedLabel = healthUnavailable
    ? l10n("local.health_unavailable_ea4edd2b")
    : isWaitingForHealth
      ? l10n("local.loading_47d2a515")
      : formatTimestamp(restartedAt);
  const commit = healthUnavailable
    ? l10n("local.health_unavailable_ea4edd2b")
    : isWaitingForHealth
      ? l10n("local.loading_47d2a515")
      : commitLabel(health);
  const localChanges = healthUnavailable
    ? l10n("local.health_unavailable_ea4edd2b")
    : isWaitingForHealth
      ? l10n("local.loading_47d2a515")
      : localChangesLabel(health);

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="px-3 pb-1 pt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        {l10n("local.server_aef7de28")}</p>
      <ServerInfoRow
        icon={Clock3}
        label={l10n("local.last_restarted_865e87f0")}
        value={lastRestartedLabel}
        dateTime={!healthUnavailable && !isWaitingForHealth && restartedAtIsValid ? restartedAt : null}
      />
      <ServerInfoRow icon={GitCommit} label={l10n("local.running_commit_ac455328")} value={commit} />
      <ServerInfoRow icon={FileDiff} label={l10n("local.checkout_state_93896287")} value={localChanges} />
    </div>
  );
}
