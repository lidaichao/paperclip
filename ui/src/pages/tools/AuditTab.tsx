import { l10n } from "../../i18n";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Link } from "@/lib/router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import {
  toolsApi,
  type ToolAuditOutcome,
  type ToolAuditWindow,
  type ToolGatewayActivityEvent,
} from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime } from "./shared";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Outcome chip vocabulary (spec §4C / §5): Allowed · Blocked · Asked first · Failed · Waiting. */
const OUTCOME_META: Record<ToolAuditOutcome, { label: string; status: string }> = {
  allowed: { label: l10n("local.allowed_1bb201d1"), status: "allowed" },
  blocked: { label: l10n("local.blocked_18f2a094"), status: "denied" },
  asked_first: { label: l10n("local.asked_first_db928628"), status: "require-approval" },
  waiting: { label: l10n("local.waiting_6e293a8c"), status: "deferred" },
  failed: { label: l10n("local.failed_031a8f0f"), status: "failed" },
  unknown: { label: l10n("local.recorded_c7175fa7"), status: "unchecked" },
};

const OUTCOME_FILTERS: { value: string; label: string }[] = [
  { value: ALL, label: l10n("local.all_outcomes_1d7f920d") },
  { value: "allowed", label: l10n("local.allowed_1bb201d1") },
  { value: "blocked", label: l10n("local.blocked_18f2a094") },
  { value: "asked_first", label: l10n("local.asked_first_db928628") },
  { value: "waiting", label: l10n("local.waiting_6e293a8c") },
  { value: "failed", label: l10n("local.failed_031a8f0f") },
];

