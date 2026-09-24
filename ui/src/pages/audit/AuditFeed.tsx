import { l10n } from "../../i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, ScrollText, ShieldAlert } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Identity } from "@/components/Identity";
import { cn, relativeTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { formatActivityVerb } from "@/lib/activity-format";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import { auditApi, type AuditActionRecord, type AuditActionFilters } from "@/api/audit";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { useToastActions } from "@/context/ToastContext";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Action-domain prefixes offered in the filter (server does a prefix match). */
const ACTION_DOMAINS: { value: string; label: string }[] = [
  { value: ALL, label: l10n("local.all_actions_83140cf1") },
  { value: "issue.", label: l10n("local.tasks_b3a60e61") },
  { value: "agent.", label: l10n("local.agents_279b44d2") },
  { value: "heartbeat.", label: l10n("local.runs_848f54e8") },
  { value: "approval.", label: l10n("local.approvals_2bfc3471") },
  { value: "project.", label: l10n("local.projects_04e2a972") },
  { value: "goal.", label: l10n("local.goals_116cd398") },
  { value: "tool_", label: l10n("local.apps_tools_b10a5c44") },
  { value: "cost.", label: l10n("local.costs_b88fc5fc") },
  { value: "company.", label: l10n("local.organization_d764d425") },
];

/** Entity types offered in the filter (server does an exact match). */
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, label: l10n("local.all_entities_15414070") },
  { value: "issue", label: l10n("local.task_4bc74b21") },
  { value: "agent", label: l10n("local.agent_11b39c93") },
  { value: "heartbeat_run", label: l10n("local.run_00d60e31") },
  { value: "routine", label: l10n("local.routine_0b5baf30") },
  { value: "project", label: l10n("local.project_98595978") },
  { value: "goal", label: l10n("local.goal_cdbf6975") },
  { value: "company", label: l10n("local.organization_d764d425") },
  { value: "tool_connection", label: l10n("local.connection_639a40e8") },
];

/**
 * Which actors the feed covers. `all` is the shared company activity view
 * (people, agents, and the system); `agents` is the privileged agent-action
 * audit that carries responsible-person and run attribution.
 */
export type AuditFeedMode = "all" | "agents";

export interface AuditFeedProps {
  companyId: string;
  /**
   * When set, the feed is pinned to a single agent (per-agent Audit tab) — the
   * agent filter is hidden and every query/export carries this agentId.
   */
  lockedAgentId?: string;
  /** Pin the feed to one run while preserving the existing run-detail links. */
  lockedRunId?: string;
  /** Pin the feed to an entity such as a routine. */
  lockedEntity?: { type: string; id: string; label?: string };
  /** Hide the section header/description (the AgentDetail tab supplies its own chrome). */
  hideHeader?: boolean;
  /**
   * Controlled feed mode. Supplying `onModeChange` turns on the mode toggle for
   * callers that hold `audit:view_agent_actions`; without it the feed stays in
   * `mode` (or the all-actors default). Ignored when `lockedAgentId` is set.
   */
  mode?: AuditFeedMode;
  onModeChange?: (mode: AuditFeedMode) => void;
  /** Optional controlled action prefix, used by links from connection testing. */
  actionDomain?: string;
  onActionDomainChange?: (actionDomain: string) => void;
}

function toStartIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toEndIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Actor avatar + name — agents render their icon glyph, humans their avatar. */
function AuditActor({
  record,
  agentMap,
  userProfileMap,
}: {
  record: AuditActionRecord;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}) {
  // Agent names are company-readable through the same authorization-filtered
  // directory used by this page. The basic audit tier strips privileged
  // attribution (`agentId`) but retains the acting principal (`actorId`), so
  // use that principal to avoid presenting a trivially joinable identity as
  // an anonymous "Agent" in the UI.
  const actorAgentId = record.agentId
    ?? (record.actorType === "agent" ? record.actorId : null);
  const agent = actorAgentId ? agentMap.get(actorAgentId) : null;
  if (agent) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={agent.name}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <AgentAvatar agent={agent} size={16} className="h-3 w-3"/>
        </span>
        <span className="truncate font-medium text-foreground">{agent.name}</span>
      </span>
    );
  }
  if (record.actorType === "user" && record.actorId) {
    const profile = userProfileMap.get(record.actorId);
    return (
      <Identity
        name={profile?.label ?? "User"}
        avatarUrl={profile?.image ?? null}
        size="sm"
        className="font-medium text-foreground"
      />
    );
  }
  // Fall back to the actor *type*, never a blanket "System". This still covers
  // deleted or authorization-filtered agents that are absent from the directory.
  const label =
    record.actorType === "plugin"
      ? l10n("local.plugin_ab1173ee")
      : record.actorType === "agent"
        ? l10n("local.agent_11b39c93")
        : record.actorType === "user"
          ? l10n("local.user_b512d97e")
          : l10n("local.system_6725e7bb");
  return <Identity name={label} size="sm" className="font-medium text-foreground" />;
}

