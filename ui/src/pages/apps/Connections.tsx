import { l10n } from "../../i18n";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE } from "@paperclipai/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Cloud, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
import type {
  ToolApplication,
  ToolConnection,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import {
  humanizeConnectionDisplayName,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { accessApi } from "@/api/access";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { AppLogo } from "./AppLogo";
import { ConnectionProvenanceChip } from "./ConnectionProvenanceChip";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { useReviewCount } from "./useReviewCount";
import { connectionNameForCredentialPolicy, connectionTypeLabel } from "./connection-identity";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";

const BROWSE_HREF = "/apps";

type StatusFilter = "all" | "attention";

type AppStatus = {
  label: string;
  tone: "connected" | "attention" | "paused" | "not_connected";
};

type AppRow = {
  application: ToolApplication;
  connection: ToolConnection | null;
  displayName: string;
  brandKey: string;
  owner: ConnectionOwnerProfile | null;
  remainingAgentAvailableConnectionCount: number;
  status: AppStatus;
  actionCount: number;
  lastUsedAt: Date | string | null;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
};

/**
 * F6 (PAP-13254 / U3 §4): a single health signal is the source of truth for
 * BOTH the row highlight and the Status pill so they can never disagree. The
 * pill's `attention` tone and the row highlight are now the *same* predicate.
 */
function statusFor(application: ToolApplication, connections: ToolConnection[]): AppStatus {
  if (connections.some(isRetiredComposioConnection)) return { label: l10n("local.retired_a9f71bc2"), tone: "attention" };
  if (connections.length === 0) {
    return { label: l10n("local.not_connected_0303e182"), tone: "not_connected" };
  }
  if (
    application.status === "disabled" ||
    application.status === "archived" ||
    connections.every((connection) => connection.enabled === false || connection.status === "disabled")
  ) {
    return { label: l10n("local.paused_e159b061"), tone: "paused" };
  }
  if (connections.some((connection) => isAttentionHealthStatus(connection.healthStatus))) {
    return { label: l10n("local.needs_attention_c1ebc781"), tone: "attention" };
  }
  return { label: l10n("local.healthy_7f1e323b"), tone: "connected" };
}

/** The single health-derived predicate that drives highlight, pill, banner, filter (F6). */
function rowNeedsAttention(row: AppRow): boolean {
  return row.status.tone === "attention";
}

const STATUS_CLASS: Record<AppStatus["tone"], string> = {
  connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attention: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paused: "border-border bg-muted text-muted-foreground",
  not_connected: "border-border bg-background text-muted-foreground",
};

export function Connections() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const reviewCount = useReviewCount();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [connectionToDelete, setConnectionToDelete] = useState<{
    id: string;
    appName: string;
    remainingConnectionCount: number;

  } | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: l10n("local.connectors_c3d2e79e"), href: "/apps" },
      { label: l10n("local.connections_dc273117") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectorEnrollmentQuery = useQuery({
    queryKey: ["cloud-connector", "enrollment"],
    queryFn: () => toolsApi.getCloudConnectorEnrollment(),
  });
  const startConnectorEnrollment = useMutation({
    mutationFn: () => toolsApi.startCloudConnectorEnrollment(selectedCompanyId!, selectedCompany?.name),
    onSuccess: (status) => {
      if (status.verificationUrl) window.location.assign(status.verificationUrl);
    },
    onError: (error) => pushToast({
      title: l10n("local.couldn_t_reach_paperclip_cloud_79f03565"),
      body: error instanceof Error ? error.message : l10n("local.try_again_in_a_moment_29cc3339"),
      tone: "error",
    }),
  });

  const deleteConnection = useMutation({
    mutationFn: (target: {
      id: string;
      appName: string;
      remainingConnectionCount: number;

    }) =>
      toolsApi.archiveConnection(target.id),
    onSuccess: (_connection, target) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: l10n("local.connection_deleted_d0294a63"),
        body: target.remainingConnectionCount > 0
          ? l10n("local.value_still_has_value_active_value_available_cc4f89f0", {v0: (target.appName), v1: (target.remainingConnectionCount), v2: (target.remainingConnectionCount === 1 ? "connection" : "connections")})
          : l10n("local.value_is_no_longer_available_to_agents_and_it_38246371", {v0: (target.appName)}),
        tone: "success",
      });
      setConnectionToDelete(null);
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_delete_the_connection_1ef39603"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const logoByName = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionName(entry).toLowerCase(), entry);
    return map;
  }, [gallery]);
  const logoByKey = useMemo(() => {
    const map = new Map<string, AppGalleryDisplayEntry>();
    for (const entry of gallery) map.set(appDefinitionSlug(entry), entry);
    return map;
  }, [gallery]);

  // "Actions on" = enabled tools in each app's per-connection access profile,
  // mirroring what App detail shows so the count never disagrees with the page.
  const actionCountByConnection = useMemo(() => {
    const map = new Map<string, number>();
    for (const profile of profilesQuery.data?.profiles ?? []) {
      map.set(profile.profileKey, enabledActionCount(profile));
    }
    return map;
  }, [profilesQuery.data]);

  const connections = (connectionsQuery.data?.connections ?? []).filter(
    (c) => c.status !== "archived",
  );
  const applications = (applicationsQuery.data?.applications ?? []).filter(
    (application) => application.status !== "archived",
  );
  const connectionsByApplication = useMemo(() => {
    const map = new Map<string, ToolConnection[]>();
    for (const connection of connections) {
      map.set(connection.applicationId, [...(map.get(connection.applicationId) ?? []), connection]);
    }
    return map;
  }, [connections]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );

  const rows = useMemo<AppRow[]>(() => {
    return applications.flatMap((application): AppRow[] => {
      const appConnections = connectionsByApplication.get(application.id) ?? [];
      const appSourceSlug = appApplicationSourceSlug(application);
      const resolvedGalleryEntry = logoByKey.get(appSourceSlug ?? "") ??
        logoByName.get(application.name.toLowerCase());
      const logoUrl = appDefinitionLogoUrl(resolvedGalleryEntry);
      const brandKey = appSourceSlug ?? application.name;
      const darkLogoUrl = appDefinitionDarkLogoUrl(resolvedGalleryEntry);
      const agentAvailableConnectionCount = appConnections.filter(
        (connection) => connection.status === "active" && connection.enabled,
      ).length;
      if (appConnections.length === 0) {
        return [{
          application,
          connection: null,
          displayName: application.name,
          brandKey,
          owner: null,
          remainingAgentAvailableConnectionCount: 0,
          status: statusFor(application, []),
          actionCount: 0,
          lastUsedAt: null,
          logoUrl,
          darkLogoUrl,
        }];
      }
      return appConnections.map((connection) => {
        const owner = connectionOwnerProfile(connection, userProfileById);
        const type = connectionTypeLabel(connection.credentialPolicy);
        const displayName = type === "Organization"
          ? connectionNameForCredentialPolicy(
              humanizeConnectionDisplayName(connection),
              connection.credentialPolicy,
            )
          : connectionDisplayNameForOwner(connection, application.name, owner);
        return {
          application,
          connection,
          displayName,
          brandKey,
          owner,
          remainingAgentAvailableConnectionCount: Math.max(
            0,
            agentAvailableConnectionCount -
              (connection.status === "active" && connection.enabled ? 1 : 0),
          ),
          status: statusFor(application, [connection]),
          actionCount: actionCountByConnection.get(`app:${connection.id}`) ?? 0,
          lastUsedAt: connection.lastUsedAt ?? null,
          logoUrl,
          darkLogoUrl,
        };
      });
    });
  }, [actionCountByConnection, applications, connectionsByApplication, logoByKey, logoByName, userProfileById]);

  const rowsNeedingAttention = rows.filter(rowNeedsAttention);
  const visibleRows = filter === "attention" ? rowsNeedingAttention : rows;

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{l10n("local.select_an_organization_to_manage_apps_c62bf64e")}</div>;
  }

  const loading = applicationsQuery.isLoading || connectionsQuery.isLoading || galleryQuery.isLoading;

  return (
    <div className="max-w-5xl space-y-5">
      {!connectorEnrollmentQuery.isLoading ? (
        <CloudConnectorEnrollmentBanner
          status={connectorEnrollmentQuery.data}
          unavailable={connectorEnrollmentQuery.isError}
          busy={startConnectorEnrollment.isPending}
          onEnable={() => {
            const verificationUrl = connectorEnrollmentQuery.data?.verificationUrl;
            if (verificationUrl) window.location.assign(verificationUrl);
            else startConnectorEnrollment.mutate();
          }}
        />
      ) : null}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyConnections onBrowse={() => navigate(BROWSE_HREF)} />
      ) : (
        <div className="space-y-5">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{l10n("local.connections_dc273117")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {l10n("local.the_tools_you_ve_connected_and_whether_they_r_86c96136")}</p>
            </div>
            <Button onClick={() => navigate(BROWSE_HREF)}>{l10n("local.connect_an_app_bf6c07f8")}</Button>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              {l10n("local.all_6ddbebad")}{rows.length})
            </FilterChip>
            <FilterChip
              active={filter === "attention"}
              tone="danger"
              disabled={rowsNeedingAttention.length === 0}
              onClick={() => setFilter("attention")}
            >
              {l10n("local.needs_attention_41b551ee")}{rowsNeedingAttention.length})
            </FilterChip>
          </div>

          {reviewCount > 0 && (
            <button
              type="button"
              onClick={() => navigate("/apps/review")}
              className="flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left transition-colors hover:bg-amber-500/15"
            >
              <ShieldQuestion className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {reviewCount} {reviewCount === 1 ? l10n("local.action_is_547602d8") : l10n("local.actions_are_5273e4e9")} {l10n("local.waiting_for_your_ok_ee8bba46")}</div>
                <div className="truncate text-xs text-amber-700 dark:text-amber-300">
                  {l10n("local.your_agents_paused_to_check_with_you_before_m_c81a8bf4")}</div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-amber-800 dark:text-amber-200">{l10n("local.review_ab7681ea")}</span>
            </button>
          )}

          {rowsNeedingAttention.length > 0 && (
            <button
              type="button"
              onClick={() => setFilter("attention")}
              className="flex w-full items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-left transition-colors hover:bg-red-500/15"
            >
              <ShieldAlert className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-red-900 dark:text-red-100">
                  {rowsNeedingAttention.length} {rowsNeedingAttention.length === 1 ? l10n("local.connection_needs_015cb247") : l10n("local.connections_need_9b7c9d6d")} {l10n("local.attention_e0787d27")}</div>
                <div className="truncate text-xs text-red-700 dark:text-red-300">
                  {floatSummary(rowsNeedingAttention)}
                </div>
              </div>
              <span className="shrink-0 text-xs font-semibold text-red-800 dark:text-red-200">{l10n("local.fix_9049952f")}</span>
            </button>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">{l10n("local.connection_639a40e8")}</th>
                  <th className="px-4 py-2.5">{l10n("local.type_baaddf70")}</th>
                  <th className="px-4 py-2.5">{l10n("local.connected_by_9952ce52")}</th>
                  <th className="px-4 py-2.5">{l10n("local.status_920e413c")}</th>
                  <th className="px-4 py-2.5">{l10n("local.actions_ff8059dc")}</th>
                  <th className="px-4 py-2.5">{l10n("local.last_used_830ec7f8")}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const { application, connection, status } = row;
                  const attention = rowNeedsAttention(row);
                  const hint =
                    connection && isRetiredComposioConnection(connection) ? RETIRED_COMPOSIO_MESSAGE :
                    status.tone === "attention"
                      ? connection?.authKind === "oauth"
                        ? l10n("local.reconnect_required_sign_in_again_to_restore_a_50f21863")
                        : l10n("local.the_key_stopped_working_reconnect_to_fix_012b6f58")
                      : status.tone === "paused"
                        ? l10n("local.paused_agents_can_t_use_it_right_now_dade03b2")
                        : status.tone === "not_connected"
                          ? l10n("local.connect_it_so_agents_can_use_it_1b1eda62")
                          : row.displayName !== application.name
                            ? application.name
                            : null;
                  const appHref = connection
                    ? `/apps/${connection.id}/permissions`
                    : `/apps/app/${application.id}/permissions`;
                  const actionLabel = !connection
                    ? l10n("local.connect_1a2303ed")
                    : connection && isRetiredComposioConnection(connection) ? l10n("local.review_aff0766a")
                    : status.tone === "attention"
                      ? l10n("local.reconnect_bf8a9eab")
                      : l10n("local.permissions_abccc78c");
                  return (
                    <tr
                      key={connection?.id ?? application.id}
                      onClick={() => navigate(appHref)}
                      className={cn(
                        "cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30",
                        attention && "bg-amber-500/[0.06]",
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AppLogo
                            name={row.displayName}
                            brandKey={row.brandKey}
                            logoUrl={row.logoUrl}
                            darkLogoUrl={row.darkLogoUrl}
                            size={32}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-foreground">{row.displayName}</span>
                              <ConnectionProvenanceChip connection={row.connection} />
                            </div>
                            {hint && (
                              <div className="truncate text-xs text-muted-foreground">{hint}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium text-foreground">
                          {connection ? connectionTypeLabel(connection.credentialPolicy) : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ConnectionOwnerIdentity owner={row.owner} />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                            STATUS_CLASS[status.tone],
                          )}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground">{row.actionCount} {l10n("local.on_b8d31e85")}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground">
                          {row.lastUsedAt ? timeAgo(row.lastUsedAt) : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant={attention ? "default" : "outline"}
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(appHref);
                            }}
                          >
                            {actionLabel}
                          </Button>
                          {connection && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={l10n("local.delete_value_connection_51b7d922", {v0: (row.displayName)})}
                              onClick={(event) => {
                                event.stopPropagation();
                                setConnectionToDelete({
                                  id: connection.id,
                                  appName: application.name,
                                  remainingConnectionCount: row.remainingAgentAvailableConnectionCount,

                                });
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {l10n("local.apps_you_connect_become_available_to_every_ag_b1c276b4")}</p>
          </div>
        </div>
      )}

      <AlertDialog
        open={connectionToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteConnection.isPending) setConnectionToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {l10n("local.delete_e2d0a549")}{" "}{connectionToDelete?.appName ?? l10n("local.this_1eb79602")} {l10n("local.connection_1df40080")}</AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToDelete && connectionToDelete.remainingConnectionCount > 0
                ? l10n("local.this_connection_s_saved_credentials_are_delet_de0446d5", {v0: (connectionToDelete.appName), v1: (connectionToDelete.remainingConnectionCount), v2: (connectionToDelete.remainingConnectionCount === 1 ? "connection" : "connections")})
                : l10n("local.the_saved_credentials_are_deleted_and_agents_a1f881ce")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteConnection.isPending}>{l10n("local.cancel_19766ed6")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToDelete || deleteConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToDelete) deleteConnection.mutate(connectionToDelete);
              }}
            >
              {deleteConnection.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleteConnection.isPending ? l10n("local.deleting_685ecb98") : l10n("local.delete_connection_e960651b")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CloudConnectorEnrollmentBanner({
  status,
  unavailable,
  busy,
  onEnable,
}: {
  status: Awaited<ReturnType<typeof toolsApi.getCloudConnectorEnrollment>> | undefined;
  unavailable: boolean;
  busy: boolean;
  onEnable: () => void;
}) {
  if (status?.configured) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{l10n("local.paperclip_managed_sign_in_is_ready_267735c5")}</div>
          <div className="truncate text-xs text-muted-foreground">
            {l10n("local.provider_authorization_uses_8a73b2b9")}{" "}{status.brokerBaseUrl}{l10n("local._credentials_stay_in_this_instance_d404b53a")}</div>
        </div>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <Cloud className="h-5 w-5 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">{l10n("local.paperclip_cloud_enrollment_status_is_unavaila_92a8b207")}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <Cloud className="h-5 w-5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">
          {status?.status === "pending" ? l10n("local.finish_paperclip_cloud_enrollment_7a2c43bc") : l10n("local.enable_paperclip_managed_sign_in_fd849c56")}
        </div>
        <div className="text-xs text-muted-foreground">
          {l10n("local.confirm_this_server_s_exact_address_before_cl_895b8776")}</div>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={onEnable}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {status?.status === "pending" ? l10n("local.continue_enrollment_97317cdb") : l10n("local.enable_5342e09f")}
      </Button>
    </div>
  );
}

function FilterChip({
  active,
  tone = "default",
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "default" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        disabled && "cursor-not-allowed opacity-50",
        active
          ? tone === "danger"
            ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
            : "border-foreground/30 bg-foreground/[0.06] text-foreground"
          : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function enabledActionCount(profile: ToolProfileWithDetails): number {
  let count = 0;
  for (const entry of profile.entries ?? []) {
    if (entry.effect === "include" && entry.catalogEntryId) count += 1;
  }
  return count;
}

function floatSummary(rows: AppRow[]): string {
  const names = rows.map((row) => humanizeConnectionDisplayName(row.application.name));
  if (names.length <= 2) return names.join(" and ");
  return l10n("local.value_and_value_more_5ecd806c", {v0: (names.slice(0, 2).join(", ")), v1: (names.length - 2)});
}

function EmptyConnections({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{l10n("local.connections_dc273117")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.the_tools_you_ve_connected_and_whether_they_r_86c96136")}</p>
      </header>

      <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <AppWindow className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">{l10n("local.no_connections_yet_643013cd")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.add_one_from_9be40f98")}{" "}<span className="font-medium text-foreground">{l10n("local.apps_89dd7484")}</span> {l10n("local.to_give_your_agents_the_tools_they_need_cffbfb3f")}</p>
        <Button className="mt-6" onClick={onBrowse}>
          {l10n("local.browse_apps_cc28cdd0")}</Button>
      </div>
    </div>
  );
}
