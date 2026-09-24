import { l10n, englishPluralSuffix } from "../i18n";
import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { Badge } from "@/components/ui/badge";

const RESTART_PENDING_RESET_MS = 30_000;

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return "backend files changed and migrations are pending";
  }
  if (devServer.reason === "pending_migrations") {
    return "pending migrations need a fresh boot";
  }
  return "backend files changed since this server booted";
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const [restartPending, setRestartPending] = useState(false);
  useEffect(() => {
    if (!restartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending]);

  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const currentDevServer = devServer;
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunLabel = l10n("local.value_live_runvalue_0a264267", {v0: (devServer.activeRunCount), v1: (englishPluralSuffix(devServer.activeRunCount === 1 ? "" : "s"))});

  async function requestRestartNow() {
    const warning =
      currentDevServer.activeRunCount > 0
        ? `Restart Paperclip now? This may interrupt ${activeRunLabel}.`
        : "Restart Paperclip now?";
    if (!window.confirm(warning)) return;

    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      window.alert(error instanceof Error ? error.message : "Failed to request restart");
    }
  }

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{l10n("local.restart_required_5e0716dc")}</span>
            {devServer.autoRestartEnabled ? (
              <Badge variant="ghost" className="bg-amber-900/10 text-(length:--text-nano) tracking-(--tracking-eyebrow) dark:bg-amber-100/10">
                {l10n("local.auto_restart_on_0bf77a45")}</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer)}
            {changedAt ? (" " + l10n("local._updated_value_7cd278df", {v0: (changedAt)})) : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {l10n("local.changed_d88b1fed")}{" "}{sample.join(", ")}
                {devServer.changedPathCount > sample.length ? (" " + l10n("local._value_more_8769eb5d", {v0: (devServer.changedPathCount - sample.length)})) : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {l10n("local.pending_migrations_f1b64595")}{" "}{devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? (" " + l10n("local._value_more_8769eb5d", {v0: (devServer.pendingMigrations.length - 2)})) : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{l10n("local.waiting_for_68a86b7b")}{" "}{activeRunLabel} {l10n("local.to_finish_2f0b207d")}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{l10n("local.auto_restart_will_trigger_when_the_instance_i_f49f9acf")}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{l10n("local.restart_6b983a81")}{" "}<code>pnpm dev:once</code> {l10n("local.after_the_active_work_is_safe_to_interrupt_f2411124")}</span>
            </div>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
            onClick={() => {
              void requestRestartNow();
            }}
            disabled={restartPending}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{restartPending ? l10n("local.restart_requested_8427d283") : l10n("local.restart_now_09af1002")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