/**
 * The clickable entity node inside the humanized sentence. The verb from
 * `formatActivityVerb` already encodes the relationship ("commented on",
 * "created document for", …) and expects the issue reference to follow it, so
 * this renders the task link (or a document/plain fallback) — never a phrase
 * that would duplicate the verb.
 */
function AuditEntityNode({ record }: { record: AuditActionRecord }) {
  const { issue, document } = record.entity;
  const issueRef = issue?.identifier ?? issue?.id ?? null;

  if (issueRef) {
    return (
      <Link to={`/issues/${issueRef}`} className="font-medium text-primary hover:underline">
        {issue?.identifier ? `${issue.identifier}${issue.title ? ` · ${issue.title}` : ""}` : l10n("local.the_task_fd27a43c")}
      </Link>
    );
  }
  if (document) {
    return <span className="font-medium text-foreground">{document.key}</span>;
  }
  const connectionId = record.entityType === "tool_connection"
    ? record.entityId
    : typeof record.details?.connectionId === "string"
      ? record.details.connectionId
      : null;
  if (connectionId) {
    return (
      <Link to={`/apps/${connectionId}/permissions`} className="font-medium text-primary hover:underline">
        {l10n("local.the_connection_03001d4d")}</Link>
    );
  }
  // Non-linkable entities (company, agent, goal, …) — show a plain descriptor.
  return <span className="text-muted-foreground">{record.entityType}</span>;
}

