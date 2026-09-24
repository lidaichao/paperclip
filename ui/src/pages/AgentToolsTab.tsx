import { l10n } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle, PackageCheck } from "lucide-react";
import type {
  AgentDetail as AgentDetailRecord,
  ConnectionGrant,
  ToolCatalogEntry,
  ToolConnection,
  ToolPolicy,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { toolsApi } from "../api/tools";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/icons/github-icon";
import { InlineBanner } from "@/components/InlineBanner";
import { EnforcementBanner } from "../components/EnforcementBanner";
import {
  RiskBadge,
  CapabilityBadges,
  LoadingState as ToolsLoadingState,
  ErrorState as ToolsErrorState,
} from "./tools/shared";
import { cn } from "../lib/utils";
import { brandChipBadge } from "../lib/status-colors";
import { installPayload, installStateFrom, isAgentInstalled, INSTALLED_HINT } from "../lib/tool-installs";

function isGitHubConnection(connection: ToolConnection): boolean {
  return (connection.config?.sourceTemplateKey ?? connection.transportConfig?.sourceTemplateKey) === "github";
}

function isEligibleGitHubIdentityConnection(connection: ToolConnection, agentId: string): boolean {
  return isGitHubConnection(connection)
    && connection.enabled
    && connection.status === "active"
    && isAgentInstalled(installStateFrom(connection.installs), agentId);
}

function GitHubIdentitySection({
  agentName,
  dedicatedIdentity,
  personalIdentity,
  loading,
  loadError,
  onRetry,
}: {
  agentName: string;
  dedicatedIdentity: { connection: ToolConnection; grant: ConnectionGrant } | null;
  personalIdentity: { connection: ToolConnection; grant: ConnectionGrant } | null;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
}) {
  const dedicatedLogin = dedicatedIdentity?.grant.providerTenant?.github?.login;
  const personalLogin = personalIdentity?.grant.providerTenant?.github?.login;

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-md border border-border bg-muted/40 p-2 text-foreground">
            <GithubIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{l10n("local.github_identity_c043831d")}</h3>
            {loading ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{l10n("local.checking_github_identity_f26298b9")}</p>
            ) : loadError ? (
              <>
                <p className="mt-0.5 text-sm font-medium text-foreground">{l10n("local.could_not_load_github_identity_ac77985d")}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {l10n("local.paperclip_could_not_verify_this_agent_apos_s_ce64cac6")}</p>
              </>
            ) : dedicatedIdentity ? (
              <>
                <p className="mt-0.5 text-sm font-medium text-foreground">
                  {dedicatedLogin ? `@${dedicatedLogin}` : l10n("local.dedicated_github_account_55fb115c")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {l10n("local.used_only_by_81d77064")}{" "}{agentName}{l10n("local._this_dedicated_connection_takes_precedence_o_66f6ffd1")}</p>
              </>
            ) : (
              <>
                <p className="mt-0.5 text-sm font-medium text-foreground">{l10n("local.use_responsible_person_apos_s_github_ff2dd338")}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {l10n("local.at_run_start_paperclip_uses_the_personal_gith_562d694f")}</p>
                {personalIdentity ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {l10n("local.your_account_is_connected_46b2b018")}{personalLogin ? (" " + l10n("local.as_value_e89e05d0", {v0: (personalLogin)})) : ""}.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>

        {!loading ? (
          <div className="flex flex-wrap items-center gap-2">
            {loadError ? (
              <Button variant="outline" size="sm" onClick={onRetry}>{l10n("local.retry_942087cc")}</Button>
            ) : dedicatedIdentity ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/apps/${dedicatedIdentity.connection.id}/permissions`}>{l10n("local.manage_github_identity_16fdfea3")}</Link>
              </Button>
            ) : (
              <>
                {personalIdentity ? (
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/apps/${personalIdentity.connection.id}/permissions`}>{l10n("local.manage_my_github_1559c8ac")}</Link>
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link to="/apps/connect?source=github">{l10n("local.connect_my_github_ffb05af0")}</Link>
                  </Button>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link to="/apps/connect?source=github">{l10n("local.use_a_dedicated_account_efd607de")}</Link>
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Normalize a selector value (string or string[]) into a flat string list. */
function selectorStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  return [];
}

/**
 * A policy governs this agent's allow list when it either explicitly names the
 * agent, or carries no agent/actor restriction that would exclude agents. This
 * mirrors how the tool gateway evaluates selectors server-side.
 */
export function policyGovernsAgent(policy: ToolPolicy, agentId: string): boolean {
  const selectors = (policy.selectors ?? {}) as Record<string, unknown>;
  const agentIds = [
    ...selectorStringList(selectors.agentId),
    ...selectorStringList(selectors.agentIds),
  ];
  if (agentIds.length > 0) return agentIds.includes(agentId);
  const actorTypes = [
    ...selectorStringList(selectors.actorType),
    ...selectorStringList(selectors.actorTypes),
  ];
  if (actorTypes.length > 0 && !actorTypes.includes("agent")) return false;
  return true;
}

export function mergeInstallDraft(
  serverDraft: Record<string, boolean>,
  currentDraft: Record<string, boolean>,
  lastSavedDraft: Record<string, boolean>,
): { draft: Record<string, boolean>; hasPendingChanges: boolean } {
  const draft = { ...serverDraft };
  let hasPendingChanges = false;
  for (const [connectionId, installed] of Object.entries(currentDraft)) {
    if (installed === (lastSavedDraft[connectionId] ?? false)) continue;
    draft[connectionId] = installed;
    hasPendingChanges = true;
  }
  return { draft, hasPendingChanges };
}

function InstalledAppsSection({
  agentId,
  agentName,
  connections,
  draft,
  permittedConnectionIds,
  pendingConnectionId,
  saving,
  unsaved,
  error,
  onChange,
}: {
  agentId: string;
  agentName: string;
  connections: ToolConnection[];
  draft: Record<string, boolean>;
  permittedConnectionIds: Set<string>;
  pendingConnectionId: string | null;
  saving: boolean;
  unsaved: boolean;
  error: boolean;
  onChange: (connectionId: string, installed: boolean) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-3 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{l10n("local.installed_apps_df76d7f1")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {l10n("local.installed_apps_load_tools_into_fec48810")}{" "}{agentName}{l10n("local._s_context_on_every_run_permitted_only_apps_d_0536f928")}</p>
        </div>
        <InstallSaveStatusChip pending={saving} unsaved={unsaved} error={error} />
      </div>

      <div className="space-y-3 p-3">
        <InlineBanner tone="info" compact>
          {l10n("local.has_access_means_the_app_is_permitted_install_59c905c1")}</InlineBanner>

        {connections.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            {l10n("local.no_permitted_apps_yet_bind_an_access_profile_a42e3e0d")}</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {connections.map((connection) => {
              const installState = installStateFrom(connection.installs);
              const installedForAll = installState.onAll;
              const checked = installedForAll || (draft[connection.id] ?? installState.agentIds.has(agentId));
              const permitted = permittedConnectionIds.has(connection.id);
              const rowPending = pendingConnectionId === connection.id;
              return (
                <div key={connection.id} className="space-y-2 px-3 py-3">
                  <label className="flex items-start gap-3">
                    <Checkbox
                      checked={checked}
                      disabled={installedForAll || rowPending}
                      aria-label={l10n("local.install_value_on_value_4f7640ee", {v0: (connection.name), v1: (agentName)})}
                      onCheckedChange={(next) => onChange(connection.id, Boolean(next))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{connection.name}</span>
                        <InstallBadge installed={checked} installedForAll={installedForAll} permitted={permitted} />
                        {rowPending ? <span className="text-xs text-muted-foreground">{l10n("local.saving_dc85af8f")}</span> : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {installedForAll
                          ? l10n("local.installed_from_the_app_page_for_every_agent_r_7b88d855")
                          : checked
                            ? l10n("local.loaded_into_this_agent_s_runtime_context_dc9c15c1")
                            : INSTALLED_HINT}
                      </span>
                    </span>
                  </label>
                  {permitted && !checked ? (
                    <InlineBanner
                      tone="warning"
                      compact
                      className="ml-7"
                      actions={(
                        <Link
                          to={`/apps/${connection.id}/permissions`}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {l10n("local.open_permissions_2fbb36e1")}</Link>
                      )}
                    >
                      {l10n("local.permitted_but_not_installed_tools_will_not_ap_6e05920b")}</InlineBanner>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function InstallBadge({
  installed,
  installedForAll,
  permitted,
}: {
  installed: boolean;
  installedForAll: boolean;
  permitted: boolean;
}) {
  const label = installed ? (installedForAll ? l10n("local.installed_for_all_763535aa") : l10n("local.installed_f8b32f4e")) : permitted ? l10n("local.permitted_only_b66efe0f") : l10n("local.not_permitted_8ec5f4b7");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        installed ? brandChipBadge.green : brandChipBadge.gray,
      )}
    >
      {installed ? <PackageCheck className="h-3 w-3" /> : null}
      {label}
    </span>
  );
}

function InstallSaveStatusChip({
  pending,
  unsaved,
  error,
}: {
  pending: boolean;
  unsaved: boolean;
  error: boolean;
}) {
  if (pending) return <span className="text-xs text-muted-foreground">{l10n("local.saving_dc85af8f")}</span>;
  if (error) return <span className="text-xs text-destructive">{l10n("local.could_not_save_16efcd21")}</span>;
  if (unsaved) return <span className="text-xs text-muted-foreground">{l10n("local.unsaved_changes_a710c2b9")}</span>;
  return <span className="text-xs text-muted-foreground">{l10n("local.saved_b5c120b3")}</span>;
}

const POLICY_EFFECT_LABEL: Record<string, string> = {
  allow: "allow",
  block: "block",
  deny: "deny",
  require_approval: "require approval",
  redact: "redact",
  rate_limit: "rate limit",
};

const DENIED_TOOLS_DISPLAY_LIMIT = 30;

/**
 * Agent detail · Tools tab (PAP-10788, surface 09 of the PAP-10771 v2 spec).
 *
 * Communicates the agent's resolved tool access: the banner makes clear the
 * prompt can narrow the list but never expand it, and the side panel explains
 * which access profiles and rules shape the final list.
 */
export function AgentToolsTab({ agent, companyId }: { agent: AgentDetailRecord; companyId: string }) {
  const queryClient = useQueryClient();
  const [installDraft, setInstallDraft] = useState<Record<string, boolean>>({});
  const lastSavedInstallRef = useRef<Record<string, boolean>>({});
  const skipNextInstallAutosaveRef = useRef(true);
  const failedInstallDraftRef = useRef<{ connectionId: string; installed: boolean } | null>(null);

  const effective = useQuery({
    queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agent.id),
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agent.id),
  });

  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: () => toolsApi.listPolicies(companyId),
  });

  const connectionList = connectionsQuery.data?.connections ?? [];
  const eligibleGitHubConnections = useMemo(
    () => connectionList.filter((connection) => isEligibleGitHubIdentityConnection(connection, agent.id)),
    [agent.id, connectionList],
  );
  const githubGrantQueries = useQueries({
    queries: eligibleGitHubConnections.map((connection) => ({
      queryKey: queryKeys.tools.connectionGrants(connection.id),
      queryFn: () => toolsApi.listConnectionGrants(connection.id),
      staleTime: 30_000,
    })),
  });
  const githubIdentityRows = eligibleGitHubConnections.flatMap((connection, index) =>
    (githubGrantQueries[index]?.data?.grants ?? []).map((grant) => ({
      connection,
      grant,
      currentUserId: githubGrantQueries[index]?.data?.currentUserId,
    })),
  );
  const dedicatedGitHubIdentity = githubIdentityRows.find(({ grant }) => (
    grant.kind === "agent"
    && grant.subjectAgentId === agent.id
    && grant.status === "active"
  )) ?? null;
  const personalGitHubIdentity = githubIdentityRows.find(({ grant, currentUserId }) => (
    grant.kind === "user"
    && grant.subjectUserId === currentUserId
    && grant.status === "active"
  )) ?? null;
  const connectionInstallSignature = useMemo(
    () =>
      connectionList
        .map((connection) => {
          const installKey = (connection.installs ?? [])
            .map((install) => `${install.targetType}:${install.targetId}`)
            .sort()
            .join(",");
          return `${connection.id}=${installKey}`;
        })
        .join("|"),
    [connectionList],
  );

  const syncInstall = useMutation({
    mutationFn: ({ connection, installed }: { connection: ToolConnection; installed: boolean }) => {
      const nextState = installStateFrom(connection.installs);
      if (!nextState.onAll) {
        if (installed) nextState.agentIds.add(agent.id);
        else nextState.agentIds.delete(agent.id);
      }
      return toolsApi.putConnectionInstalls(
        connection.id,
        installPayload(connection.companyId ?? companyId, nextState),
      );
    },
    onSuccess: async (_snapshot, variables) => {
      failedInstallDraftRef.current = null;
      lastSavedInstallRef.current = {
        ...lastSavedInstallRef.current,
        [variables.connection.id]: variables.installed,
      };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccessesForConnection(variables.connection.id) }),
      ]);
    },
    onError: (_error, variables) => {
      failedInstallDraftRef.current = {
        connectionId: variables.connection.id,
        installed: variables.installed,
      };
    },
  });

  useEffect(() => {
    setInstallDraft({});
    lastSavedInstallRef.current = {};
    skipNextInstallAutosaveRef.current = true;
    failedInstallDraftRef.current = null;
  }, [agent.id, companyId]);

  useEffect(() => {
    const next = Object.fromEntries(
      connectionList.map((connection) => [
        connection.id,
        isAgentInstalled(installStateFrom(connection.installs), agent.id),
      ]),
    );
    failedInstallDraftRef.current = null;
    setInstallDraft((current) => {
      const merged = mergeInstallDraft(next, current, lastSavedInstallRef.current);
      lastSavedInstallRef.current = next;
      skipNextInstallAutosaveRef.current = !merged.hasPendingChanges;
      return merged.draft;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, connectionInstallSignature]);

  useEffect(() => {
    if (skipNextInstallAutosaveRef.current) {
      skipNextInstallAutosaveRef.current = false;
      return;
    }
    if (syncInstall.isPending) return;

    const changedConnection = connectionList.find((connection) => {
      const saved = lastSavedInstallRef.current[connection.id] ?? false;
      const draft = installDraft[connection.id] ?? false;
      const failed = failedInstallDraftRef.current;
      return saved !== draft && !(failed?.connectionId === connection.id && failed.installed === draft);
    });
    if (!changedConnection) return;

    const timeout = window.setTimeout(() => {
      const installed = installDraft[changedConnection.id] ?? false;
      const saved = lastSavedInstallRef.current[changedConnection.id] ?? false;
      const failed = failedInstallDraftRef.current;
      if (saved !== installed && !(failed?.connectionId === changedConnection.id && failed.installed === installed)) {
        syncInstall.mutate({ connection: changedConnection, installed });
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [connectionList, installDraft, syncInstall.isPending, syncInstall.mutate]);

  // The effective endpoint returns the *allowed* slice of the catalog. To show
  // "Denied tools (suppressed)" we need the full company catalog, which is only
  // exposed per-connection — same aggregation the Applications tab uses.
  const catalogQueries = useQueries({
    queries: connectionList.map((connection) => ({
      queryKey: queryKeys.tools.catalog(connection.id),
      queryFn: () => toolsApi.listCatalog(connection.id),
      staleTime: 60_000,
    })),
  });

  const connectionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of connectionList) map.set(connection.id, connection.name);
    return map;
  }, [connectionList]);

  const allowedTools = useMemo(
    () =>
      [...(effective.data?.allowedTools ?? [])].sort((a, b) =>
        a.toolName.localeCompare(b.toolName),
      ),
    [effective.data?.allowedTools],
  );

  const permittedConnectionIds = useMemo(
    () => new Set([
      ...(effective.data?.entries ?? [])
        .filter((entry) => entry.effect === "include" && entry.connectionId)
        .map((entry) => entry.connectionId!),
      ...allowedTools.map((tool) => tool.connectionId),
    ]),
    [allowedTools, effective.data?.entries],
  );
  const installedAppConnections = useMemo(
    () =>
      connectionList
        .filter((connection) => permittedConnectionIds.has(connection.id) || (installDraft[connection.id] ?? false))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [connectionList, installDraft, permittedConnectionIds],
  );
  const hasInstallUnsavedChanges = installedAppConnections.some(
    (connection) => (installDraft[connection.id] ?? false) !== (lastSavedInstallRef.current[connection.id] ?? false),
  );

  const catalogStamp = catalogQueries.map((q) => q.dataUpdatedAt).join(",");
  const deniedTools = useMemo(() => {
    const allowedIds = new Set((effective.data?.allowedTools ?? []).map((tool) => tool.id));
    const seen = new Set<string>();
    const denied: ToolCatalogEntry[] = [];
    for (const result of catalogQueries) {
      for (const entry of result.data?.catalog ?? []) {
        if (entry.status !== "active") continue;
        if (allowedIds.has(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        denied.push(entry);
      }
    }
    return denied.sort((a, b) => a.toolName.localeCompare(b.toolName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective.data?.allowedTools, catalogStamp]);

  const governingPolicies = useMemo(() => {
    const policies = policiesQuery.data?.policies ?? [];
    return policies
      .map((policy, index) => ({ policy, order: index + 1 }))
      .filter(({ policy }) => policy.enabled && policyGovernsAgent(policy, agent.id));
  }, [policiesQuery.data?.policies, agent.id]);

  const profiles = effective.data?.profiles ?? [];
  const catalogLoading = catalogQueries.some((q) => q.isLoading);

  if (effective.isLoading) return <ToolsLoadingState label={l10n("local.resolving_effective_access_84e7e40c")} />;
  if (effective.error) {
    return <ToolsErrorState error={effective.error} onRetry={() => effective.refetch()} />;
  }

  const profilesHref = "/apps/advanced/profiles";

  return (
    <div className="space-y-4">
      <EnforcementBanner
        tone="info"
        title={l10n("local.effective_access_46d8c205")}
        body={
          <>
            {l10n("local.this_is_exactly_the_tool_set_paperclip_will_a_b3f014fc")}{" "}
            <span className="font-medium">{agent.name}</span>{l10n("local._profile_and_policy_edits_are_reflected_withi_e71af078")}{" "}
            <span className="font-medium">{l10n("local.cannot_expand_it_a298f2bb")}</span> {l10n("local._everything_else_is_blocked_by_default_07b74d9a")}</>
        }
      />

      <GitHubIdentitySection
        agentName={agent.name}
        dedicatedIdentity={dedicatedGitHubIdentity}
        personalIdentity={personalGitHubIdentity}
        loading={connectionsQuery.isLoading || githubGrantQueries.some((query) => query.isLoading)}
        loadError={connectionsQuery.isError || githubGrantQueries.some((query) => query.isError)}
        onRetry={() => {
          if (connectionsQuery.isError) void connectionsQuery.refetch();
          for (const query of githubGrantQueries) {
            if (query.isError) void query.refetch();
          }
        }}
      />

      <InstalledAppsSection
        agentId={agent.id}
        agentName={agent.name}
        connections={installedAppConnections}
        draft={installDraft}
        permittedConnectionIds={permittedConnectionIds}
        pendingConnectionId={syncInstall.isPending ? syncInstall.variables?.connection.id ?? null : null}
        saving={syncInstall.isPending}
        unsaved={hasInstallUnsavedChanges}
        error={syncInstall.isError && hasInstallUnsavedChanges}
        onChange={(connectionId, installed) => {
          failedInstallDraftRef.current = null;
          setInstallDraft((current) => ({ ...current, [connectionId]: installed }));
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Allowed tools table */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <h3 className="text-sm font-semibold text-foreground">{l10n("local.allowed_tools_73f3619d")}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {allowedTools.length} {allowedTools.length === 1 ? l10n("local.tool_7c9bbe5e") : l10n("local.tools_f9d35d43")}
              </span>
            </div>
            {allowedTools.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted-foreground">
                {l10n("local.no_tools_are_allowed_for_this_agent_bind_a_to_cad3bcb3")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{l10n("local.tool_2e53bdcd")}</th>
                    <th className="px-3 py-2 font-medium">{l10n("local.capability_5faf58a6")}</th>
                    <th className="px-3 py-2 font-medium">{l10n("local.risk_0711a8d6")}</th>
                    <th className="px-3 py-2 font-medium">{l10n("local.source_0e570ca6")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {allowedTools.map((tool) => (
                    <tr key={tool.id} className="align-top">
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs text-foreground">{tool.toolName}</div>
                        {tool.title ? (
                          <div className="text-(length:--text-micro) text-muted-foreground">{tool.title}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <CapabilityBadges
                          isReadOnly={tool.isReadOnly}
                          isWrite={tool.isWrite}
                          isDestructive={tool.isDestructive}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <RiskBadge risk={tool.riskLevel} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {connectionNameById.get(tool.connectionId) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Why these tools? side panel */}
        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
              {l10n("local.why_these_tools_1c9d4652")}</h3>

            {/* Access profiles */}
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                  {l10n("local.access_profiles_2471292f")}</div>
                <Link
                  to={`${profilesHref}?check=1`}
                  className="text-(length:--text-micro) font-medium text-primary hover:underline"
                >
                  {l10n("local.check_access_abb9a172")}</Link>
              </div>
              {profiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {l10n("local.no_active_profile_applies_to_this_agent_so_it_50b16433")}</p>
              ) : (
                profiles.map((profile) => {
                  return (
                    <div key={profile.id} className="rounded-md border border-border/70 px-2.5 py-2">
                      <Link
                        to={`${profilesHref}/${profile.id}`}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        {profile.name}
                      </Link>
                      {profile.summary.isCompanyDefault ? (
                        <div className="mt-1">
                          <span className="rounded border border-border px-1.5 py-0.5 text-(length:--text-nano) uppercase text-muted-foreground">
                            {l10n("local.organization_default_804a1f08")}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            {/* Policies mutating the allow list */}
            <div className="mt-3 space-y-1.5">
              <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                {l10n("local.active_policies_5361fe56")}</div>
              {policiesQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">{l10n("local.loading_policies_4b856670")}</p>
              ) : governingPolicies.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {l10n("local.no_enabled_policy_currently_mutates_this_agen_854cf0ca")}</p>
              ) : (
                governingPolicies.map(({ policy, order }) => (
                  <div key={policy.id} className="rounded-md border border-border/70 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="truncate text-xs font-medium text-foreground"
                        title={l10n("local.policy_value_value_732bcf4e", {v0: (order), v1: (policy.name)})}
                      >
                        #{order} {policy.name}
                      </span>
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-(length:--text-nano) uppercase text-muted-foreground">
                        {POLICY_EFFECT_LABEL[policy.policyType] ?? policy.policyType}
                      </span>
                    </div>
                    {policy.description ? (
                      <div className="mt-0.5 truncate text-(length:--text-micro) text-muted-foreground">
                        {policy.description}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {/* Unavailable tools */}
            <div className="mt-3 space-y-1.5">
              <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                {l10n("local.unavailable_tools_d13855c6")}</div>
              {catalogLoading ? (
                <p className="text-xs text-muted-foreground">{l10n("local.checking_tools_87c6ff9a")}</p>
              ) : deniedTools.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {l10n("local.every_known_tool_this_agent_could_name_is_all_81d2070c")}</p>
              ) : (
                <>
                  <p className="text-(length:--text-micro) text-muted-foreground">
                    {l10n("local.tools_the_agent_could_name_but_paperclip_woul_97708267")}</p>
                  <div className="flex flex-wrap gap-1">
                    {deniedTools.slice(0, DENIED_TOOLS_DISPLAY_LIMIT).map((tool) => (
                      <span
                        key={tool.id}
                        className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
                        title={connectionNameById.get(tool.connectionId) ?? undefined}
                      >
                        {tool.toolName}
                      </span>
                    ))}
                  </div>
                  {deniedTools.length > DENIED_TOOLS_DISPLAY_LIMIT ? (
                    <p className="text-(length:--text-micro) text-muted-foreground">
                      +{deniedTools.length - DENIED_TOOLS_DISPLAY_LIMIT} {l10n("local.more_187897ce")}</p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
