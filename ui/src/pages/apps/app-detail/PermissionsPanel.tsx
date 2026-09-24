import { l10n } from "../../../i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ban, Check, FlaskConical, Loader2, RefreshCw, Search, ShieldQuestion } from "lucide-react";
import type { Agent, ToolCatalogEntry, ToolConnectionCapabilities } from "@paperclipai/shared";
import { useSearchParams } from "@/lib/router";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type InstallState } from "@/lib/tool-installs";
import { QuarantinedActionsReview } from "./SetupPanel";
import { ActionTestDialog } from "./TestPanel";
import type { AccessDraft, AppDetailSectionProps } from "./types";

type ActionPermission = "off" | "ask" | "allowed";
type ActionKindFilter = "all" | "read" | "write";

export function PermissionsPanel({
  connectionId,
  appName,
  agents,
  access,
  install,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  pending,
  onSaveAccess,
  onSetActionPermission,
  onReviewQuarantined,
  onRefreshActions,
  refreshPending,
  capabilities,
  permissionChangeWarning,
  actions,
}: Pick<
  AppDetailSectionProps,
  | "appName"
  | "agents"
  | "access"
  | "readOnly"
  | "canChange"
  | "quarantined"
  | "enabledIds"
  | "askFirstIds"
  | "pending"
> & {
  connectionId: string;
  install: InstallState;
  onSaveAccess: (next: AccessDraft) => void;
  onSetActionPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
  refreshPending: boolean;
  capabilities: ToolConnectionCapabilities | undefined;
  permissionChangeWarning?: string;
  /** A credential-only connection can supply its account controls instead of tool actions. */
  actions?: ReactNode;
}) {
  const [searchParams] = useSearchParams();
  return (
    <div className="space-y-10">
      <AgentAccessSection
        agents={agents}
        access={access}
        install={install}
        capabilities={capabilities}
        disabled={pending}
        onSave={onSaveAccess}
      />
      {actions !== undefined ? actions : <ActionsSection
        key={connectionId}
        connectionId={connectionId}
        appName={appName}
        readOnly={readOnly}
        canChange={canChange}
        quarantined={quarantined}
        enabledIds={enabledIds}
        askFirstIds={askFirstIds}
        disabled={pending}
        refreshPending={refreshPending}
        focusId={searchParams.get("focus")}
        canConfigure={capabilities?.canConfigure ?? false}
        permissionChangeWarning={permissionChangeWarning}
        onSetPermission={onSetActionPermission}
        onReviewQuarantined={onReviewQuarantined}
        onRefreshActions={onRefreshActions}
      />}
    </div>
  );
}

