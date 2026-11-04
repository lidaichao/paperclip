import type { ServerInfoSnapshot } from "@paperclipai/shared";
import { l10n } from "@/i18n";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { createApiError, fetchWithLocalizedNetworkError } from "./client";

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type CloudInstanceHealthStatus = {
  managed: true;
  managedBy: "paperclip-cloud";
  stackSlug: string | null;
  stackDisplayName?: string;
  cloudBaseUrl: string | null;
};

export type HealthStatus = {
  status: "ok";
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  localAiLoginSupported?: boolean;
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: DevServerHealthStatus;
  cloud?: CloudInstanceHealthStatus;
  /**
   * Settings surfaces hidden by the hosting operator (keys from the shared
   * settings-visibility registry). Absent when nothing is hidden.
   */
  hiddenSettings?: string[];
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetchWithLocalizedNetworkError("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw createApiError(
        payload?.error ?? `${l10n("local.health_check_failed_ce5ed1e6")} (${res.status})`,
        res.status,
        payload,
      );
    }
    return res.json();
  },
  requestDevServerRestart: async (): Promise<void> => {
    const res = await fetchWithLocalizedNetworkError("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw createApiError(
        payload?.error ?? `${l10n("local.failed_to_request_restart_9f76b99d")} (${res.status})`,
        res.status,
        payload,
      );
    }
  },
};
