import { l10n } from "../i18n";
import {
  Inbox,
  ListChecks,
  CircleCheck,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Layers,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  Unplug,
  MessagesSquare,
  GanttChartSquare,
  LayoutGrid,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { SidebarAgentChats } from "./SidebarAgentChats";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { attentionBadgeCount } from "../lib/attention";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { primarySidebarStyles } from "./primary-sidebar-styles";

export function Sidebar({ children }: { children?: ReactNode }) {
  const { openNewIssue } = useDialogActions();
  const { enabled: agentChatEnabled } = useAgentChatEnabled();
  // Every labeled section is collapsible (session-scoped, default open) —
  // one policy across static nav groups and the data-driven sections.
  const [workOpen, setWorkOpen] = useState(true);
  const [organizationOpen, setOrganizationOpen] = useState(true);
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627) + reconnect reconcile — no
    // interval poll needed. Polling here also re-armed React Query's timer on
    // every live-event cache write, a major source of steady-state churn.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const liveRunCount = liveRuns?.length ?? 0;
  const liveIssueIds = new Set(
    (liveRuns ?? []).flatMap((run) => run.issueId ? [run.issueId] : []),
  );
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  const showStatusCards = experimentalSettings?.enableStatusCards === true;
  const goalsLinkPending = experimentalSettings === undefined;
  const showGoalsLink = experimentalSettings?.enableGoalsSidebarLink === true;
  // Decisions (attention home) is an experimental surface (PAP-13481): the nav
  // item is hidden entirely until the flag is enabled (same no-flash pattern as
  // showWorkspacesLink — it defaults hidden, so no placeholder is needed).
  const showDecisions = experimentalSettings?.enableDecisions === true;
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && showDecisions,
    refetchInterval: 60_000,
  });
  const attentionCount = attentionBadgeCount(attentionFeed);
  const showCases = experimentalSettings?.enableCases === true;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside
      className={cn(
        "w-full h-full min-h-0 flex flex-col",
        streamlinedUiEnabled
          ? primarySidebarStyles.surface
          : "border-r border-border bg-background",
      )}
    >
      {/* Top bar: company name, aligned with top sections and borderless.
          Search deliberately does NOT live here:
          the header's spare width goes to the workspace/organization name,
          which is the user's orientation anchor and truncates otherwise.
          Search is the first nav item below instead. */}
      <div className="flex h-(--sz-60px) shrink-0 items-center gap-1 px-3">
        <SidebarCompanyMenu />
      </div>

      <nav className={primarySidebarStyles.nav}>
        <div className={primarySidebarStyles.group}>
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? l10n("local.new_task_718e58cc") : undefined}
                className={cn(
                  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{l10n("local.new_task_718e58cc")}</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">{l10n("local.new_task_718e58cc")}</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          {/* Search moved out of the header so the workspace name keeps the
              width; a nav row also keeps search reachable from the
              collapsed rail, where the old header icon was dropped entirely.
              Cmd/Ctrl+K remains the keyboard path (command palette). */}
          <SidebarNavItem to="/search" label={l10n("local.search_49c266ba")} icon={Search} />
          <SidebarNavItem to="/dashboard" label={l10n("local.dashboard_67b69646")} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={l10n("local.inbox_94835ea2")}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel={l10n("local.unread_2cc1c371")}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {showDecisions ? (
            <SidebarNavItem
              to="/decisions"
              label={l10n("local.decisions_cfa6a08a")}
              icon={ListChecks}
              badge={attentionCount}
              badgeLabel={l10n("local.decisions_3183d37b")}
            />
          ) : null}
          {showStatusCards ? (
            <SidebarNavItem to="/status" label={l10n("local.status_920e413c")} icon={LayoutGrid} textBadge="beta" />
          ) : null}
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label={l10n("local.conference_room_fb9623fb")} icon={MessagesSquare} />
          ) : null}
        </div>

        <SidebarSection label={l10n("local.work_104ab921")} collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
          <SidebarNavItem to="/issues" label={l10n("local.tasks_b3a60e61")} icon={CircleCheck} />
          {streamlinedUiEnabled ? (
            <>
              <SidebarNavItem to="/projects" label={l10n("local.projects_04e2a972")} icon={FolderOpen} />
              <SidebarStarredProjects />
            </>
          ) : null}
          <SidebarNavItem to="/routines" label={l10n("local.routines_61b7bb44")} icon={Repeat} />
          <SidebarNavItem to="/artifacts" label={l10n("local.artifacts_314ae71b")} icon={Package} />
          {showCases ? (
            <SidebarNavItem to="/cases" label={l10n("local.cases_2249bd50")} icon={Layers} textBadge="beta" />
          ) : null}
          {showPipelines ? (
            <SidebarNavItem to="/pipelines" label={l10n("local.pipelines_d1a8fffe")} icon={GitBranch} />
          ) : null}
          {showGoalsLink ? (
            <SidebarNavItem to="/goals" label={l10n("local.goals_116cd398")} icon={Target} />
          ) : goalsLinkPending ? (
            <div
              data-testid="sidebar-goals-placeholder"
              className="h-8 pointer-coarse:h-7"
              aria-hidden="true"
            />
          ) : null}
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={l10n("local.workspaces_1377264b")} icon={GitBranch} />
          ) : null}
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </SidebarSection>

        {streamlinedUiEnabled ? (
          <SidebarSection
            label={l10n("local.org_b1ee7e97")}
            collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
          >
            <SidebarNavItem to="/agents" label={l10n("local.agents_279b44d2")} icon={Users} />
            <SidebarNavItem to="/skills" label={l10n("local.skills_66d0f523")} icon={Boxes} />
            <SidebarNavItem to="/apps" label={l10n("local.connectors_c3d2e79e")} icon={Unplug} />
            <SidebarNavItem to="/activity" label={l10n("local.audit_bb6aea28")} icon={History} />
          </SidebarSection>
        ) : null}

        {children}
        {agentChatEnabled && !children && <SidebarAgentChats />}

        {streamlinedUiEnabled ? (
          <SidebarRecentTasks companyId={selectedCompanyId} liveIssueIds={liveIssueIds} />
        ) : (
          <>
            <SidebarProjects />
            <SidebarAgents />
            <SidebarSection
              label={l10n("local.organization_d764d425")}
              collapsible={{ open: organizationOpen, onOpenChange: setOrganizationOpen }}
            >
              <SidebarNavItem to="/org" label={l10n("local.org_b1ee7e97")} icon={Network} />
              <SidebarNavItem to="/apps" label={l10n("local.connectors_c3d2e79e")} icon={Unplug} />
              <SidebarNavItem to="/timeline" label={l10n("local.timeline_9dcff98e")} icon={GanttChartSquare} />
              <SidebarNavItem to="/costs" label={l10n("local.costs_b88fc5fc")} icon={DollarSign} />
              <SidebarNavItem to="/activity" label={l10n("local.activity_38da1505")} icon={History} />
              <SidebarNavItem to="/company/settings" label={l10n("local.settings_74a883a0")} icon={Settings} />
            </SidebarSection>
          </>
        )}

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