function AgentAccessSection({
  agents,
  access,
  install,
  capabilities,
  disabled,
  onSave,
}: {
  agents: Agent[];
  access: AccessDraft;
  install: InstallState;
  capabilities: ToolConnectionCapabilities | undefined;
  disabled: boolean;
  onSave: (next: AccessDraft) => void;
}) {
  const liveAgents = agents.filter((agent) => agent.status !== "terminated");
  const canManage = capabilities?.canConfigure ?? false;
  const editableAgentIds = capabilities?.editableAgentIds;
  const selectableAgents = editableAgentIds
    ? liveAgents.filter((agent) => editableAgentIds.includes(agent.id))
    : liveAgents;
  const selectedAgents = liveAgents.filter((agent) => access.agentIds.has(agent.id));
  const requiredAgentIds = install.agentIds;

  return (
    <section className="space-y-4 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{l10n("local.which_agents_can_use_this_connection_a315e64c")}</h2>
        {disabled ? <span className="text-xs text-muted-foreground">{l10n("local.saving_23e39291")}</span> : null}
      </div>

      {canManage ? (
        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={l10n("local.which_agents_can_use_this_connection_f2fa54ec")}
            value={access.mode}
            disabled={disabled}
            className="sm:grid-cols-2"
            onValueChange={(next) => {
              if (next === "all") onSave({ mode: "all", agentIds: new Set() });
              else onSave({
                mode: "specific",
                agentIds: new Set([...access.agentIds, ...requiredAgentIds]),
              });
            }}
            options={[
              {
                value: "specific",
                title: l10n("local.just_agents_i_pick_d2b7ad83"),
                description: install.onAll
                  ? l10n("local.unavailable_while_this_connection_is_installe_61108305")
                  : l10n("local.available_only_to_selected_agents_57ff838e"),
                disabled: install.onAll,
              },
              {
                value: "all",
                title: l10n("local.any_agent_ee3e7690"),
                description: l10n("local.available_across_your_company_0fecc5d5"),
              },
            ]}
          />

          {access.mode === "specific" ? (
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={access.agentIds}
              disabled={disabled}
              triggerLabel={access.agentIds.size === 0
                ? l10n("local.choose_agents_14300162")
                : l10n("local.value_value_selected_c05d4e8d", {v0: (access.agentIds.size), v1: (access.agentIds.size === 1 ? "agent" : "agents")})}
              emptyMessage={l10n("local.you_cannot_edit_any_agents_yet_1fe14169")}
              isAgentDisabled={(agent) => requiredAgentIds.has(agent.id)}
              getDescription={(agent) => requiredAgentIds.has(agent.id) ? "Required by this connection's install setting" : agent.title}
              onChange={(agentIds) => onSave({
                mode: "specific",
                agentIds: new Set([...agentIds, ...requiredAgentIds]),
              })}
            />
          ) : null}
        </div>
      ) : access.mode === "all" ? (
        <p className="text-sm text-muted-foreground">{l10n("local.any_agent_can_use_this_connection_8f6ff97f")}</p>
      ) : selectedAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{l10n("local.no_agents_can_use_this_connection_de5ab3d9")}</p>
      ) : (
        <div className="space-y-0.5">
          {selectedAgents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-2 px-1.5 py-1 text-sm">
              <AgentAvatar agent={agent} size={16} className="h-4 w-4 shrink-0 text-muted-foreground"/>
              <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ActionsSection({
  connectionId,
  appName,
  readOnly,
  canChange,
  quarantined,
  enabledIds,
  askFirstIds,
  disabled,
  refreshPending,
  focusId,
  canConfigure,
  permissionChangeWarning,
  onSetPermission,
  onReviewQuarantined,
  onRefreshActions,
}: {
  connectionId: string;
  appName: string;
  readOnly: ToolCatalogEntry[];
  canChange: ToolCatalogEntry[];
  quarantined: ToolCatalogEntry[];
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  refreshPending: boolean;
  focusId?: string | null;
  canConfigure: boolean;
  permissionChangeWarning?: string;
  onSetPermission: (id: string, next: ActionPermission) => void;
  onReviewQuarantined: (enabledIds: string[]) => void;
  onRefreshActions: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ActionKindFilter>("all");
  const [showPermissionChangeWarning, setShowPermissionChangeWarning] = useState(false);
  const byName = (a: ToolCatalogEntry, b: ToolCatalogEntry) =>
    (a.title ?? a.toolName).localeCompare(b.title ?? b.toolName);
  const sortedRead = useMemo(() => [...readOnly].sort(byName), [readOnly]);
  const sortedWrite = useMemo(() => [...canChange].sort(byName), [canChange]);
  const matches = (entry: ToolCatalogEntry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (entry.title ?? entry.toolName).toLowerCase().includes(needle)
      || (entry.description ?? "").toLowerCase().includes(needle);
  };
  const visibleRead = kindFilter === "write" ? [] : sortedRead.filter(matches);
  const visibleWrite = kindFilter === "read" ? [] : sortedWrite.filter(matches);
  const visibleCount = visibleRead.length + visibleWrite.length;

  return (
    <section className="space-y-6 border-t border-border pt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">{l10n("local.actions_ff8059dc")}</h2>
        {canConfigure ? (
          <div className="flex items-center gap-2">
            {disabled ? <span className="text-xs text-muted-foreground">{l10n("local.saving_23e39291")}</span> : null}
            <Button
              variant="outline"
              size="sm"
              onClick={onRefreshActions}
              disabled={refreshPending || disabled}
            >
              {refreshPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {l10n("local.refresh_actions_ee8e81d5")}</Button>
          </div>
        ) : null}
      </div>

      {canConfigure && quarantined.length > 0 ? (
        <QuarantinedActionsReview
          entries={quarantined}
          disabled={disabled}
          onSubmit={onReviewQuarantined}
        />
      ) : null}

      {permissionChangeWarning && showPermissionChangeWarning ? (
        <InlineBanner tone="warning" compact>
          {permissionChangeWarning}
        </InlineBanner>
      ) : null}

      <div className="space-y-2">
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
          <FilterChip label={l10n("local.all_value_5b0190f9", {v0: (readOnly.length + canChange.length)})} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          <FilterChip label={l10n("local.read_value_e3ff7705", {v0: (readOnly.length)})} active={kindFilter === "read"} onClick={() => setKindFilter("read")} />
          <FilterChip label={l10n("local.write_value_830a7ad6", {v0: (canChange.length)})} active={kindFilter === "write"} onClick={() => setKindFilter("write")} />
        </div>
        <p className="text-xs text-muted-foreground">{visibleCount} {l10n("local.matches_sorted_a_z_f2a4ad9c")}</p>
      </div>

      {visibleCount === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {l10n("local.no_actions_match_e67480ba")}{query}{l10n("local._clear_the_search_to_see_them_all_b115a059")}</div>
      ) : (
        <div className="space-y-6">
          <ActionGroup
            title={l10n("local.read_value_4a8a12ac", {v0: (visibleRead.length)})}
            actions={visibleRead}
            connectionId={connectionId}
            appName={appName}
            enabledIds={enabledIds}
            askFirstIds={askFirstIds}
            disabled={disabled}
            focusId={focusId}
            canConfigure={canConfigure}
            onSetPermission={(id, next) => {
              setShowPermissionChangeWarning(true);
              onSetPermission(id, next);
            }}
          />
          <ActionGroup
            title={l10n("local.write_value_4f9cbca3", {v0: (visibleWrite.length)})}
            actions={visibleWrite}
            connectionId={connectionId}
            appName={appName}
            enabledIds={enabledIds}
            askFirstIds={askFirstIds}
            disabled={disabled}
            focusId={focusId}
            canConfigure={canConfigure}
            onSetPermission={(id, next) => {
              setShowPermissionChangeWarning(true);
              onSetPermission(id, next);
            }}
          />
        </div>
      )}
    </section>
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

function ActionGroup({
  title,
  actions,
  connectionId,
  appName,
  enabledIds,
  askFirstIds,
  disabled,
  focusId,
  canConfigure,
  onSetPermission,
}: {
  title: string;
  actions: ToolCatalogEntry[];
  connectionId: string;
  appName: string;
  enabledIds: Set<string>;
  askFirstIds: Set<string>;
  disabled: boolean;
  focusId?: string | null;
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border">
        {actions.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            connectionId={connectionId}
            appName={appName}
            value={actionPermission(action.id, enabledIds, askFirstIds)}
            disabled={disabled}
            focused={focusId === action.id}
            canConfigure={canConfigure}
            onSetPermission={onSetPermission}
          />
        ))}
      </div>
    </div>
  );
}

const PERMISSION_OPTIONS: Array<{
  value: ActionPermission;
  label: string;
  description: string;
  icon: typeof Ban;
}> = [
  { value: "off", label: l10n("local.off_ca7981b4"), description: l10n("local.agents_cannot_run_this_action_91ab626d"), icon: Ban },
  { value: "ask", label: l10n("local.ask_first_4a9e8cf3"), description: l10n("local.a_human_must_approve_each_call_d07c9e49"), icon: ShieldQuestion },
  { value: "allowed", label: l10n("local.allowed_1bb201d1"), description: l10n("local.runs_without_approval_01d38af7"), icon: Check },
];

function ActionRow({
  action,
  connectionId,
  appName,
  value,
  disabled,
  focused,
  canConfigure,
  onSetPermission,
}: {
  action: ToolCatalogEntry;
  connectionId: string;
  appName: string;
  value: ActionPermission;
  disabled: boolean;
  focused: boolean;
  canConfigure: boolean;
  onSetPermission: (id: string, next: ActionPermission) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const title = action.title ?? action.toolName;

  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  return (
    <>
      <div
        ref={rowRef}
        className={cn(
          "flex flex-col gap-3 py-3 sm:flex-row sm:items-center",
          focused && "rounded-md bg-primary/5 ring-2 ring-primary/40",
        )}
        data-action-id={action.id}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {action.description ? (
            <div className="truncate text-xs text-muted-foreground">{action.description}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canConfigure ? (
            <TooltipProvider>
              <div
                role="radiogroup"
                aria-label={l10n("local.value_permission_582af8ae", {v0: (title)})}
                className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
              >
              {PERMISSION_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = option.value === value;
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={`${title}: ${option.label}`}
                        disabled={disabled}
                        onClick={() => onSetPermission(action.id, option.value)}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors",
                          "hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                          selected && "bg-background text-foreground shadow-xs",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="font-medium">{option.label}</span> — {option.description}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              </div>
            </TooltipProvider>
          ) : (
            <span className="text-sm text-muted-foreground">
              {PERMISSION_OPTIONS.find((option) => option.value === value)?.label}
            </span>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => setTestOpen(true)}>
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            {l10n("local.test_532eaabd")}</Button>
        </div>
      </div>
      <ActionTestDialog
        connectionId={connectionId}
        appName={appName}
        entry={action}
        open={testOpen}
        onOpenChange={setTestOpen}
      />
    </>
  );
}

function actionPermission(
  id: string,
  enabledIds: Set<string>,
  askFirstIds: Set<string>,
): ActionPermission {
  if (!enabledIds.has(id)) return "off";
  return askFirstIds.has(id) ? "ask" : "allowed";
}
