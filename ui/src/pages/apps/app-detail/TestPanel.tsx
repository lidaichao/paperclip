import { l10n } from "../../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Loader2,
  Play,
  Search,
  ShieldQuestion,
} from "lucide-react";
import type {
  ToolCatalogEntry,
  ToolConnectionAccessSummary,
  ToolConnectionTestAgent,
  ToolConnectionTestCallResult,
  ToolConnectionTestCallStatus,
  ToolConnectionTestDecision,
  ToolUpstreamPending,
} from "@paperclipai/shared";
import { checkOAuthEndpointUrl } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  JsonSchemaForm,
  getDefaultValues,
  validateJsonSchemaForm,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";
import { cn, relativeTime } from "@/lib/utils";
import { appTabHref } from "../app-tabs";
import { formatActionPermissionSummary } from "./action-permission-summary";

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

/** "1.2s" / "0.4s" — the copy-spec always shows seconds with one decimal. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** relativeTime() returns "just now"; the spec capitalizes it ("Just now"). */
function relTime(date: Date): string {
  const t = relativeTime(date);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sub-line copy: first sentence of the catalog description, no trailing period. */
function actionSubLine(entry: ToolCatalogEntry): string | null {
  if (!entry.description) return null;
  const firstSentence = entry.description.split(/(?<=\.)\s/)[0] ?? entry.description;
  return firstSentence.replace(/\.+$/, "").trim() || null;
}

// ---------------------------------------------------------------------------
// Decision badges
// ---------------------------------------------------------------------------

type DecisionMeta = { label: string; className: string };

type TestAgentWithAccess = ToolConnectionTestAgent & {
  effectiveAccess: ToolConnectionAccessSummary;
};

const TEST_ACCESS_STALE_TIME_MS = 5 * 60_000;
const TEST_ACCESS_GC_TIME_MS = 30 * 60_000;

/**
 * Focused action tester used by the combined Permissions page. The modal keeps
 * the existing schema form and result renderer, but scopes agent selection and
 * test state to the action the user opened.
 */
export function ActionTestDialog({
  connectionId,
  appName,
  entry,
  open,
  onOpenChange,
}: {
  connectionId: string;
  appName: string;
  entry: ToolCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const testAgentsQuery = useQuery({
    queryKey: queryKeys.tools.testAgents(connectionId),
    queryFn: () => toolsApi.listTestAgents(connectionId),
    enabled: open && !!connectionId,
  });
  const agents = useMemo(
    () => [...(testAgentsQuery.data?.agents ?? [])].sort(
      (a, b) => a.orgDepth - b.orgDepth || a.name.localeCompare(b.name),
    ),
    [testAgentsQuery.data],
  );
  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  const agentId = requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)
    ? requestedAgentId
    : agents[0]?.id ?? null;
  const selectedAgentBase = agents.find((agent) => agent.id === agentId) ?? null;
  const accessQuery = useQuery({
    queryKey: queryKeys.tools.testAgentAccess(connectionId, agentId ?? "__none__"),
    queryFn: () => toolsApi.getTestAgentAccess(connectionId, agentId!),
    enabled: open && !!connectionId && !!agentId,
    staleTime: TEST_ACCESS_STALE_TIME_MS,
    gcTime: TEST_ACCESS_GC_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const selectedAgent = useMemo<TestAgentWithAccess | null>(() => (
    selectedAgentBase && accessQuery.data
      ? { ...selectedAgentBase, effectiveAccess: accessQuery.data.access }
      : null
  ), [accessQuery.data, selectedAgentBase]);
  const decision = useMemo<ToolConnectionTestDecision>(() => {
    const tool = selectedAgent?.effectiveAccess.tools.find((candidate) => (
      candidate.toolName === entry.toolName || candidate.gatewayToolName === entry.toolName
    ));
    return tool?.decision ?? "off";
  }, [entry.toolName, selectedAgent]);
  const title = entry.title ?? entry.toolName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{l10n("local.test_532eaabd")}{" "}{title}</DialogTitle>
          <DialogDescription>
            {l10n("local.run_a_real_action_with_the_same_permissions_a_c96dff7a")}</DialogDescription>
        </DialogHeader>

        {testAgentsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            {l10n("local.loading_agents_ae0c1414")}</div>
        ) : testAgentsQuery.isError ? (
          <TestLoadError
            message="We couldn't load the agents available for testing."
            onRetry={() => { void testAgentsQuery.refetch(); }}
          />
        ) : agents.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">{l10n("local.no_agents_are_available_to_test_as_3d77dc6d")}</p>
        ) : accessQuery.isError && !accessQuery.data ? (
          <TestLoadError
            message={`We couldn't load ${selectedAgentBase?.name ?? "this agent"}'s permissions.`}
            onRetry={() => { void accessQuery.refetch(); }}
          />
        ) : !selectedAgent ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            {l10n("local.loading_agent_permissions_f8def289")}</div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">{l10n("local.act_as_66ad5e25")}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <AgentPicker
                  agents={agents}
                  selectedAgent={selectedAgent}
                  onSelect={setRequestedAgentId}
                  connectionId={connectionId}
                  appName={appName}
                  inline
                />
                <DecisionBadge decision={decision} />
              </div>
            </div>
            <ActionTester
              key={`${entry.id}:${selectedAgent.id}`}
              entry={entry}
              decision={decision}
              connectionId={connectionId}
              appName={appName}
              agent={selectedAgent}
              allAgents={agents}
              onSelectAgent={setRequestedAgentId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const DECISION_META: Record<ToolConnectionTestDecision, DecisionMeta> = {
  allowed: {
    label: l10n("local.allowed_1bb201d1"),
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  ask_first: {
    label: l10n("local.ask_first_4a9e8cf3"),
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  off: {
    label: l10n("local.off_ca7981b4"),
    className: "border-border bg-muted text-muted-foreground",
  },
};

function DecisionBadge({ decision }: { decision: ToolConnectionTestDecision }) {
  const meta = DECISION_META[decision];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TestPanel({
  connectionId,
  appName,
  active,
  quarantined = [],
}: {
  connectionId: string;
  appName: string;
  /** Active (non-quarantined, non-removed) catalog entries. */
  active: ToolCatalogEntry[];
  /** New, not-yet-reviewed actions — shown as Off so they're reachable to test. */
  quarantined?: ToolCatalogEntry[];
}) {
  const hasActions = active.length > 0 || quarantined.length > 0;
  const testAgentsQuery = useQuery({
    queryKey: queryKeys.tools.testAgents(connectionId),
    queryFn: () => toolsApi.listTestAgents(connectionId),
    enabled: !!connectionId && hasActions,
  });

  const agents = useMemo(
    () => [...(testAgentsQuery.data?.agents ?? [])].sort(
      (a, b) => a.orgDepth - b.orgDepth || a.name.localeCompare(b.name),
    ),
    [testAgentsQuery.data],
  );

  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  // The API returns only agents this user may write to. Prefer the highest
  // agent in that accessible slice of the org tree, regardless of whether a
  // lower-ranked agent happens to have a broader app policy today.
  const agentId = requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)
    ? requestedAgentId
    : agents[0]?.id ?? null;
  const selectedAgentBase = agents.find((agent) => agent.id === agentId) ?? null;
  const testAgentAccessQuery = useQuery({
    queryKey: queryKeys.tools.testAgentAccess(connectionId, agentId ?? "__none__"),
    queryFn: () => toolsApi.getTestAgentAccess(connectionId, agentId!),
    enabled: !!connectionId && !!agentId && hasActions,
    staleTime: TEST_ACCESS_STALE_TIME_MS,
    gcTime: TEST_ACCESS_GC_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const selectedAgent = useMemo<TestAgentWithAccess | null>(() => (
    selectedAgentBase && testAgentAccessQuery.data
      ? { ...selectedAgentBase, effectiveAccess: testAgentAccessQuery.data.access }
      : null
  ), [selectedAgentBase, testAgentAccessQuery.data]);

  // Per-action decision for the selected agent, keyed by both the upstream and
  // gateway tool names so we can match whatever the catalog stores.
  const decisionByTool = useMemo(() => {
    const map = new Map<string, ToolConnectionTestDecision>();
    for (const tool of selectedAgent?.effectiveAccess.tools ?? []) {
      map.set(tool.toolName, tool.decision);
      map.set(tool.gatewayToolName, tool.decision);
    }
    return map;
  }, [selectedAgent]);

  const decisionFor = (entry: ToolCatalogEntry): ToolConnectionTestDecision =>
    decisionByTool.get(entry.toolName) ?? "off";

  // Search + read/write filter.
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "read" | "write">("all");

  const byName = (a: ToolCatalogEntry, b: ToolCatalogEntry) =>
    (a.title ?? a.toolName).localeCompare(b.title ?? b.toolName);
  const readActions = active.filter((e) => e.isReadOnly).sort(byName);
  const writeActions = active.filter((e) => !e.isReadOnly).sort(byName);

  const matches = (entry: ToolCatalogEntry) => {
    if (kindFilter === "read" && !entry.isReadOnly) return false;
    if (kindFilter === "write" && entry.isReadOnly) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      (entry.title ?? entry.toolName).toLowerCase().includes(needle) ||
      (entry.description ?? "").toLowerCase().includes(needle)
    );
  };

  const quarantinedActions = [...quarantined].sort(byName);

  const visibleRead = readActions.filter(matches);
  const visibleWrite = writeActions.filter(matches);
  const visibleQuarantined = quarantinedActions.filter(matches);
  const visibleCount = visibleRead.length + visibleWrite.length + visibleQuarantined.length;

  if (!hasActions) {
    return <EmptyState connectionId={connectionId} appName={appName} />;
  }

  if (testAgentsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {l10n("local.loading_agents_ae0c1414")}</div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (testAgentsQuery.isError) {
    return (
      <TestLoadError
        message="We couldn't load the agents available for testing."
        onRetry={() => { void testAgentsQuery.refetch(); }}
      />
    );
  }

  if (agents.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm font-medium text-foreground">{l10n("local.no_agents_to_test_as_41e70431")}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {l10n("local.only_agents_you_can_assign_tasks_to_can_previ_6479646d")}{" "}{appName}{l10n("local._give_an_agent_access_in_16f8683e")}{" "}
          <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
            {l10n("local.permissions_abccc78c")}</Link>{" "}
          {l10n("local.to_test_it_here_465ca3a7")}</p>
      </div>
    );
  }

  if (testAgentAccessQuery.isError && !testAgentAccessQuery.data) {
    return (
      <TestLoadError
        message={`We couldn't load ${selectedAgentBase?.name ?? "this agent"}'s permissions.`}
        onRetry={() => { void testAgentAccessQuery.refetch(); }}
      />
    );
  }

  if (testAgentAccessQuery.isLoading || !selectedAgent) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {l10n("local.loading_agent_permissions_f8def289")}</div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const sharedRowProps = {
    connectionId,
    appName,
    allAgents: agents,
    onSelectAgent: setRequestedAgentId,
  };

  return (
    <div className="space-y-8">
      {selectedAgent && (
        <TestAsHeader
          appName={appName}
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={setRequestedAgentId}
          connectionId={connectionId}
        />
      )}

      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-lg font-semibold text-foreground">{l10n("local.actions_ff8059dc")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-(--sz-12rem) flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={l10n("local.find_an_action_efd38349")}
              placeholder={l10n("local.find_an_action_f0eba3ca")}
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <FilterChip label={l10n("local.all_value_5b0190f9", {v0: (active.length + quarantinedActions.length)})} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          <FilterChip label={l10n("local.read_value_e3ff7705", {v0: (readActions.length)})} active={kindFilter === "read"} onClick={() => setKindFilter("read")} />
          <FilterChip label={l10n("local.write_value_830a7ad6", {v0: (writeActions.length)})} active={kindFilter === "write"} onClick={() => setKindFilter("write")} />
        </div>
        <p className="text-xs text-muted-foreground">{visibleCount} {l10n("local.matches_sorted_a_z_f2a4ad9c")}</p>
      </section>

      {visibleCount === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {l10n("local.no_actions_match_e67480ba")}{query}{l10n("local._clear_the_search_to_see_them_all_b115a059")}</div>
      ) : (
        <div className="space-y-6">
          {visibleRead.length > 0 && selectedAgent && (
            <ActionGroup
              heading={`Read (${visibleRead.length})`}
              entries={visibleRead}
              decisionFor={decisionFor}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
          {visibleWrite.length > 0 && selectedAgent && (
            <ActionGroup
              heading={`Write (${visibleWrite.length})`}
              entries={visibleWrite}
              decisionFor={decisionFor}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
          {visibleQuarantined.length > 0 && selectedAgent && (
            <ActionGroup
              heading={`New (${visibleQuarantined.length})`}
              subheading="New actions wait, switched off, until you turn them on."
              entries={visibleQuarantined}
              decisionFor={() => "off" as const}
              agent={selectedAgent}
              {...sharedRowProps}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ connectionId, appName }: { connectionId: string; appName: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-base font-bold text-foreground">{l10n("local.nothing_to_test_yet_e54d49d6")}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        {l10n("local.once_d88f6d83")}{" "}{appName} {l10n("local.is_connected_the_actions_it_offers_will_show_62f29f18")}</p>
      <Button asChild className="mt-4" variant="outline">
        <Link to={appTabHref(connectionId, "permissions")}>{l10n("local.go_to_permissions_f2e0eeb9")}</Link>
      </Button>
    </div>
  );
}

function TestLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-foreground">{message}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        {l10n("local.try_again_d8b8392e")}</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test-as header + agent picker
// ---------------------------------------------------------------------------

function TestAsHeader({
  appName,
  agents,
  selectedAgent,
  onSelect,
  connectionId,
}: {
  appName: string;
  agents: ToolConnectionTestAgent[];
  selectedAgent: TestAgentWithAccess;
  onSelect: (agentId: string) => void;
  connectionId: string;
}) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{l10n("local.test_an_action_391c7ce7")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.run_a_real_action_as_an_agent_054d0a99")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{l10n("local.agent_11b39c93")}</p>
          <AgentPicker
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onSelect}
            connectionId={connectionId}
            appName={appName}
          />
        </div>
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          to={appTabHref(connectionId, "permissions")}
        >
          {formatActionPermissionSummary(selectedAgent.effectiveAccess)}
        </Link>
      </div>
    </section>
  );
}

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
  connectionId,
  appName,
  inline,
}: {
  agents: ToolConnectionTestAgent[];
  selectedAgent: ToolConnectionTestAgent;
  onSelect: (agentId: string) => void;
  connectionId: string;
  appName: string;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "items-center gap-1.5 text-foreground outline-none hover:text-primary focus-visible:text-primary",
            inline ? "inline-flex font-semibold underline-offset-2 hover:underline" : "mt-0.5 flex text-lg font-bold",
          )}
          aria-label={l10n("local.choose_which_agent_to_test_as_2072e751")}
        >
          {selectedAgent.name}
          <ChevronsUpDown className={cn("text-muted-foreground", inline ? "h-3.5 w-3.5" : "h-4 w-4")} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" disablePortal={inline}>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={l10n("local.search_agents_212fd04a")}
              placeholder={l10n("local.search_agents_e05cb78e")}
              className="h-8 pl-8 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">{l10n("local.no_agents_match_8927413a")}</p>
          ) : (
            filtered.map((agent) => {
              const detail = agent.title?.trim() || agent.role;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    onSelect(agent.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
                    agent.id === selectedAgent.id && "bg-accent",
                  )}
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      agent.id === selectedAgent.id ? "text-primary" : "text-transparent",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{agent.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-border px-3 py-2 text-(length:--text-micro) text-muted-foreground">
          <p>{l10n("local.only_agents_you_can_assign_tasks_to_are_liste_b4ee96c6")}</p>
          <p>{l10n("local.pick_one_to_preview_what_they_d_see_in_92ba0929")}{" "}{appName}.</p>
        </div>
        <div className="border-t border-border p-3">
          <p className="text-xs font-semibold text-foreground">{l10n("local.what_the_badges_mean_acd5ccb3")}</p>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            <li><span className="font-medium text-foreground">{l10n("local.allowed_1bb201d1")}</span> {l10n("local._runs_immediately_when_you_press_run_2a9c7130")}</li>
            <li><span className="font-medium text-foreground">{l10n("local.ask_first_4a9e8cf3")}</span> {l10n("local._run_is_parked_in_review_for_your_ok_02d7c231")}</li>
            <li>
              <span className="font-medium text-foreground">{l10n("local.off_ca7981b4")}</span> {l10n("local._won_t_run_change_it_in_3fcad136")}{" "}
              <Link className="text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
                {l10n("local.permissions_abccc78c")}</Link>.
            </li>
          </ul>
          <p className="mt-2 text-(length:--text-micro) text-muted-foreground">
            {l10n("local.badges_reflect_this_agent_s_current_settings_ff41d981")}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Action group + rows
// ---------------------------------------------------------------------------

type RowSharedProps = {
  connectionId: string;
  appName: string;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
};

function ActionGroup({
  heading,
  subheading,
  entries,
  decisionFor,
  agent,
  ...shared
}: {
  heading: string;
  subheading?: string;
  entries: ToolCatalogEntry[];
  decisionFor: (entry: ToolCatalogEntry) => ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
      {subheading && <p className="mb-1.5 -mt-1 text-xs text-muted-foreground">{subheading}</p>}
      <div className="divide-y divide-border">
        {entries.map((entry) => (
          <ActionRow
            key={entry.id}
            entry={entry}
            decision={decisionFor(entry)}
            agent={agent}
            {...shared}
          />
        ))}
      </div>
    </section>
  );
}

function ActionRow({
  entry,
  decision,
  agent,
  ...shared
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  const [open, setOpen] = useState(() => Boolean(loadStoredAskFirstOutcome(shared.connectionId, entry, agent)));
  const title = entry.title ?? entry.toolName;
  const sub = actionSubLine(entry);

  useEffect(() => {
    if (loadStoredAskFirstOutcome(shared.connectionId, entry, agent)) {
      setOpen(true);
    }
  }, [shared.connectionId, entry, agent]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
        >
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{title}</span>
            {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
          </span>
          <DecisionBadge decision={decision} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border py-4 pl-11">
          <ActionTester entry={entry} decision={decision} agent={agent} {...shared} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// The actual tester (form + run + result)
// ---------------------------------------------------------------------------

type RunOutcome = {
  result: ToolConnectionTestCallResult;
  agentName: string;
  durationMs: number;
  ranAt: Date;
};

function testOutcomeStorageKey(connectionId: string, entry: ToolCatalogEntry, agentId: string): string {
  return `paperclip:test-call:${connectionId}:${agentId}:${entry.id}:${entry.toolName}`;
}

function loadStoredAskFirstOutcome(connectionId: string, entry: ToolCatalogEntry, agent: ToolConnectionTestAgent): RunOutcome | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(testOutcomeStorageKey(connectionId, entry, agent.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      result?: ToolConnectionTestCallResult;
      agentName?: string;
      durationMs?: number;
      ranAt?: string;
    };
    if (!parsed.result || parsed.result.decision !== "ask_first" || typeof parsed.result.actionRequestId !== "string") {
      return null;
    }
    return {
      result: parsed.result,
      agentName: parsed.agentName || agent.name,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ranAt: parsed.ranAt ? new Date(parsed.ranAt) : new Date(),
    };
  } catch {
    return null;
  }
}

function storeAskFirstOutcome(connectionId: string, entry: ToolCatalogEntry, agentId: string, outcome: RunOutcome | null) {
  if (typeof window === "undefined") return;
  const key = testOutcomeStorageKey(connectionId, entry, agentId);
  try {
    if (!outcome || outcome.result.decision !== "ask_first") {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify({ ...outcome, ranAt: outcome.ranAt.toISOString() }));
  } catch {
    // Session storage is only a same-tab convenience. If it is unavailable, the
    // request is still visible in Review and the backend lifecycle remains intact.
  }
}

/** Fold optional fields behind the JsonSchemaForm "More options" disclosure. */
function splitRequiredOptional(schema: JsonSchemaNode): JsonSchemaNode {
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const next: Record<string, JsonSchemaNode> = {};
  for (const [key, prop] of Object.entries(props)) {
    const presented = key === "code" && prop.type === "string" && !prop.format ? { ...prop, format: "textarea" } : prop;
    next[key] = required.has(key) ? presented : { ...presented, "x-paperclip-advanced": true };
  }
  return { ...schema, properties: next };
}

const GUT_CHECK: Record<ToolConnectionTestDecision, (app: string, agent: string) => string> = {
  allowed: (app, agent) => `This runs a real call against ${app} as ${agent}.`,
  ask_first: () => `Waiting for your OK before this call leaves Paperclip.`,
  off: (_app, agent) => `No call will be made — this action is off for ${agent}.`,
};

function ActionTester({
  entry,
  decision,
  connectionId,
  appName,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  decision: ToolConnectionTestDecision;
  agent: TestAgentWithAccess;
} & RowSharedProps) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const rawSchema = (entry.inputSchema ?? { type: "object", properties: {} }) as JsonSchemaNode;
  const formSchema = useMemo(() => splitRequiredOptional(rawSchema), [rawSchema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => getDefaultValues(rawSchema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<RunOutcome | null>(() =>
    loadStoredAskFirstOutcome(connectionId, entry, agent)
  );

  // Running card state — keep the spinner visible ≥200ms (anti-flicker).
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);

  const isOff = decision === "off";

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const run = useMutation({
    mutationFn: async () => {
      const result = await toolsApi.runTestCall(connectionId, {
        agentId: agent.id,
        toolName: entry.toolName,
        parameters: values,
      });
      return result;
    },
    onSuccess: (result) => {
      if (cancelledRef.current) return;
      const durationMs = Date.now() - startedAtRef.current;
      const finish = () => {
        if (cancelledRef.current) return;
        const nextOutcome = { result, agentName: agent.name, durationMs, ranAt: new Date() };
        setRunning(false);
        setOutcome(nextOutcome);
        storeAskFirstOutcome(connectionId, entry, agent.id, nextOutcome);
        queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionActivity(connectionId) });
        if (selectedCompanyId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(selectedCompanyId, "pending") });
          queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
        }
      };
      const remaining = 200 - durationMs;
      if (remaining > 0) window.setTimeout(finish, remaining);
      else finish();
    },
    onError: () => {
      if (cancelledRef.current) return;
      setRunning(false);
    },
  });

  const onRun = () => {
    const validationErrors = validateJsonSchemaForm(rawSchema, values);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setOutcome(null);
    setRunning(true);
    run.mutate();
  };

  const onReset = () => {
    cancelledRef.current = true;
    setRunning(false);
    setOutcome(null);
    storeAskFirstOutcome(connectionId, entry, agent.id, null);
    setErrors({});
    setValues(getDefaultValues(rawSchema));
  };

  const onCancelRunning = () => {
    cancelledRef.current = true;
    setRunning(false);
  };

  if (isOff) {
    return (
      <OffExplanation
        entry={entry}
        connectionId={connectionId}
        appName={appName}
        agent={agent}
        allAgents={allAgents}
        onSelectAgent={onSelectAgent}
      />
    );
  }

  const hasFields = Object.keys(rawSchema.properties ?? {}).length > 0;

  return (
    <div className="space-y-4">
      {hasFields ? (
        <JsonSchemaForm
          schema={formSchema}
          values={values}
          onChange={setValues}
          errors={errors}
          disabled={running}
          advancedLabel={l10n("local.more_options_bc79cdff")}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{l10n("local.this_action_takes_no_inputs_53b634e4")}</p>
      )}

      <p className="text-xs text-muted-foreground">{GUT_CHECK[decision](appName, agent.name)}</p>

      <div className="flex items-center gap-2">
        <Button onClick={onRun} disabled={running || !!outcome?.result.upstreamPending?.resumeTool || outcome?.result.decision === "ask_first"} size="sm">
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {l10n("local.running_46c54136")}</>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> {outcome ? l10n("local.run_again_3e310b75") : l10n("local.run_00d60e31")}
            </>
          )}
        </Button>
        <Button onClick={onReset} disabled={running} size="sm" variant="ghost">
          {l10n("local.reset_daee7606")}</Button>
      </div>

      {(outcome?.result.decision === "ask_first" || outcome?.result.upstreamPending?.resumeTool) && <p className="text-xs text-muted-foreground">{l10n("local.finish_the_existing_request_below_use_reset_o_3fdd9c79")}</p>}

      {running && (
        <RunningCard entry={entry} appName={appName} agentName={agent.name} elapsedMs={elapsedMs} onCancel={onCancelRunning} />
      )}

      {run.isError && !running && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {l10n("local.couldn_t_reach_1f4ecca6")}{" "}{agent.name}. {run.error instanceof Error ? run.error.message : l10n("local.please_try_again_eea4fb33")}
        </div>
      )}

      {outcome && !running && (
        <ResultPanel outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} agent={agent} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running card (T6)
// ---------------------------------------------------------------------------

function RunningCard({
  entry,
  appName,
  agentName,
  elapsedMs,
  onCancel,
}: {
  entry: ToolCatalogEntry;
  appName: string;
  agentName: string;
  elapsedMs: number;
  onCancel: () => void;
}) {
  const verb = entry.isReadOnly ? "Reading from" : entry.isWrite ? "Writing to" : "Calling";
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{l10n("local.running_46c54136")}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {verb} {appName} {l10n("local.as_f4bf9f7f")}{" "}{agentName}.
      </p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{l10n("local.started_ecbc89cd")}{" "}{seconds(elapsedMs)} {l10n("local.ago_press_cancel_to_stop_5ee9f4f3")}</span>
        <Button onClick={onCancel} size="sm" variant="outline">
          {l10n("local.cancel_19766ed6")}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result branches
// ---------------------------------------------------------------------------

function ResultPanel({
  outcome,
  entry,
  appName,
  connectionId,
  agent,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
  agent?: TestAgentWithAccess;
}) {
  const { result } = outcome;
  if (result.upstreamPending) return <ProviderPendingResult pending={result.upstreamPending} appName={appName} connectionId={connectionId} agent={agent} />;
  if (result.decision === "ask_first") {
    return <AskFirstResult outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} agent={agent} />;
  }
  if (result.decision === "off") {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        {result.error?.message ?? l10n("local.this_action_is_off_and_won_t_run_78cf41db")}
      </div>
    );
  }
  // The gateway can return `decision:"allowed"` (policy let the call through) yet
  // the upstream MCP tool still fails at the tool layer (`isError:true` in the
  // result envelope). Surface that as a failure card, not the green "Worked" one.
  const toolError = result.error ?? mcpToolError(result.result);
  if (toolError) {
    return <ErrorResult outcome={outcome} appName={appName} connectionId={connectionId} error={toolError} />;
  }
  return <AllowedResult outcome={outcome} entry={entry} appName={appName} connectionId={connectionId} />;
}

function ProviderPendingResult({ pending, appName, connectionId, agent }: { pending: ToolUpstreamPending; appName: string; connectionId: string; agent?: TestAgentWithAccess }) {
  const [resumed, setResumed] = useState<{ outcome: RunOutcome; entry: ToolCatalogEntry; action: "accept" | "decline" | "cancel" } | null>(null);
  const resumeError = resumed && (resumed.outcome.result.error ?? mcpToolError(resumed.outcome.result.result));
  const stoppedByUser = resumed && resumeError?.reasonCode === "tool_error" &&
    ((resumed.action === "decline" && /request was declined by the user/i.test(resumeError.message)) ||
      (resumed.action === "cancel" && /request was cancelled by the user/i.test(resumeError.message)));
  if (stoppedByUser) return <div role="status" className="space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
    <p className="font-medium">{resumed.action === "decline" ? l10n("local.request_declined_1df48b2d") : l10n("local.request_cancelled_7108183f")}</p>
    <p>{resumeError.message}</p>
    <p className="text-muted-foreground">{l10n("local.the_original_call_was_not_repeated_01984966")}</p>
    {pending.executionId && <p>{l10n("local.execution_639fd433")}{" "}<code className="break-all">{pending.executionId}</code></p>}
  </div>;
  if (resumed) return <ResultPanel outcome={resumed.outcome} entry={resumed.entry} appName={appName} connectionId={connectionId} agent={agent} />;
  return (
    <div role="status" className="space-y-3 rounded-md border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium">{pending.kind === "approval" ? l10n("local.approval_needed_9928dd82") : l10n("local.authorization_needed_a82e13a4")} {l10n("local.in_58296753")}{" "}{appName}</p>
      <p className="text-muted-foreground">{l10n("local.paperclip_allowed_this_call_the_provider_need_2b9d26de")}</p>
      {pending.links.map((link) => {
        const checked = checkOAuthEndpointUrl(link.url);
        return checked.ok ? <Button key={checked.url} variant="outline" asChild><a href={checked.url} target="_blank" rel="noopener noreferrer">{l10n("local.continue_at_87476e84")}{" "}{checked.host}</a></Button> : null;
      })}
      {pending.message && <p className="whitespace-pre-wrap break-words">{pending.message}</p>}
      {pending.links.length === 0 && !pending.resumeTool && <p>{l10n("local.open_the_provider_dashboard_to_complete_this_a3a5acdb")}</p>}
      {pending.executionId && <p>{l10n("local.execution_639fd433")}{" "}<code className="break-all">{pending.executionId}</code></p>}
      {pending.elicitationId && <p>{l10n("local.request_3921a1e9")}{" "}<code className="break-all">{pending.elicitationId}</code></p>}
      {pending.expiresAt && <p>{l10n("local.approval_expires_c1c99fa7")}{" "}{new Date(pending.expiresAt).toLocaleTimeString()}.</p>}
      {pending.resumeTool && agent ? <ProviderResumeControls pending={pending} connectionId={connectionId} agent={agent} onResult={setResumed} /> :
      <p className="text-muted-foreground">{pending.resumeTool
        ? l10n("local.after_approval_test_the_value_action_with_thi_0cff2b19", {v0: (pending.resumeTool)})
        : l10n("local.after_authorizing_check_the_provider_s_result_fda63e4f")}</p>}
    </div>
  );
}

function ProviderResumeControls({ pending, connectionId, agent, onResult }: {
  pending: ToolUpstreamPending; connectionId: string; agent: TestAgentWithAccess;
  onResult: (result: { outcome: RunOutcome; entry: ToolCatalogEntry; action: "accept" | "decline" | "cancel" }) => void;
}) {
  const catalog = useQuery({ queryKey: queryKeys.tools.catalog(connectionId), queryFn: () => toolsApi.listCatalog(connectionId) });
  const entry = catalog.data?.catalog.find((item) => item.toolName === pending.resumeTool && item.status === "active");
  const schema = (pending.requestedSchema ?? { type: "object", properties: {} }) as JsonSchemaNode;
  const [content, setContent] = useState<Record<string, unknown>>(() => getDefaultValues(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const resume = useMutation({
    mutationFn: async (action: "accept" | "decline" | "cancel") => {
      const started = Date.now();
      const result = await toolsApi.runTestCall(connectionId, { agentId: agent.id, toolName: entry!.toolName,
        parameters: { executionId: pending.executionId, action, ...(action === "accept" ? { content: JSON.stringify(content) } : {}) } });
      return { result, durationMs: Date.now() - started, agentName: agent.name, ranAt: new Date() };
    }, onSuccess: (outcome, action) => { if (entry) onResult({ outcome, entry, action }); },
  });
  const expired = !!pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now();
  const permission = agent.effectiveAccess.tools.find((tool) => tool.toolName === entry?.toolName)?.decision ?? "off";
  const submit = (action: "accept" | "decline" | "cancel") => {
    const validation = action === "accept" ? validateJsonSchemaForm(schema, content) : {};
    setErrors(validation);
    if (!Object.keys(validation).length) resume.mutate(action);
  };
  return <div className="space-y-3">
    <p className="text-muted-foreground">{l10n("local.review_the_provider_s_request_then_resume_thi_c88d0ec6")}{" "}{agent.name}{l10n("local._the_original_action_will_not_be_started_agai_917c2603")}</p>
    <div className="flex items-center gap-2"><span>{l10n("local.resume_permission_8dd70898")}</span><DecisionBadge decision={permission} /></div>
    {Object.keys(schema.properties ?? {}).length > 0 && <JsonSchemaForm schema={schema} values={content} onChange={setContent} errors={errors} disabled={resume.isPending} />}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("accept")}>{resume.isPending ? l10n("local.resuming_c494e3ca") : l10n("local.approve_and_resume_d052399e")}</Button>
      <Button variant="outline" disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("decline")}>{l10n("local.decline_a2d285b3")}</Button>
      <Button variant="ghost" disabled={!entry || expired || permission === "off" || resume.isPending} onClick={() => submit("cancel")}>{l10n("local.cancel_request_56196683")}</Button>
    </div>
    {expired && <p>{l10n("local.this_provider_approval_expired_check_the_prov_6de678d7")}</p>}
    {permission === "off" && <p>{l10n("local.allow_the_resume_action_in_permissions_before_7f7e0ef9")}</p>}
    {catalog.isError && <p role="alert">{l10n("local.could_not_load_the_resume_action_close_this_t_0049bd24")}</p>}
    {resume.isError && <p role="alert">{resume.error instanceof Error ? resume.error.message : l10n("local.could_not_resume_check_the_provider_before_tr_f0ab463e")}</p>}
  </div>;
}

/**
 * A tool can return `decision:"allowed"` and still fail at the MCP layer — the
 * gateway normalizes that into `{ data: { isError: true }, error: "…" }` inside
 * the result envelope. Pull a renderable error out of that shape, or null when
 * the result is a clean success.
 */
function mcpToolError(value: unknown): { message: string; reasonCode: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === "object" ? (envelope.data as Record<string, unknown>) : null;
  const isError = data?.isError === true || envelope.isError === true;
  if (!isError) return null;
  // Prefer what the app actually said (normalized content text) over the generic
  // gateway wrapper string, falling back to a friendly default.
  const message =
    (typeof envelope.content === "string" && envelope.content.trim() !== "" && envelope.content)
    || (typeof envelope.error === "string" && envelope.error.trim() !== "" && envelope.error)
    || l10n("local.the_app_returned_an_error_result_92bcfd52");
  return { message, reasonCode: "tool_error" };
}

// --- Allowed (T7) ---------------------------------------------------------

/** Pull a row array out of a tool result for the "n rows came back" heuristic. */
function asRows(value: unknown): Record<string, unknown>[] | null {
  const isObjArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((i) => i !== null && typeof i === "object" && !Array.isArray(i));
  if (isObjArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["rows", "values", "items", "data", "results"]) {
      const inner = (value as Record<string, unknown>)[key];
      if (isObjArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return null;
}

function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function writeVerb(entry: ToolCatalogEntry): string | null {
  const n = `${entry.toolName} ${entry.title ?? ""}`.toLowerCase();
  if (/\b(append|add|insert|create|new)\b/.test(n)) return "added";
  if (/\b(update|edit|set|patch|change|modify)\b/.test(n)) return "updated";
  if (/\b(delete|remove|clear|trash)\b/.test(n)) return "removed";
  return null;
}

function successHeadline(value: unknown, entry: ToolCatalogEntry, appName: string): string {
  const verb = writeVerb(entry);
  if (!entry.isReadOnly && verb) return `Worked. Row ${verb}.`;
  const rows = asRows(value);
  if (rows) return `Worked. ${rows.length} ${rows.length === 1 ? "row" : "rows"} came back.`;
  if (isEmptyResult(value)) return "Worked. No data to show.";
  return `Worked. ${appName} sent back the result.`;
}

function AllowedResult({
  outcome,
  entry,
  appName,
  connectionId,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
}) {
  const value = outcome.result.result;
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-foreground">{successHeadline(value, entry, appName)}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {l10n("local.ran_as_2296ffd1")}{" "}{outcome.agentName} · {seconds(outcome.durationMs)} · {relTime(outcome.ranAt)}
      </p>

      {!isEmptyResult(value) && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.preview_324b134f")}</p>
          <div className="mt-1.5">
            <PrettyPreview value={value} />
          </div>
        </div>
      )}

      <RawResponseDisclosure value={value} />

      <p className="mt-3 text-xs text-muted-foreground">
        {l10n("local.this_call_is_in_the_882a49e7")}{" "}
        <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_">
          {l10n("local.audit_log_e4d36f9a")}</Link>
        .
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{l10n("local.last_run_finished_in_e4db11f8")}{" "}{seconds(outcome.durationMs)}.</p>
    </div>
  );
}

/** Pretty preview: table for row arrays, depth-limited JSON otherwise, plain text for strings. */
function PrettyPreview({ value }: { value: unknown }) {
  const rows = asRows(value);
  if (rows) {
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 6);
    const shown = rows.slice(0, 6);
    return (
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((col) => (
                <th key={col} className="px-2.5 py-1.5 font-medium">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className="px-2.5 py-1.5 text-foreground">{cellText(row[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > shown.length && (
          <p className="px-2.5 py-1.5 text-(length:--text-micro) text-muted-foreground">… {rows.length - shown.length} {l10n("local.more_rows_265a0c79")}</p>
        )}
      </div>
    );
  }
  if (typeof value === "string") {
    return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs text-foreground">{value}</pre>;
  }
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
      {safeStringify(collapseDeep(value, 2))}
    </pre>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}

/** Replace objects deeper than `maxDepth` with a placeholder so the tree stays readable. */
function collapseDeep(value: unknown, maxDepth: number, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) return value.map((v) => collapseDeep(v, maxDepth, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = collapseDeep(v, maxDepth, depth + 1);
  }
  return out;
}

function RawResponseDisclosure({ value }: { value: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  if (value === undefined || value === null) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShowRaw((prev) => !prev)}
        className="text-xs font-semibold uppercase tracking-wide text-primary hover:underline"
      >
        {showRaw ? l10n("local.hide_raw_response_914909c4") : l10n("local.show_raw_response_f63a30b5")}
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-foreground">
          {safeStringify(value)}
        </pre>
      )}
    </div>
  );
}

// --- Error (T8) -----------------------------------------------------------

function ErrorResult({
  outcome,
  appName,
  connectionId,
  error,
}: {
  outcome: RunOutcome;
  appName: string;
  connectionId: string;
  error: { message: string; reasonCode: string | null };
}) {
  const hints = errorHints(error.message, error.reasonCode);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">{l10n("local.it_didn_t_work_24edd2c7")}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {l10n("local.tried_as_6836e00c")}{" "}{outcome.agentName} · {seconds(outcome.durationMs)} · {relTime(outcome.ranAt)}
      </p>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.what_f8cf83a7")}{" "}{appName} {l10n("local.said_fb46c79b")}</p>
        <p className="mt-1 break-words text-sm text-foreground">{error.message}</p>
        {error.reasonCode && <p className="mt-0.5 text-xs text-muted-foreground">{l10n("local.code_fad97318")}{" "}{error.reasonCode}</p>}
      </div>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.what_to_try_86fe6080")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-foreground">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{l10n("local.adjust_the_input_above_and_try_again_ea1603a1")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {l10n("local.also_visible_in_the_caab8e41")}{" "}
        <Link className="text-primary hover:underline" to="/activity?mode=agents&action=tool_">
          {l10n("local.audit_log_e4d36f9a")}</Link>
        .
      </p>
    </div>
  );
}

// --- Ask first (T9) — live status polled from the action-request snapshot ---

/** Phases that have settled — once reached, the panel stops polling. */
const TERMINAL_PHASES: ReadonlySet<ToolConnectionTestCallStatus["phase"]> = new Set([
  "done",
  "denied",
  "cancelled",
  "expired",
]);

/** Compact "Where" line from the redacted parameter snapshot: `key: value` pairs. */
function formatWhere(parameters: Record<string, unknown> | null | undefined): string | null {
  if (!parameters) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

function AskFirstResult({
  outcome,
  entry,
  appName,
  connectionId,
  agent,
}: {
  outcome: RunOutcome;
  entry: ToolCatalogEntry;
  appName: string;
  connectionId: string;
  agent?: TestAgentWithAccess;
}) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const actionRequestId = outcome.result.actionRequestId;
  const [cancelled, setCancelled] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.tools.testCallStatus(connectionId, actionRequestId ?? "__none__"),
    queryFn: () => toolsApi.getTestCallStatus(connectionId, actionRequestId!),
    enabled: !!actionRequestId && !cancelled,
    // Poll until the request settles (approved+done, denied, cancelled, expired).
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase && TERMINAL_PHASES.has(phase) ? false : 2000;
    },
  });

  const cancel = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(selectedCompanyId!, actionRequestId!),
    onSuccess: () => {
      setCancelled(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(selectedCompanyId!, "pending") });
      if (selectedCompanyId) queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(selectedCompanyId) });
    },
  });

  const status = statusQuery.data;
  const phase: ToolConnectionTestCallStatus["phase"] = cancelled ? "cancelled" : status?.phase ?? "waiting";

  // Once the call has been approved and run, mutate into the real result shape
  // so the tester sees the response (or failure) without re-running.
  if (phase === "done" && status) {
    if (status.upstreamPending) return <ProviderPendingResult pending={status.upstreamPending} appName={appName} connectionId={connectionId} agent={agent} />;
    // Same as the allowed path: an approved call can still fail at the MCP tool
    // layer (isError:true in the envelope) without a top-level error.
    const toolError = status.error ?? mcpToolError(status.result);
    if (toolError) {
      const errorOutcome: RunOutcome = {
        result: { decision: "allowed", invocationId: status.invocationId, error: toolError },
        agentName: outcome.agentName,
        durationMs: status.durationMs ?? outcome.durationMs,
        ranAt: status.resolvedAt ? new Date(status.resolvedAt) : outcome.ranAt,
      };
      return <ErrorResult outcome={errorOutcome} appName={appName} connectionId={connectionId} error={toolError} />;
    }
    const allowedOutcome: RunOutcome = {
      result: { decision: "allowed", invocationId: status.invocationId, result: status.result },
      agentName: outcome.agentName,
      durationMs: status.durationMs ?? outcome.durationMs,
      ranAt: status.resolvedAt ? new Date(status.resolvedAt) : outcome.ranAt,
    };
    return <AllowedResult outcome={allowedOutcome} entry={entry} appName={appName} connectionId={connectionId} />;
  }

  const requestedAt = status?.requestedAt ? new Date(status.requestedAt) : outcome.ranAt;
  const where = formatWhere(status?.parameters);
  const statusLabel =
    phase === "running"
      ? l10n("local.approved_running_5efaff52")
      : phase === "denied"
        ? l10n("local.denied_see_review_for_why_1d4dee36")
        : phase === "cancelled"
          ? l10n("local.cancelled_d353a99e")
          : phase === "expired"
            ? l10n("local.expired_send_it_again_284e6519")
            : l10n("local.waiting_value_58a31ee9", {v0: (relTime(requestedAt))});
  const settled = phase === "denied" || phase === "cancelled" || phase === "expired";

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-foreground">{l10n("local.sent_for_your_ok_0e672613")}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{outcome.agentName} {l10n("local.needs_your_approval_before_this_runs_d66b3952")}</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.action_64cff131")}</dt>
          <dd className="text-foreground">{entry.title ?? entry.toolName}</dd>
        </div>
        {where && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.where_1daaa38f")}</dt>
            <dd className="break-words text-foreground">{where}</dd>
          </div>
        )}
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.status_920e413c")}</dt>
          <dd className={cn("flex items-center gap-1.5 text-foreground", settled && "text-muted-foreground")}>
            {phase === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
            {statusLabel}
          </dd>
        </div>
      </dl>

      {!settled && (
        <p className="mt-3 text-sm text-foreground">
          {l10n("local.approve_it_in_the_08d0bddb")}{" "}
          <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "review")}>
            {l10n("local.review_tab_d397f91a")}</Link>{" "}
          {l10n("local.to_finish_the_test_you_can_also_cancel_the_re_f71ae5a8")}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={appTabHref(connectionId, "review")}>{l10n("local.open_review_tab_711039fd")}</Link>
        </Button>
        {phase === "waiting" && actionRequestId && selectedCompanyId && (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? l10n("local.cancelling_91b104db") : l10n("local.cancel_this_request_5a0551a4")}
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Off (T10) ------------------------------------------------------------

function OffExplanation({
  entry,
  connectionId,
  agent,
  allAgents,
  onSelectAgent,
}: {
  entry: ToolCatalogEntry;
  connectionId: string;
  appName: string;
  agent: TestAgentWithAccess;
  allAgents: ToolConnectionTestAgent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const title = entry.title ?? entry.toolName;
  const permHref = `${appTabHref(connectionId, "permissions")}?focus=${encodeURIComponent(entry.id)}`;

  // Other agents are intentionally not summarized up front. Selecting one
  // fetches and caches only that agent's access, keeping this screen fast even
  // for large companies.
  const others = allAgents.filter((a) => a.id !== agent.id);

  const whyBody = entry.status === "quarantined"
    ? "This action is new and hasn't been turned on yet."
    : `${agent.name}'s access profile sets this action to Off.`;

  // "Last changed by {Actor} · {relativeTime}" — only the access config carries
  // this; a quarantined action has never been configured, so there's nothing to
  // attribute. Actor is omitted when the latest edit isn't agent-attributable.
  const { lastChangedAt, lastChangedByName } = agent.effectiveAccess;
  const auditHint =
    entry.status !== "quarantined" && lastChangedAt
      ? l10n("local.last_changedvalue_value_e37aa2e2", {v0: (lastChangedByName ? ` by ${lastChangedByName}` : ""), v1: (relTime(new Date(lastChangedAt)))})
      : null;

  return (
    <div className="grid gap-3 md:grid-cols-(--gtc-62)">
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{title} {l10n("local.is_off_for_edb83935")}{" "}{agent.name}.</p>
            <p className="mt-0.5">{l10n("local.it_won_t_run_here_and_it_won_t_run_from_a_tas_9b8d2fd9")}</p>
            <p className="mt-2">
              {l10n("local.want_to_test_it_turn_it_on_for_b2d4e90b")}{" "}{agent.name} {l10n("local.in_58296753")}{" "}
              <Link className="font-medium text-primary hover:underline" to={appTabHref(connectionId, "permissions")}>
                {l10n("local.permissions_abccc78c")}</Link>{" "}
              {l10n("local._set_it_to_allowed_or_ask_first_61103134")}</p>
          </div>
        </div>
        <Button asChild size="sm">
          <Link to={permHref}>{l10n("local.open_permissions_1ac1cf8c")}</Link>
        </Button>
        <p className="text-xs text-muted-foreground">{l10n("local.no_call_will_be_made_this_action_is_off_for_72140032")}{" "}{agent.name}.</p>
      </div>

      <aside>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{l10n("local.why_this_is_off_d9e46653")}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">{whyBody}</p>
        {auditHint && <p className="mt-1.5 text-(length:--text-micro) text-muted-foreground">{auditHint}</p>}
        {others.length > 0 && (
          <div className="mt-3">
            <p className="text-(length:--text-micro) font-medium text-muted-foreground">{l10n("local.try_as_a_different_agent_d143ee44")}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {others.slice(0, 4).map((other) => (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => onSelectAgent(other.id)}
                  className="rounded-full border border-border px-2.5 py-1 text-(length:--text-micro) font-medium text-foreground hover:bg-accent"
                >
                  {other.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Tailored next steps keyed on the upstream/gateway error. Mirrors the
 * board-accepted copy-spec error-hint lookup (NOT_FOUND / PERMISSION_DENIED /
 * INVALID_ARGUMENT / RATE_LIMIT) with the locked generic fallback otherwise.
 */
export function errorHints(message: string, reasonCode: string | null | undefined): string[] {
  const haystack = `${reasonCode ?? ""} ${message}`.toUpperCase();
  if (haystack.includes("NOT_FOUND")) {
    return [
      "Double-check the ID or name you entered — pick it from a dropdown if one is offered.",
      "Make sure this agent has access to that resource in the connected account.",
    ];
  }
  if (haystack.includes("PERMISSION") || haystack.includes("FORBIDDEN") || haystack.includes("UNAUTHORIZED")) {
    return [
      "The connected account may not have permission for this action.",
      "Reconnect the app from Setup if its access was recently changed.",
    ];
  }
  if (haystack.includes("INVALID_ARGUMENT") || haystack.includes("INVALID") || haystack.includes("BAD_REQUEST")) {
    return [
      "Check the field formats above — a value may be the wrong type or shape.",
      "Open “More options” to confirm any advanced fields are filled in correctly.",
    ];
  }
  if (haystack.includes("RATE_LIMIT") || haystack.includes("RESOURCE_EXHAUSTED") || haystack.includes("429")) {
    return ["The app is rate-limiting calls right now — wait a moment and run it again."];
  }
  // Locked generic fallback (copy-spec decision #2).
  return ["Check the inputs above and try again."];
}
