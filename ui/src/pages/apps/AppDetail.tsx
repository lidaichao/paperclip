import { l10n } from "../../i18n";
import { isRetiredComposioConnection, RETIRED_COMPOSIO_MESSAGE, isRemoteMcpConnectorId, isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { RemoteMcpManagement } from "@/features/connections/remote-mcp/RemoteMcpManagement";
import { remoteMcpProviders } from "@/features/connections/remote-mcp/providers";
import { ManagedAiConnectionDetails } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmailConnectionAccess } from "@/components/EmailConnectionAccess";
import { EmailConnectionInboxes } from "./chat/EmailEndpointSetup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil } from "lucide-react";
import type {
  ToolApplication,
  ToolConnection,
  ToolPolicy,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import {
  connectionDisplaySecondaryHint,
  humanizeConnectionDisplayName,
  aiSubscriptionNeedsIsolatedLogin,
  isToolConnectionAttentionHealth as isAttentionHealthStatus,
} from "@paperclipai/shared";
import { Navigate, useParams, useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { installStateFrom, type InstallState } from "@/lib/tool-installs";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { UnverifiedServerBadge } from "./UnverifiedServerBadge";
import {
  appApplicationSourceSlug,
  appConnectionSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import { appTabHref, appTabLabel, isAppTabKey, type AppTabKey } from "./app-tabs";
import { ConnectionProvenanceChip } from "./ConnectionProvenanceChip";
import { IdentitiesSection } from "./app-detail/IdentitiesSection";
import { PermissionsPanel } from "./app-detail/PermissionsPanel";
import { RailwayAccessPanel } from "./app-detail/RailwayAccessPanel";
import { ReviewPanel } from "./app-detail/ReviewPanel";
import {
  ReconnectCard,
  DangerZone,
  connectionAddress,
  connectionTransportLabel,
} from "./app-detail/AdvancedPanel";
import type { AccessDraft } from "./app-detail/types";
import {
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
} from "./connection-owner";

export { connectionAddress, connectionTransportLabel };

export function AppDetail({ renderActions, onReconnect }: {
  renderActions?: (connection: ToolConnection) => ReactNode;
  onReconnect?: (connection: ToolConnection) => void;
} = {}) {
  const { connectionId = "", tab } = useParams<{ connectionId: string; tab?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const activeTab: AppTabKey | null = isAppTabKey(tab) ? tab : null;
  const needsCatalog = activeTab === "review" || activeTab === "permissions";

  const connectionQuery = useQuery({
    queryKey: queryKeys.tools.connection(connectionId),
    queryFn: () => toolsApi.getConnection(connectionId),
    enabled: !!connectionId && !!activeTab,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const installsQuery = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: () => toolsApi.getConnectionInstalls(connectionId),
    enabled: !!connectionId && activeTab === "permissions",
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.tools.catalog(connectionId),
    queryFn: () => toolsApi.listCatalog(connectionId),
    enabled: !!connectionId && needsCatalog,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId && (activeTab === "review" || activeTab === "permissions"),
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listPolicies(selectedCompanyId!),
    enabled: !!selectedCompanyId && (activeTab === "review" || activeTab === "permissions"),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "permissions",
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!activeTab,
  });
  // Identity grants drive reconnect authorization on every tab as well as the
  // Permissions controls. A personal reconnect belongs to one fixed user, so
  // the banner must not offer that action to anyone else.
  const grantsQuery = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: () => toolsApi.listConnectionGrants(connectionId),
    enabled: !!connectionId && !!activeTab,
  });

  const connection = connectionQuery.data;
  const application = connection
    ? (applicationsQuery.data?.applications ?? []).find((candidate) => candidate.id === connection.applicationId)
    : undefined;
  const grantRows = grantsQuery.data?.grants ?? [];
  const retainedPersonalGrant = connection?.credentialPolicy === "per_user"
    ? grantRows.find((grant) => (
      grant.kind === "user" && grant.subjectUserId === connection.createdByUserId
    ))
      ?? grantRows.find((grant) => grant.kind === "user" && grant.status === "active")
      ?? grantRows.find((grant) => grant.kind === "user")
      ?? null
    : null;
  const currentUserPersonalGrant = grantRows.find((grant) => (
    grant.kind === "user" && grant.subjectUserId === grantsQuery.data?.currentUserId
  )) ?? null;
  const retainedAgentGrant = connection?.credentialPolicy === "per_agent"
    ? grantRows.find((grant) => grant.kind === "agent" && grant.status === "active")
      ?? grantRows.find((grant) => grant.kind === "agent")
      ?? null
    : null;
  const retainedOrganizationGrant = grantRows.find((grant) => (
    grant.kind === "organization" && grant.isDefault
  )) ?? grantRows.find((grant) => grant.kind === "organization") ?? null;
  const managedIdentityGrant = connection?.credentialPolicy === "per_user"
    ? currentUserPersonalGrant ?? retainedPersonalGrant
    : connection?.credentialPolicy === "per_agent"
      ? retainedAgentGrant
    : connection?.credentialPolicy === "per_user_with_fallback"
      ? currentUserPersonalGrant ?? retainedOrganizationGrant
      : retainedOrganizationGrant;
  const managedPersonalUserId = managedIdentityGrant?.kind === "user"
    ? managedIdentityGrant.subjectUserId ?? connection?.createdByUserId ?? null
    : null;
  const canReconnect = managedIdentityGrant?.kind === "user"
    ? Boolean(
      managedPersonalUserId
      && managedPersonalUserId === grantsQuery.data?.currentUserId
      && grantsQuery.data?.capabilities.canConnectAsCurrentUser,
    )
    : grantsQuery.data?.capabilities.canConfigure === true;
  const reconnectUnavailableMessage = grantsQuery.isLoading
    ? l10n("local.checking_who_can_reconnect_this_identity_6e1a0df1")
    : grantsQuery.isError
      ? l10n("local.we_couldn_t_verify_who_can_reconnect_this_ide_3dca45b9")
      : managedIdentityGrant?.kind === "user"
        && managedPersonalUserId !== grantsQuery.data?.currentUserId
        ? l10n("local.the_person_this_connection_belongs_to_must_re_f6a7ad9a")
        : l10n("local.you_don_t_have_permission_to_reconnect_this_i_b611d45d");
  const logoEntry = useMemo(
    () => galleryEntryFor((galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[], connection, application),
    [galleryQuery.data, connection, application],
  );
  const brandKey = appApplicationSourceSlug(application)
    ?? appConnectionSourceSlug(connection)
    ?? (logoEntry ? appDefinitionSlug(logoEntry) : null);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const owner = connection ? connectionOwnerProfile(connection, userProfileById) : null;
  const baseAppName = connection
    ? logoEntry ? appDefinitionName(logoEntry) : humanizeConnectionDisplayName(connection)
    : "App";
  const appName = connection
    ? connectionDisplayNameForOwner(connection, baseAppName, owner)
    : "App";
  const successNoticeShownFor = useRef<string | null>(null);

  useEffect(() => {
    if (
      activeTab !== "permissions"
      || searchParams.get("success") !== "1"
      || !connection
      || successNoticeShownFor.current === connection.id
    ) return;
    successNoticeShownFor.current = connection.id;
    pushToast({
      title: l10n("local.value_connected_db4ed330", {v0: (appName)}),
      body: l10n("local.the_connection_is_ready_review_permissions_or_8871194a"),
      tone: "success",
    });
    navigate(appTabHref(connection.id, "permissions"), { replace: true });
  }, [activeTab, appName, connection, navigate, pushToast, searchParams]);

  useEffect(() => {
    if (!activeTab) return;
    setBreadcrumbs([
      { label: l10n("local.connectors_c3d2e79e"), href: "/apps" },
      { label: appName, href: appTabHref(connectionId, "permissions") },
      { label: appTabLabel(activeTab) },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, appName, connectionId, activeTab]);

  const catalog = catalogQuery.data?.catalog ?? [];
  const profile = useMemo(
    () => (profilesQuery.data?.profiles ?? []).find((p) => p.profileKey === `app:${connectionId}`),
    [profilesQuery.data, connectionId],
  );
  const enabledIds = useMemo(() => enabledCatalogIds(profile), [profile]);
  const askFirstIds = useMemo(
    () => askFirstCatalogIds(policiesQuery.data?.policies ?? [], connectionId),
    [policiesQuery.data, connectionId],
  );
  const install = useMemo(
    () => installStateFrom(installsQuery.data?.installs ?? connection?.installs),
    [connection?.installs, installsQuery.data?.installs],
  );
  const access = useMemo(() => accessFrom(connection?.connectionPurpose === "ai" ? undefined : profile, install), [connection?.connectionPurpose, profile, install]);
  const managesRemoteMcpAccess = isRemoteMcpConnectorMethod(connection?.config?.sourceTemplateKey, connection?.config?.connectionMethodKey);
  const agents = agentsQuery.data ?? [];
  const disconnectRemote = useMutation({
    mutationFn: () => toolsApi.archiveConnection(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      navigate("/apps");
    },
    onError: (error) => pushToast({ title: l10n("local.couldn_t_disconnect_a5ff5ce6"), body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"), tone: "error" }),
  });
  const [pending, setPending] = useState(false);
  const persist = useMutation({
    mutationFn: async (next: {
      enabled: Set<string>;
      askFirst: Set<string>;
      access: AccessDraft;
      reviewed?: Set<string>;
    }) => {
      return connection?.connectionPurpose === "ai"
      ? toolsApi.putConnectionInstalls(connectionId, next.access.mode === "all" ? [{ targetType: "company", targetId: selectedCompanyId! }] : [...next.access.agentIds].map(targetId => ({ targetType: "agent" as const, targetId })))
      : toolsApi.finishApp(selectedCompanyId!, connectionId, {
        enabledCatalogEntryIds: [...next.enabled],
        askFirstCatalogEntryIds: [...next.askFirst].filter((id) => next.enabled.has(id)),
        ...(next.reviewed ? { reviewedCatalogEntryIds: [...next.reviewed] } : {}),
        access: next.access.mode === "all" ? "all_agents" : { agentIds: [...next.access.agentIds] },
      });
    },
    onMutate: () => setPending(true),
    onSuccess: () => {
      void installsQuery.refetch();
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.catalog(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.policies(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_save_that_4ee3e155"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
    onSettled: () => setPending(false),
  });

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const rename = useMutation({
    mutationFn: (name: string) => toolsApi.updateConnection(connectionId, { name }),
    onSuccess: () => {
      setRenaming(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_rename_the_app_dba458bc"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
  });

  const startOAuth = useMutation({
    mutationFn: (input?: { asAgentId?: string }) => toolsApi.startOAuth(connectionId, input),
    onSuccess: async (start) => {
      try {
        const target = await prepareOAuthNavigation(start);
        if (target.kind === "reauthentication" && start.handoff) {
          savePendingCloudHandoff(start.handoff.session);
        }
        navigateTopLevel(target.url);
      } catch (error) {
        pushToast({
          title: l10n("local.couldn_t_start_sign_in_3f9bac4a"),
          body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_start_sign_in_3f9bac4a"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
  });

  const invalidateGrants = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
  };

  /**
   * "Connect as me" and "Reconnect" for the signed-in user's own identity. The
   * subject is always the caller — the server refuses any other subject — so
   * there is no path here to start consent on a coworker's behalf.
   */
  const startPersonalAuth = useMutation({
    mutationFn: () => {
      const subjectUserId = grantsQuery.data?.currentUserId;
      if (!subjectUserId) throw new Error("Sign in again to connect your own account.");
      return toolsApi.startPersonalAuthorization(selectedCompanyId!, connectionId, {
        subjectUserId,
        returnTo: appTabHref(connectionId, "permissions"),
      });
    },
    onSuccess: async ({ url, handoff }) => {
      try {
        const target = await prepareOAuthNavigation({ authorizationUrl: url, handoff });
        if (target.kind === "reauthentication" && handoff) {
          savePendingCloudHandoff(handoff.session);
        }
        navigateTopLevel(target.url);
      } catch (error) {
        pushToast({
          title: l10n("local.couldn_t_start_sign_in_3f9bac4a"),
          body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_start_sign_in_3f9bac4a"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
  });

  // A denied or conflicting audience save keeps the dialog open with the
  // selection intact, so the error is surfaced inline rather than as a toast.
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [audienceOpenGrantId, setAudienceOpenGrantId] = useState<string | null>(null);
  const replaceAudience = useMutation({
    mutationFn: ({ grantId, memberUserIds }: { grantId: string; memberUserIds: string[] }) =>
      toolsApi.replaceConnectionGrantMembers(connectionId, grantId, memberUserIds),
    onMutate: () => setAudienceError(null),
    onSuccess: (grant) => {
      invalidateGrants();
      setAudienceOpenGrantId(null);
      pushToast({
        title: l10n("local.audience_saved_b7ee24e0"),
        body: (grant.members?.length ?? 0) === 0
          ? l10n("local.every_organization_member_can_use_this_identi_5c8fd994")
          : l10n("local.value_value_can_use_this_identity_68b80c63", {v0: (grant.members?.length), v1: (grant.members?.length === 1 ? "member" : "members")}),
        tone: "success",
      });
    },
    onError: (error) =>
      setAudienceError(error instanceof Error ? error.message : "We couldn't save that audience."),
  });

  const refreshTools = useMutation({
    mutationFn: () => toolsApi.refreshCatalog(connectionId),
    onSuccess: (result) => {
      // Discovery extends the app profile for new actions as well as the catalog.
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.policies(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.catalog(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: l10n("local.found_value_value_ca8d9bb0", {v0: (result.discoveredCount), v1: (result.discoveredCount === 1 ? "action" : "actions")}),
        body: result.quarantinedCount > 0
          ? l10n("local.value_new_value_your_ok_d375e2e1", {v0: (result.quarantinedCount), v1: (result.quarantinedCount === 1 ? "action needs" : "actions need")})
          : undefined,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_refresh_actions_17b3912d"),
        body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
        tone: "error",
      }),
  });
  const refreshGitHubAccess = useMutation({
    mutationFn: () => toolsApi.checkConnectionHealth(connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId!) });
      pushToast({
        title: l10n("local.github_access_refreshed_477eae62"),
        body: l10n("local.account_installation_and_repository_access_ar_6baf51ab"),
        tone: "success",
      });
    },
    onError: (error) => pushToast({
      title: l10n("local.couldn_t_refresh_github_access_f01f0fd3"),
      body: error instanceof Error ? error.message : l10n("local.please_try_again_eea4fb33"),
      tone: "error",
    }),
  });

  const apply = (mutate: {
    enabled?: Set<string>;
    askFirst?: Set<string>;
    access?: AccessDraft;
    reviewed?: Set<string>;
  }) =>
    persist.mutate({
      enabled: mutate.enabled ?? new Set(enabledIds),
      askFirst: mutate.askFirst ?? new Set(askFirstIds),
      access: mutate.access ?? access,
      reviewed: mutate.reviewed,
    });

  const reviewQuarantined = (allowedIds: string[]) => {
    const quarantinedIds = new Set(quarantined.map((entry) => entry.id));
    const nextEnabled = new Set([...enabledIds].filter((id) => !quarantinedIds.has(id)));
    for (const id of allowedIds) nextEnabled.add(id);
    apply({ enabled: nextEnabled, reviewed: quarantinedIds });
  };

  // Keep old bookmarks and OAuth return URLs working after Setup and Test were
  // consolidated into Permissions, and Activity moved to the company feed.
  if (connectionId && (tab === "setup" || tab === "test")) {
    const query = searchParams.toString();
    return <Navigate replace to={`${appTabHref(connectionId, "permissions")}${query ? `?${query}` : ""}`} />;
  }
  if (tab === "activity") {
    return <Navigate replace to="/activity?action=tool_" />;
  }

  if (!connectionId || !activeTab) {
    return <Navigate replace to={connectionId ? appTabHref(connectionId, "permissions") : "/apps"} />;
  }

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{l10n("local.select_an_organization_to_manage_apps_c62bf64e")}</div>;
  }
  if (connectionQuery.isLoading) {
    return (
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!connection) {
    return (
      <div className="max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">{l10n("local.we_couldn_t_find_that_app_3dffbbcc")}</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/apps")}>
          {l10n("local.back_to_connectors_4bb96fc6")}</Button>
      </div>
    );
  }

  if (isRetiredComposioConnection(connection)) {
    return <div className="max-w-4xl space-y-6 pb-12">
      <h1 className="text-xl font-semibold">{appName}</h1>
      <section role="status" className="space-y-3 rounded-lg border border-border bg-muted p-4">
        <h2 className="text-sm font-semibold">{l10n("local.connection_retired_3e3a4449")}</h2>
        <p className="text-sm text-muted-foreground">{RETIRED_COMPOSIO_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">{l10n("local.remove_each_obsolete_connection_separately_re_88588683")}</p>
        <Button variant="outline" onClick={() => navigate("/apps/connect?source=composio")}>{l10n("local.add_composio_mcp_connection_bbc2fe79")}</Button>
      </section>
      {grantsQuery.data?.capabilities.canConfigure === true && <DangerZone
        appName={appName}
        removing={disconnectRemote.isPending}
        onRemove={() => disconnectRemote.mutate()}
      />}
    </div>;
  }

  const aiGrantRevoked = connection.connectionPurpose === "ai"
    && grantRows.length > 0 && grantRows.every((grant) => grant.status === "revoked");
  const status: StatusInfo = aiGrantRevoked ? { label: l10n("local.revoked_f6f738d0"), tone: "attention" } : statusFor(connection);
  const needsReconnect = connection.requiresReauthorization
    ?? (status.tone === "attention" && connection.healthStatus !== "unknown");
  const quarantined = catalog.filter((e) => e.status === "quarantined");
  const active = catalog.filter((e) => e.status === "active");
  const readOnly = active.filter((e) => e.isReadOnly);
  const canChange = active.filter((e) => !e.isReadOnly);
  const actionsContent = renderActions?.(connection) ?? (connection.connectionPurpose === "ai" ? <ManagedAiConnectionDetails connection={connection} /> : undefined);
  const actionCount = actionsContent !== undefined ? null : catalogQuery.data ? active.length : null;
  const reviewLoading = catalogQuery.isLoading || profilesQuery.isLoading || policiesQuery.isLoading;
  const permissionsLoading = reviewLoading || installsQuery.isLoading || agentsQuery.isLoading;
  const reviewFailed = catalogQuery.isError || profilesQuery.isError || policiesQuery.isError;
  const permissionsFailed = reviewFailed || installsQuery.isError || agentsQuery.isError;

  return (
    <div className="max-w-4xl space-y-10 pb-12">
      <AppDetailHeader
        appName={appName}
        connection={connection}
        logoEntry={logoEntry}
        brandKey={brandKey}
        allowRemoteLogo={!applicationsQuery.isPending}
        status={status}
        actionCount={actionCount}
        renaming={renaming}
        nameDraft={nameDraft}
        renamePending={rename.isPending}
        onNameDraftChange={setNameDraft}
        onRenameStart={() => {
          setNameDraft(appName);
          setRenaming(true);
        }}
        onRenameCancel={() => setRenaming(false)}
        onRenameSubmit={(next) => {
          if (next && next !== appName) rename.mutate(next);
          else setRenaming(false);
        }}
      />

      {status.tone === "attention" && connection.requiresReauthorization === false && (
        <div role="status">
          <p>{connection.healthMessage || l10n("local.github_access_could_not_be_checked_try_again_68854351")}</p>
          <Button variant="outline" disabled={refreshGitHubAccess.isPending} onClick={() => refreshGitHubAccess.mutate()}>
            {l10n("local.retry_access_e5222230")}</Button>
        </div>
      )}
      {needsReconnect && (
        <ReconnectCard
          connection={connection}
          galleryEntry={logoEntry}
          canReconnect={canReconnect}
          reconnectUnavailableMessage={reconnectUnavailableMessage}
          onReconnect={onReconnect ? () => onReconnect(connection) : (connection.connectionPurpose === "ai" || isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey)) ? () => navigate(`/apps/connect?source=${connection.config?.sourceTemplateKey}&reconnect=${connection.id}`) : undefined}
          onReconnected={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(selectedCompanyId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
          }}
        />
      )}

      {activeTab === "review" && (
        reviewFailed
          ? <ToolsLoadError onRetry={() => {
              void catalogQuery.refetch();
              void profilesQuery.refetch();
              void policiesQuery.refetch();
            }} />
          : reviewLoading
          ? <ToolsLoading />
          : <ReviewPanel
              connectionId={connectionId}
              quarantined={quarantined}
              pending={pending}
              onReviewQuarantined={reviewQuarantined}
            />
      )}
      {activeTab === "permissions" && (
        permissionsFailed
          ? <ToolsLoadError onRetry={() => {
              void catalogQuery.refetch();
              void profilesQuery.refetch();
              void policiesQuery.refetch();
              void installsQuery.refetch();
              void agentsQuery.refetch();
            }} />
          : permissionsLoading
          ? <ToolsLoading />
          : <div className="space-y-10">
              {connection.config?.sourceTemplateKey === "railway" && <RailwayAccessPanel connection={connection} grants={grantsQuery.data} />}
              {connection.config?.provider === "agentmail" && <EmailConnectionInboxes companyId={connection.companyId} connectionId={connection.id} canConfigure={grantsQuery.data?.capabilities?.canConfigure ?? false} />}
              {connection.config?.provider === "agentmail" ? <EmailConnectionAccess companyId={connection.companyId} connectionId={connection.id} agents={agents} /> : <>
              <IdentitiesSection
                appName={appName}
                credentialPolicy={connection.credentialPolicy}
                ownerUserId={connection.createdByUserId}
                connectedUser={owner}
                dedicatedAgent={managedIdentityGrant?.kind === "agent"
                  ? agents.find((agent) => agent.id === managedIdentityGrant.subjectAgentId) ?? null
                  : null}
                grantsQuery={grantsQuery.data}
                loading={grantsQuery.isLoading}
                error={grantsQuery.isError}
                connectPending={startPersonalAuth.isPending || startOAuth.isPending}
                audiencePending={replaceAudience.isPending}
                audienceError={audienceError}
                audienceGrantId={audienceOpenGrantId}
                onOpenAudience={(grantId) => {
                  setAudienceError(null);
                  setAudienceOpenGrantId(grantId);
                }}
                onCloseAudience={() => {
                  setAudienceOpenGrantId(null);
                  setAudienceError(null);
                }}
                onConnectAsMe={() => onReconnect ? onReconnect(connection) : startPersonalAuth.mutate()}
                onConnectOrganization={() => onReconnect ? onReconnect(connection) : startOAuth.mutate()}
                onConnectAgent={(agentId) => startOAuth.mutate({ asAgentId: agentId })}
                onRefreshAccess={() => refreshGitHubAccess.mutate()}
                refreshAccessPending={refreshGitHubAccess.isPending}
                onReplaceAudience={(grant, memberUserIds) =>
                  replaceAudience.mutate({ grantId: grant.id, memberUserIds })}
              />
              {isRemoteMcpConnectorMethod(connection.config?.sourceTemplateKey, connection.config?.connectionMethodKey) && <p className="text-sm text-muted-foreground">{l10n("local.paperclip_controls_access_to_the_tools_listed_ba12d624")}{" "}{baseAppName}.</p>}
              <PermissionsPanel
                actions={actionsContent}
                connectionId={connectionId}
                capabilities={grantsQuery.data?.capabilities}
                appName={appName}
                agents={agents}
                access={access}
                install={connection.connectionPurpose === "ai" || managesRemoteMcpAccess ? installStateFrom([]) : install}
                readOnly={readOnly}
                canChange={canChange}
                quarantined={quarantined}
                enabledIds={enabledIds}
                askFirstIds={askFirstIds}
                pending={pending}
                refreshPending={refreshTools.isPending}
                permissionChangeWarning={
                  connection.credentialPolicy === "per_agent" && managedIdentityGrant?.providerTenant?.github
                    ? "Shell Git and gh use this account for the run and are not constrained by per-tool Ask-first controls."
                    : undefined
                }
                onSaveAccess={(next) => apply({ access: connection.connectionPurpose === "ai" || managesRemoteMcpAccess ? next : accessIncludingInstalls(next, install) })}
                onRefreshActions={() => refreshTools.mutate()}
                onSetActionPermission={(id, next) => apply(actionPermissionMutation(id, next, enabledIds, askFirstIds))}
                onReviewQuarantined={reviewQuarantined}
              />
              {managesRemoteMcpAccess && isRemoteMcpConnectorId(connection.config?.sourceTemplateKey) && <RemoteMcpManagement
                providerName={baseAppName} canReconnect={canReconnect} canDisconnect={grantsQuery.data?.capabilities.canConfigure === true}
                busy={disconnectRemote.isPending}
                onReconnect={() => navigate(`/apps/connect?source=${connection.config?.sourceTemplateKey}&reconnect=${connection.id}`)}
                onManage={() => window.open(remoteMcpProviders[connection.config?.sourceTemplateKey as keyof typeof remoteMcpProviders].dashboardUrl, "_blank", "noopener,noreferrer")}
                onDisconnect={() => disconnectRemote.mutateAsync()}
              />}
              </>}
            </div>
      )}
    </div>
  );
}

function AppDetailHeader({
  appName,
  connection,
  logoEntry,
  brandKey,
  allowRemoteLogo,
  status,
  actionCount,
  renaming,
  nameDraft,
  renamePending,
  onNameDraftChange,
  onRenameStart,
  onRenameCancel,
  onRenameSubmit,
}: {
  appName: string;
  connection: ToolConnection;
  logoEntry: AppGalleryDisplayEntry | null;
  brandKey: string | null;
  allowRemoteLogo: boolean;
  status: StatusInfo;
  actionCount: number | null;
  renaming: boolean;
  nameDraft: string;
  renamePending: boolean;
  onNameDraftChange: (value: string) => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameSubmit: (value: string) => void;
}) {
  const unverifiedHost = unverifiedRemoteHost(connection);
  return (
    <header>
      <div className="flex items-center gap-3">
        <AppLogo
          name={appName}
          brandKey={brandKey}
          logoUrl={appDefinitionLogoUrl(logoEntry)}
          darkLogoUrl={appDefinitionDarkLogoUrl(logoEntry)}
          allowRemoteFallback={allowRemoteLogo}
          size={44}
        />
        <div className="min-w-0">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onRenameSubmit(nameDraft.trim());
              }}
            >
              <Input
                aria-label={l10n("local.app_name_e6ad3996")}
                value={nameDraft}
                onChange={(event) => onNameDraftChange(event.target.value)}
                className="h-9 w-64 text-lg font-bold"
                autoFocus
              />
              <Button type="submit" size="sm" disabled={renamePending || !nameDraft.trim()}>
                {renamePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : l10n("local.save_1509f561")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onRenameCancel} disabled={renamePending}>
                {l10n("local.cancel_19766ed6")}</Button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-xl font-bold">{appName}</h1>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                aria-label={l10n("local.rename_app_5689214e")}
                onClick={onRenameStart}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            {connection.config?.provider !== "agentmail" && actionCount !== null && (
              <span className="text-xs text-muted-foreground">
                {actionCount} {actionCount === 1 ? l10n("local.action_bd938c68") : l10n("local.actions_2b0dcdd4")} {l10n("local.available_ddd9818a")}</span>
            )}
            {connectionDisplaySecondaryHint(connection) ? (
              <span className="text-xs text-muted-foreground">
                {connectionDisplaySecondaryHint(connection)}
              </span>
            ) : null}
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} /> : null}
            <ConnectionProvenanceChip connection={connection} />
          </div>
        </div>
      </div>
    </header>
  );
}

function ToolsLoading({ mcpActions = false }: { mcpActions?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" />
      {mcpActions ? l10n("local.loading_mcp_actions_this_may_take_a_minute_43a98d1a") : l10n("local.loading_tools_ff209730")}
    </div>
  );
}

function ToolsLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-3 py-8">
      <p className="text-sm text-destructive">{l10n("local.couldn_t_load_tools_for_this_app_6564a35d")}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>{l10n("local.try_again_d8b8392e")}</Button>
    </div>
  );
}

function unverifiedRemoteHost(connection: ToolConnection): string | null {
  const sourceTemplateKey = connection.config?.sourceTemplateKey ?? connection.transportConfig.sourceTemplateKey;
  if (
    connection.transport !== "mcp_remote"
    || (typeof sourceTemplateKey === "string" && sourceTemplateKey.trim())
  ) return null;

  const value = connection.config?.url
    ?? connection.config?.endpoint
    ?? connection.config?.remoteUrl
    ?? connection.transportConfig.url
    ?? connection.transportConfig.endpoint
    ?? connection.transportConfig.remoteUrl;
  if (typeof value !== "string") return null;

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

type StatusInfo = { label: string; tone: "connected" | "attention" | "paused" };

function statusFor(connection: ToolConnection): StatusInfo {
  if (connection.enabled === false || connection.status === "disabled") {
    return { label: l10n("local.paused_e159b061"), tone: "paused" };
  }
  if (isAttentionHealthStatus(connection.healthStatus) || (connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config)))) {
    return { label: l10n("local.needs_attention_c1ebc781"), tone: "attention" };
  }
  return { label: l10n("local.connected_22965568"), tone: "connected" };
}

function StatusBadge({ status }: { status: StatusInfo }) {
  const klass: Record<StatusInfo["tone"], string> = {
    connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    attention: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    paused: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        klass[status.tone],
      )}
    >
      {status.tone === "connected" && <Check className="h-3 w-3" />}
      {status.label}
    </span>
  );
}

function enabledCatalogIds(profile: ToolProfileWithDetails | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of profile?.entries ?? []) {
    if (entry.effect === "include" && entry.catalogEntryId) ids.add(entry.catalogEntryId);
  }
  return ids;
}

function askFirstCatalogIds(policies: ToolPolicy[], connectionId: string): Set<string> {
  const ids = new Set<string>();
  for (const policy of policies) {
    if (policy.policyType !== "require_approval" || policy.enabled === false) continue;
    const config = (policy.config ?? {}) as { source?: unknown; connectionId?: unknown; catalogEntryId?: unknown };
    if (config.source === "app_gallery_finish" && config.connectionId === connectionId && typeof config.catalogEntryId === "string") {
      ids.add(config.catalogEntryId);
    }
  }
  return ids;
}

/**
 * Who may use this connection, read back from the app profile's bindings.
 *
 * `finishApp` replaces a profile's whole binding set, so every save from this
 * page — including an action-permission toggle — has to restate this. The
 * Permissions tab exposes the bindings as Agent access, while installs remain
 * a separate "always loaded" choice. If the profile has no bindings yet, the
 * install state remains the safest legacy fallback.
 *
 * That fallback is the important part. It used to return "all agents" for an
 * unbound profile, which turned any unrelated save into a silent company-wide
 * grant from a control the reader could not see. Installs authorize their
 * targets, so mirroring the install state is both the truthful reading and the
 * one that agrees with what the tab displays.
 */
function accessFrom(
  profile: ToolProfileWithDetails | undefined,
  install: InstallState,
): AccessDraft {
  const bindings = profile?.bindings ?? [];
  if (bindings.some((b) => b.targetType === "company")) {
    return { mode: "all", agentIds: new Set() };
  }
  const agentIds = new Set(bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId));
  if (agentIds.size > 0) return { mode: "specific", agentIds };
  return install.onAll
    ? { mode: "all", agentIds: new Set() }
    : { mode: "specific", agentIds: new Set(install.agentIds) };
}

function accessIncludingInstalls(next: AccessDraft, install: InstallState): AccessDraft {
  if (install.onAll || next.mode === "all") {
    return { mode: "all", agentIds: new Set() };
  }
  return {
    mode: "specific",
    agentIds: new Set([...next.agentIds, ...install.agentIds]),
  };
}

function galleryEntryFor(
  apps: AppGalleryDisplayEntry[],
  connection: ToolConnection | undefined,
  application: ToolApplication | undefined,
): AppGalleryDisplayEntry | null {
  if (!connection) return null;
  const sourceSlug = appApplicationSourceSlug(application) ?? appConnectionSourceSlug(connection);
  if (sourceSlug) {
    const keyed = apps.find((app) => appDefinitionSlug(app) === sourceSlug);
    if (keyed) return keyed;
  }
  const name = connection.name.toLowerCase();
  return apps.find((app) => appDefinitionName(app).toLowerCase() === name) ??
    apps.find((app) => appDefinitionSlug(app) === name) ??
    null;
}

function actionPermissionMutation(
  id: string,
  next: "off" | "allowed" | "ask",
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
) {
  const enabled = new Set(enabledIds);
  const askFirst = new Set(askFirstIds);
  if (next === "off") {
    enabled.delete(id);
    askFirst.delete(id);
  } else {
    enabled.add(id);
    if (next === "ask") askFirst.add(id);
    else askFirst.delete(id);
  }
  return { enabled, askFirst };
}