const WINDOW_FILTERS: { value: ToolAuditWindow; label: string }[] = [
  { value: "all", label: l10n("local.all_time_9755c8d7") },
  { value: "1h", label: l10n("local.last_1_hour_3e88e241") },
  { value: "24h", label: l10n("local.last_24_hours_5c37cf8f") },
  { value: "7d", label: l10n("local.last_7_days_0603deca") },
  { value: "30d", label: l10n("local.last_30_days_f8f03fb4") },
];

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const v = details?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function detailStringArray(details: Record<string, unknown> | null, key: string): string[] {
  const v = details?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function detailRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function detailNumber(details: Record<string, unknown> | null, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formattedArguments(details: Record<string, unknown> | null): string | undefined {
  const summary = detailRecord(details?.argumentsSummary);
  const serialized = typeof summary?.summary === "string" ? summary.summary : undefined;
  if (!serialized) return undefined;
  try {
    return JSON.stringify(JSON.parse(serialized), null, 2);
  } catch {
    return serialized;
  }
}

function lifecycleSummary(event: ToolGatewayActivityEvent): string | null {
  if (!event.lifecycleType) return null;
  const who = event.actorDisplayName ?? event.agentDisplayName ?? l10n("local.someone_864c855e");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? l10n("local.this_app_0d600001");
  const count = detailNumber(event.details, "count") ?? 0;
  const added = detailNumber(event.details, "added") ?? 0;
  const removed = detailNumber(event.details, "removed") ?? 0;
  switch (event.lifecycleType) {
    case "app_connected":
      return l10n("local.value_connected_value_7f21dc36", {v0: (who), v1: (app)});
    case "app_paused":
      return l10n("local.value_paused_value_2676da75", {v0: (who), v1: (app)});
    case "app_resumed":
      return l10n("local.value_resumed_value_e2c666a2", {v0: (who), v1: (app)});
    case "reconnected":
      return l10n("local.value_reconnected_value_eebbeb9f", {v0: (who), v1: (app)});
    case "disconnected":
      return l10n("local.value_disconnected_value_e9e1100d", {v0: (who), v1: (app)});
    case "allowlist_changed":
      if (added > 0 && removed === 0) return l10n("local.value_added_count_allowed_items_in_value_0d600016", { v0: who, v1: added, v2: app });
      if (removed > 0 && added === 0) return l10n("local.value_removed_count_allowed_items_in_value_0d600017", { v0: who, v1: removed, v2: app });
      return l10n("local.value_updated_the_allowlist_for_value_989cd241", {v0: (who), v1: (app)});
    case "actions_quarantined":
      return count === 1
        ? l10n("local.one_new_action_needs_review_in_value_0d600002", { v0: app })
        : l10n("local.count_new_actions_need_review_in_value_0d600003", { v0: count, v1: app });
    default:
      return l10n("local.value_updated_value_1e8c0c4e", {v0: (who), v1: (app)});
  }
}

/** Plain-words "why" for the row expander, keyed off the reason code. */
function plainReason(event: ToolGatewayActivityEvent): string {
  if (event.lifecycleType) return l10n("local.connection_change_recorded_in_activity_history_0d600004");
  const code = detailString(event.details, "reasonCode");
  if (code === "permitted_connections_not_installed") {
    return l10n("local.permitted_connections_not_installed_tools_not_added_0d600005");
  }
  switch (event.normalizedOutcome) {
    case "allowed":
      return l10n("local.allowed_by_your_rules_0d600006");
    case "blocked":
      if (code === "rate_limited") return l10n("local.blocked_too_many_runs_in_short_window_0d600007");
      if (code?.includes("secret")) return l10n("local.blocked_to_protect_sensitive_value_0d600008");
      return l10n("local.blocked_by_a_rule_0d600009");
    case "asked_first":
      return l10n("local.held_for_approval_before_running_0d600010");
    case "waiting":
      return l10n("local.waiting_app_not_ready_0d600011");
    case "failed":
      return l10n("local.app_was_allowed_but_returned_error_0d600012");
    default:
      return l10n("local.recorded_by_alice_0d400006");
  }
}

/** Compact monospace fact row inside the Details collapse. */
function DetailFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-foreground", mono && "font-mono text-(length:--text-micro)")}>{value}</span>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: ToolAuditOutcome }) {
  const meta = OUTCOME_META[outcome] ?? OUTCOME_META.unknown;
  return <StatusBadge status={meta.status} label={meta.label} />;
}

function ActivityRow({
  event,
  ruleNamesById,
}: {
  event: ToolGatewayActivityEvent;
  ruleNamesById: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const who = event.agentDisplayName ?? l10n("local.an_agent_ea6a0363");
  const action = event.toolDisplayName ?? l10n("local.an_action_0d600013");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? event.applicationDisplayName ?? null;
  const lifecycle = lifecycleSummary(event);
  const rawTool = detailString(event.details, "tool") ?? detailString(event.details, "toolName");

  const issueId = detailString(event.details, "issueId");
  const runId = event.runId ?? detailString(event.details, "runId");
  const agentId = event.agentId ?? detailString(event.details, "agentId");
  const reasonCode = detailString(event.details, "reasonCode") ?? event.action.replace("tool_gateway.", "");
  const matchedRuleId = detailStringArray(event.details, "matchedPolicyIds").find((id) => ruleNamesById.has(id));
  const matchedRuleName = matchedRuleId ? ruleNamesById.get(matchedRuleId) : undefined;
  const argumentsText = formattedArguments(event.details);
  const execution = detailRecord(event.details?.execution);
  const request = detailRecord(execution?.request);
  const response = detailRecord(execution?.response);
  const transport = detailString(execution, "transport");
  const requestMethod = detailString(request, "httpMethod");
  const endpoint = detailString(request, "endpoint");
  const mcpMethod = detailString(request, "mcpMethod");
  const requestId = detailString(request, "requestId");
  const httpStatus = detailNumber(response, "httpStatus");
  const contentType = detailString(response, "contentType");
  const responseBytes = detailNumber(response, "bodySizeBytes");
  const upstreamRequestId = detailString(response, "upstreamRequestId");
  const permittedNotInstalledCount = detailNumber(event.details, "permittedNotInstalledCount");
  const permittedNotInstalledConnections = Array.isArray(event.details?.permittedNotInstalledConnections)
    ? event.details.permittedNotInstalledConnections
      .map(detailRecord)
      .filter((connection): connection is Record<string, unknown> => connection !== null)
    : [];
  const isRuntimeMcpDeliveryDiagnostic = reasonCode === "permitted_connections_not_installed";

  return (
    <li className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-accent/50"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          {lifecycle ? (
            <span className="block text-foreground">{lifecycle}</span>
          ) : isRuntimeMcpDeliveryDiagnostic ? (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span>{l10n("local._s_run_received_0_mcp_servers_76fb4163")}{" "}
              <span className="font-medium">{permittedNotInstalledCount ?? permittedNotInstalledConnections.length}</span>{" "}
              {l10n("local.permitted_739ffeed")}{" "}{(permittedNotInstalledCount ?? permittedNotInstalledConnections.length) === 1 ? l10n("local.connection_b38d9d16") : l10n("local.connections_1e5fac86")} {l10n("local.not_installed_e9363f76")}</span>
          ) : (
            <span className="block text-foreground">
              <span className="font-medium">{who}</span> {l10n("local.used_f8391613")}{" "}<span className="font-medium">{action}</span>
              {app ? (
                <>
                  {" "}
                  {l10n("local.in_58296753")}{" "}<span className="font-medium">{app}</span>
                </>
              ) : null}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          {event.lifecycleType ? null : <OutcomeChip outcome={event.normalizedOutcome} />}
          <span className="text-xs text-muted-foreground">
            · <RelativeTime value={event.createdAt} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border bg-muted/30 px-4 py-3 pl-10 text-sm">
          <p className="text-foreground">
            {plainReason(event)}
            {matchedRuleName ? (
              <>
                {" "}
                <span className="font-medium">{matchedRuleName}</span>
              </>
            ) : null}
          </p>

          <div className="flex flex-wrap gap-3 text-xs">
            {issueId ? (
              <Link to={`/issues/${issueId}`} className="text-primary hover:underline">
                {l10n("local.view_task_01444a2b")}</Link>
            ) : null}
            {runId && agentId ? (
              <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">
                {l10n("local.view_run_aaf7fccc")}</Link>
            ) : null}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {l10n("local.details_45989de4")}</button>
            {detailsOpen ? (
              <div className="mt-2 space-y-1.5 text-xs">
                {rawTool ? <DetailFact label={l10n("local.action_name_323a3fff")} value={rawTool} mono /> : null}
                <DetailFact label={l10n("local.reason_code_9e13ec9e")} value={reasonCode} mono />
                <DetailFact label={l10n("local.actor_type_6d003d9d")} value={event.actorType ?? "—"} />
                {runId ? <DetailFact label={l10n("local.run_id_26d3e7aa")} value={runId} mono /> : null}
                {transport ? <DetailFact label={l10n("local.transport_aaead4ab")} value={transport} mono /> : null}
                {requestMethod && endpoint ? <DetailFact label={l10n("local.http_request_f1ee1152")} value={`${requestMethod} ${endpoint}`} mono /> : null}
                {mcpMethod ? <DetailFact label={l10n("local.mcp_method_e810a950")} value={mcpMethod} mono /> : null}
                {requestId ? <DetailFact label={l10n("local.request_id_d561f528")} value={requestId} mono /> : null}
                {request ? <DetailFact label={l10n("local.dispatched_a43dccad")} value={request.dispatched === true ? l10n("local.yes_85a39ab3") : l10n("local.no_1ea442a1")} /> : null}
                {httpStatus !== undefined ? <DetailFact label={l10n("local.http_status_0f7cf91f")} value={String(httpStatus)} mono /> : null}
                {contentType ? <DetailFact label={l10n("local.content_type_6f51cb04")} value={contentType} mono /> : null}
                {responseBytes !== undefined ? <DetailFact label={l10n("local.response_size_3bbd79b4")} value={l10n("local.value_bytes_0d600014", { v0: responseBytes })} /> : null}
                {upstreamRequestId ? <DetailFact label={l10n("local.upstream_id_56ca20b2")} value={upstreamRequestId} mono /> : null}
                {isRuntimeMcpDeliveryDiagnostic ? (
                  <>
                    <DetailFact label={l10n("local.delivered_mcp_servers_e8f93a3e")} value="0" mono />
                    {permittedNotInstalledConnections.map((connection) => {
                      const connectionId = detailString(connection, "id");
                      const connectionName = detailString(connection, "name") ?? l10n("local.unnamed_connection_0d600015");
                      return connectionId ? (
                        <div key={connectionId} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{l10n("local.not_installed_d177cdc0")}</span>
                          <Link to={`/apps/${connectionId}/permissions`} className="font-medium text-primary hover:underline">
                            {connectionName}
                          </Link>
                        </div>
                      ) : null;
                    })}
                  </>
                ) : null}
                {argumentsText ? (
                  <div className="space-y-1">
                    <span className="text-muted-foreground">{l10n("local.parameters_redacted_7aa473af")}</span>
                    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                      {argumentsText}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AuditTab({ companyId }: { companyId: string }) {
  const [app, setApp] = useState<string>(ALL);
  const [agent, setAgent] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [windowKey, setWindowKey] = useState<ToolAuditWindow>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box so each keystroke doesn't fire a server request.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  // Map matched rule IDs to their humanized names for the row "why" link.
  const policies = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: () => toolsApi.listPolicies(companyId),
  });
  const ruleNamesById = useMemo(
    () => new Map((policies.data?.policies ?? []).map((p) => [p.id, p.name])),
    [policies.data],
  );

  const filters = {
    app: app === ALL ? undefined : app,
    agent: agent === ALL ? undefined : agent,
    outcome: outcome === ALL ? undefined : outcome,
    window: windowKey,
    search: search || undefined,
  };
  const hasActiveFilters =
    app !== ALL || agent !== ALL || outcome !== ALL || windowKey !== "all" || search.length > 0;

  const activity = useInfiniteQuery({
    queryKey: queryKeys.tools.activity(companyId, {
      app: filters.app,
      agent: filters.agent,
      outcome: filters.outcome,
      window: filters.window,
      search: filters.search,
    }),
    queryFn: ({ pageParam }) =>
      toolsApi.listActivity(companyId, { ...filters, limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const events = useMemo(
    () => activity.data?.pages.flatMap((page) => page.events) ?? [],
    [activity.data],
  );

  const clearFilters = () => {
    setApp(ALL);
    setAgent(ALL);
    setOutcome(ALL);
    setWindowKey("all");
    setSearchInput("");
    setSearch("");
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title={l10n("local.activity_38da1505")}
        description={l10n("local.what_your_agents_actually_did_with_your_apps_c7a12a9c")}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={l10n("local.app_0d04bfeb")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{l10n("local.all_apps_01bed311")}</SelectItem>
            {(apps.data?.applications ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AgentSelect
          agents={[{ id: ALL, name: l10n("local.all_agents_54c32d3e") }, ...(agents.data ?? [])]}
          value={agent}
          onChange={setAgent}
          triggerClassName="w-40"
        />
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={windowKey} onValueChange={(v) => setWindowKey(v as ToolAuditWindow)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={l10n("local.search_activity_6f14857b")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="max-w-xs"
        />
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {l10n("local.clear_filters_7179ea00")}</Button>
        ) : null}
      </div>

      {activity.isLoading ? (
        <LoadingState />
      ) : activity.error ? (
        <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
      ) : events.length === 0 ? (
        hasActiveFilters ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{l10n("local.no_activity_matches_these_filters_2acc5c10")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {l10n("local.try_a_wider_time_window_or_different_filters_4e97d386")}</p>
              </div>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {l10n("local.clear_filters_7179ea00")}</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground">{l10n("local.nothing_here_yet_49abaf80")}</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {l10n("local.as_soon_as_your_agents_start_using_connected_3d3eaa19")}</p>
              </div>
            </CardContent>
          </Card>
        )
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <ul className="divide-y divide-border">
              {events.map((event) => (
                <ActivityRow key={event.id} event={event} ruleNamesById={ruleNamesById} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {activity.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => activity.fetchNextPage()}
            disabled={activity.isFetchingNextPage}
          >
            {activity.isFetchingNextPage ? l10n("local.loading_ba3bbbe1") : l10n("local.load_more_ac8991ef")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