function AuditRow({
  record,
  agentMap,
  userProfileMap,
}: {
  record: AuditActionRecord;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}) {
  const verb = formatActivityVerb(record.action, record.details, { agentMap, userProfileMap });
  const responsible = record.responsibleUserId ? userProfileMap.get(record.responsibleUserId) : null;
  // Suppress the "on behalf of" chip when the human actor *is* the responsible user.
  const showOnBehalf = Boolean(
    record.responsibleUserId
      && !(record.actorType === "user" && record.actorId === record.responsibleUserId),
  );
  const responsibleLabel = responsible?.label ?? (record.responsibleUserId ? l10n("local.a_user_38649849") : null);
  const excerpt = record.entity.comment?.excerpt?.trim();
  // Show the document key only when it isn't already the linked entity node.
  const documentKey = record.entity.issue && record.entity.document ? record.entity.document.key : null;

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground">
            <AuditActor record={record} agentMap={agentMap} userProfileMap={userProfileMap} />
            <span className="text-muted-foreground">{verb}</span>
            <AuditEntityNode record={record} />
          </div>
          {excerpt ? (
            <p className="line-clamp-2 border-l-2 border-border pl-2 text-muted-foreground">
              “{excerpt}”
            </p>
          ) : null}
          {documentKey ? (
            <p className="text-xs text-muted-foreground">
              {l10n("local.document_d6bd8c0a")}{" "}<span className="font-mono text-(length:--text-micro)">{documentKey}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {showOnBehalf && responsibleLabel ? (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5">
                {l10n("local.on_behalf_of_653bb65e")}{" "}{responsibleLabel}
              </span>
            ) : null}
            {record.runId && record.agentId ? (
              <Link
                to={`/agents/${record.agentId}/runs/${record.runId}`}
                className="text-primary hover:underline"
              >
                {l10n("local.view_run_aaf7fccc")}</Link>
            ) : null}
            <span className="font-mono text-(length:--text-micro) opacity-70">{record.action}</span>
          </div>
        </div>
        <time
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
          dateTime={record.createdAt}
          title={new Date(record.createdAt).toLocaleString()}
        >
          {relativeTime(record.createdAt)}
        </time>
      </div>
    </li>
  );
}

/** The permission-denied / upsell state shown when the caller lacks the grant. */
function AuditUpsell() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium text-foreground">{l10n("local.agent_audit_is_a_paperclip_enterprise_view_0f33f93b")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {l10n("local.the_agent_audit_log_gives_you_a_searchable_ex_795b34a7")}{" "}
            <span className="font-mono text-(length:--text-micro)">audit:view_agent_actions</span>{" "}
            {l10n("local.permission_to_view_it_03d2059c")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function AuditFeed({
  companyId,
  lockedAgentId,
  lockedRunId,
  lockedEntity,
  hideHeader,
  mode,
  onModeChange,
  actionDomain: controlledActionDomain,
  onActionDomainChange,
}: AuditFeedProps) {
  const { pushToast } = useToastActions();
  const [agent, setAgent] = useState<string>(ALL);
  const [responsibleUser, setResponsibleUser] = useState<string>(ALL);
  const [localActionDomain, setLocalActionDomain] = useState<string>(ALL);
  const actionDomain = controlledActionDomain ?? localActionDomain;
  const setActionDomain = (next: string) => {
    setLocalActionDomain(next);
    onActionDomainChange?.(next);
  };
  const [entityType, setEntityType] = useState<string>(ALL);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [downgradeRecoveryAttempted, setDowngradeRecoveryAttempted] = useState(false);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const userDirectory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    retry: false,
  });

  const agentMap = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a])),
    [agents.data],
  );
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(userDirectory.data?.users),
    [userDirectory.data],
  );

  // The per-agent tab keeps the legacy privileged scope because it always
  // carries an attribution filter and must not silently downgrade to the basic
  // tier. Everywhere else the mode picks the scope, defaulting to all actors.
  const resolvedMode: AuditFeedMode = lockedAgentId || lockedRunId ? "agents" : mode ?? "all";
  const hasLockedScope = Boolean(lockedAgentId || lockedRunId || lockedEntity);

  const filters: AuditActionFilters = {
    actorScope: resolvedMode,
    agentId: lockedAgentId ?? (agent === ALL ? undefined : agent),
    runId: lockedRunId,
    responsibleUserId: responsibleUser === ALL ? undefined : responsibleUser,
    action: actionDomain === ALL ? undefined : actionDomain,
    entityType: lockedEntity?.type ?? (entityType === ALL ? undefined : entityType),
    entityId: lockedEntity?.id,
    from: toStartIso(dateFrom),
    to: toEndIso(dateTo),
  };

  const hasActiveFilters = Boolean(
    (!lockedAgentId && agent !== ALL)
      || responsibleUser !== ALL
      || actionDomain !== ALL
      || entityType !== ALL
      || dateFrom
      || dateTo,
  );
  const hasPrivilegedFilters = Boolean(
    !hasLockedScope && (agent !== ALL || responsibleUser !== ALL),
  );

  const feed = useInfiniteQuery({
    queryKey: queryKeys.audit.agentActions(companyId, {
      actorScope: filters.actorScope,
      agentId: filters.agentId,
      runId: filters.runId,
      responsibleUserId: filters.responsibleUserId,
      action: filters.action,
      entityType: filters.entityType,
      entityId: filters.entityId,
      from: filters.from,
      to: filters.to,
    }),
    queryFn: ({ pageParam }) =>
      auditApi.listAgentActions(companyId, { ...filters, limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 2,
  });

  const permissionDenied = feed.error instanceof ApiError && feed.error.status === 403;
  const hasBasicPage = feed.data?.pages.some((page) => page.accessTier === "basic") ?? false;
  const hasFullPage = feed.data?.pages.some((page) => page.accessTier === "full") ?? false;

  // Once the server answers at the basic tier the caller has lost the permission
  // that produced the privileged attribution on the pages already in the cache.
  // Drop those pages rather than rendering revoked "on behalf of" attribution
  // next to stripped rows — the recovery refetch below may never clear them.
  const items = useMemo(() => {
    const pages = feed.data?.pages ?? [];
    const visible = hasBasicPage ? pages.filter((page) => page.accessTier !== "full") : pages;
    return visible.flatMap((page) => page.items);
  }, [feed.data, hasBasicPage]);
  // Access may be revoked between cursor requests. Treat the least-privileged
  // page as authoritative until every cached page has been fetched again.
  const accessTier = hasBasicPage ? "basic" : feed.data?.pages[0]?.accessTier;
  const hasMixedAccessTiers = hasBasicPage && hasFullPage;
  const canUseAdvancedControls = lockedAgentId || lockedRunId
    ? true
    : accessTier === "full";
  // The recovery refetch below gets one shot. If it does not clear the mixed
  // pages — it errored, or it somehow came back mixed again — the cache keeps
  // them, so `hasMixedAccessTiers` would stay true forever. Only call the feed
  // "recovering" while that attempt is outstanding; once it has settled, fall
  // through to normal rendering. Otherwise the banner permanently hides the
  // error state and its "Try again" button, with no way off the page. Falling
  // through is safe because `items` already excludes the privileged pages, so
  // an unrecovered cache renders as a plain basic-tier feed.
  const downgradeRecoveryExhausted = Boolean(
    hasMixedAccessTiers && downgradeRecoveryAttempted && !feed.isFetching,
  );
  const recoveringFromAccessDowngrade = Boolean(
    !hasLockedScope
      && !downgradeRecoveryExhausted
      && ((permissionDenied && hasPrivilegedFilters) || hasMixedAccessTiers),
  );
  // A reader without `audit:view_agent_actions` can still land on the
  // agent-actions mode through an old `/audit` deep link. Drop them into the
  // shared all-activity feed instead of blocking the whole page with the upsell.
  const fallingBackToAllActivity = Boolean(
    permissionDenied && !hasLockedScope && resolvedMode === "agents" && onModeChange,
  );
  // Keep both modes explicit in the Audit IA. Basic readers can see that Agent
  // Actions exists, but cannot switch into the privileged scope.
  const showModeToggle = Boolean(
    !hasLockedScope
      && onModeChange
      && !fallingBackToAllActivity
  );

  useEffect(() => {
    if (fallingBackToAllActivity) onModeChange?.("all");
  }, [fallingBackToAllActivity, onModeChange]);

  useEffect(() => {
    if (!hasLockedScope && (accessTier === "basic" || recoveringFromAccessDowngrade)) {
      setAgent(ALL);
      setResponsibleUser(ALL);
    }
  }, [accessTier, hasLockedScope, recoveringFromAccessDowngrade]);

  // Recover from a mid-pagination downgrade with exactly one refetch. `feed`
  // gets a new identity on every render, so an unguarded refetch here re-fires
  // on each render and hammers the endpoint while the tiers stay mixed.
  useEffect(() => {
    if (!hasMixedAccessTiers) {
      if (downgradeRecoveryAttempted) setDowngradeRecoveryAttempted(false);
      return;
    }
    if (downgradeRecoveryAttempted) return;
    setDowngradeRecoveryAttempted(true);
    void feed.refetch();
  }, [downgradeRecoveryAttempted, feed, hasMixedAccessTiers]);

  const clearFilters = () => {
    setAgent(ALL);
    setResponsibleUser(ALL);
    setActionDomain(ALL);
    setEntityType(ALL);
    setDateFrom("");
    setDateTo("");
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await auditApi.exportAgentActionsCsv(companyId, {
        actorScope: filters.actorScope,
        agentId: filters.agentId,
        runId: filters.runId,
        responsibleUserId: filters.responsibleUserId,
        action: filters.action,
        entityType: filters.entityType,
        entityId: filters.entityId,
        from: filters.from,
        to: filters.to,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${resolvedMode === "agents" ? "agent-audit" : "activity"}-${companyId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Browsers may read blob URLs lazily after click(), so keep the URL alive
      // long enough for the download to start.
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      pushToast({ title: l10n("local.audit_exported_92ca2889"), body: l10n("local.your_csv_download_has_started_0ab920d4"), tone: "success" });
    } catch (error) {
      pushToast({
        title: l10n("local.export_failed_e94d3ee0"),
        body: error instanceof Error ? error.message : l10n("local.could_not_export_the_audit_log_a5a8eccb"),
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  };

  if (permissionDenied && !recoveringFromAccessDowngrade && !fallingBackToAllActivity) {
    return <AuditUpsell />;
  }

  return (
    <div className="space-y-4">
      {!hideHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{l10n("local.activity_38da1505")}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {resolvedMode === "agents"
                ? l10n("local.every_recorded_agent_action_newest_first_with_693aedcd")
                : l10n("local.everything_happening_in_your_organization_new_f0f62a18")}
            </p>
          </div>
        </div>
      ) : null}

      {showModeToggle ? (
        <Tabs value={resolvedMode} onValueChange={(value) => onModeChange?.(value as AuditFeedMode)}>
          <TabsList aria-label={l10n("local.activity_scope_98a37b44")}>
            <TabsTrigger value="all">{l10n("local.activity_38da1505")}</TabsTrigger>
            <TabsTrigger
              value="agents"
              disabled={accessTier === "basic"}
              title={accessTier === "basic" ? l10n("local.agent_actions_requires_audit_access_a62242f1") : undefined}
            >
              {l10n("local.agent_actions_8d405c6e")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {hasLockedScope ? (
        <div className="border-y border-border px-1 py-2 text-xs text-muted-foreground">
          {lockedRunId
            ? l10n("local.scoped_to_run_value_4af1e039", {v0: (lockedRunId.slice(0, 8))})
            : lockedAgentId
              ? l10n("local.scoped_to_one_agent_03939ef9")
              : l10n("local.scoped_to_value_1976914e", {v0: (lockedEntity?.label ?? lockedEntity?.type ?? "entity")})}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        {canUseAdvancedControls && !lockedAgentId && !lockedRunId ? (
          <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
            <span>{l10n("local.agent_11b39c93")}</span>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={l10n("local.agent_11b39c93")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{l10n("local.all_agents_54c32d3e")}</SelectItem>
                {(agents.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {canUseAdvancedControls ? (
          <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
            <span>{l10n("local.responsible_user_aafb0485")}</span>
            <Select value={responsibleUser} onValueChange={setResponsibleUser}>
              {/* Wide enough for "All responsible users" — w-44 truncated it. */}
              <SelectTrigger className="w-52">
                <SelectValue placeholder={l10n("local.responsible_user_aafb0485")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{l10n("local.all_responsible_users_efee37a5")}</SelectItem>
                {(userDirectory.data?.users ?? []).map((u) => (
                  <SelectItem key={u.principalId} value={u.principalId}>
                    {u.user?.name ?? u.user?.email ?? u.principalId.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{l10n("local.action_64cff131")}</span>
          <Select value={actionDomain} onValueChange={setActionDomain}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={l10n("local.action_64cff131")} />
            </SelectTrigger>
            <SelectContent>
              {ACTION_DOMAINS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {!lockedEntity ? (
          <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
            <span>{l10n("local.entity_2ed3bb60")}</span>
            <Select value={entityType} onValueChange={setEntityType}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={l10n("local.entity_2ed3bb60")} />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{l10n("local.from_21819769")}</span>
          <Input
            type="date"
            aria-label={l10n("local.from_date_3813fd07")}
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-36"
          />
        </label>
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{l10n("local.to_f4b06ef6")}</span>
          <Input
            type="date"
            aria-label={l10n("local.to_date_48534888")}
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-36"
          />
        </label>
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {l10n("local.clear_filters_7179ea00")}</Button>
        ) : null}
        {canUseAdvancedControls ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={handleExport}
            disabled={exporting || feed.isLoading || items.length === 0}
          >
            <Download className="mr-1.5 h-4 w-4" />
            {exporting ? l10n("local.exporting_a2dd9cbb") : l10n("local.export_csv_91f71c14")}
          </Button>
        ) : null}
      </div>

      {recoveringFromAccessDowngrade || fallingBackToAllActivity ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            {l10n("local.refreshing_audit_access_1e133c2d")}</CardContent>
        </Card>
      ) : feed.isLoading ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">{l10n("local.loading_ba3bbbe1")}</CardContent>
        </Card>
      ) : feed.error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              {feed.error instanceof Error ? feed.error.message : l10n("local.failed_to_load_the_audit_log_304388ac")}
            </p>
            <Button variant="outline" size="sm" onClick={() => feed.refetch()}>
              {l10n("local.try_again_d8b8392e")}</Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <ScrollText className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilters ? l10n("local.no_actions_match_these_filters_ba222548") : l10n("local.nothing_here_yet_49abaf80")}
              </p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {hasActiveFilters
                  ? l10n("local.try_a_wider_date_range_or_different_filters_b070431d")
                  : resolvedMode === "agents"
                    ? l10n("local.as_soon_as_your_agents_start_doing_things_the_7280b68c")
                    : l10n("local.as_soon_as_anyone_in_your_organization_does_s_f92445e6")}
              </p>
            </div>
            {hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {l10n("local.clear_filters_7179ea00")}</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="border-y border-border">
          <ul className={cn("divide-y divide-border")} aria-label={l10n("local.audit_activity_c01a41f9")}>
            {items.map((record) => (
              <AuditRow
                key={record.id}
                record={record}
                agentMap={agentMap}
                userProfileMap={userProfileMap}
              />
            ))}
          </ul>
        </div>
      )}

      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? l10n("local.loading_ba3bbbe1") : l10n("local.load_more_ac8991ef")}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {l10n("local.recorded_by_paperclip_entries_can_t_be_edited_f95bb996")}</p>
    </div>
  );
}
