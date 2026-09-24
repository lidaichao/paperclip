import { l10n } from "../i18n";
import { MediaArtifactCard } from "@/components/artifacts/MediaArtifactCard";
import { WebhookUrlWarning } from "@/components/routine-triggers/WebhookUrlWarning";
import { SetupWizardNavigation, SetupWizardFooter } from "../components/SetupWizard";
import { RemoteMcpDesignExample } from "@/features/connections/remote-mcp/RemoteMcpDesignExample";
import { AgentChatPicker } from "@/components/AgentChatPicker";
import { TaskChatProjectCreatedCard } from "@/components/task-chat/TaskChatProjectCreatedCard";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { announcementPreview, announcementAnimationPreview, announcementAnimationPreviewSrc } from "@/lib/announcement-preview";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { AiConnectionDesignExamples } from "@/components/ai-connections/AiConnectionDesignExamples";
import { SavedProviderKeySelect } from "../components/onboarding/SavedProviderKeySelect";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentCharacter } from "@/components/AgentCharacter";
import { AGENT_PALETTE_IDS, appearanceForPalette } from "@paperclipai/shared";
import { RepositoryEditor } from "@/components/RepositoryEditor";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskTreeControlDialog, TaskTreeControlMenuItems } from "@/components/TaskTreeControls";
import { useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { InlineBanner } from "@/components/InlineBanner";
import { BuiltInLifecycleChip } from "@/components/BuiltInAgentBadges";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { AgentCapsule, AGENT_GRADIENT_COUNT } from "@/components/AgentCapsule";
import { AgentRunCard } from "@/components/ActiveAgentsPanel";
import { StatusBadge, IssueStatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { ActionCard, ActionCardMobile, BindingsTable } from "@/components/actions/ActionCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { AppLogo } from "@/pages/apps/AppLogo";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { MembershipAction } from "@/components/MembershipAction";
import { IssueOutputSection } from "@/components/issue-output/IssueOutputSection";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import {
  connectedConnectionIntentInteraction,
  issueThreadInteractionFixtureMeta,
  pendingConnectionIntentInteraction,
  retryConnectionIntentInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type { CompanySecret, EnvBinding, Issue } from "@paperclipai/shared";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { IssueRow } from "@/components/IssueRow";
import {
  EnvInputsList,
  ExternalSourcesList,
  RequiredSkillsList,
  StepSkillPlan,
  StepSourcePolicy,
  TeamCard,
  TeamHierarchyPreview,
  TeamRow,
} from "@/pages/TeamCatalog";
import {
  currentInstalledState,
  onboardingTeams,
  optionalTeam,
  outOfDateInstalledState,
  sampleSkillPreparations,
  sampleTeam,
  warnTeam,
} from "@/pages/TeamCatalog.fixtures";
import type { IssueWorkProduct } from "@paperclipai/shared";

/* ------------------------------------------------------------------ */
/*  Sample data for the Issue Output surface showcase                  */
/* ------------------------------------------------------------------ */

function sampleOutput(
  id: string,
  attachmentId: string,
  contentType: string,
  filename: string,
  opts: { byteSize: number; isPrimary?: boolean; createdAt: string },
): IssueWorkProduct {
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "demo-company",
    projectId: null,
    issueId: "demo-issue",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: filename,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: Boolean(opts.isPrimary),
    healthStatus: "unknown",
    summary: null,
    createdByRunId: null,
    createdAt: new Date(opts.createdAt),
    updatedAt: new Date(opts.createdAt),
    metadata: {
      attachmentId,
      contentType,
      byteSize: opts.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: filename,
    },
  } as IssueWorkProduct;
}

const DESIGN_GUIDE_OUTPUTS: IssueWorkProduct[] = [
  sampleOutput("wp-vid", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "video/mp4", "q3-summary.mp4", {
    byteSize: 19_293_798,
    isPrimary: true,
    createdAt: "2026-05-30T12:00:00Z",
  }),
  sampleOutput("wp-pdf", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "application/pdf", "talking-points.pdf", {
    byteSize: 421_888,
    createdAt: "2026-05-30T11:52:00Z",
  }),
];

const DESIGN_GUIDE_DEGRADED_OUTPUTS: IssueWorkProduct[] = [
  {
    ...sampleOutput("wp-broken", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "video/mp4", "corrupt-output.mp4", {
      byteSize: 0,
      isPrimary: true,
      createdAt: "2026-05-30T12:01:00Z",
    }),
    // Strip the path metadata so it fails the shared artifact schema.
    metadata: { attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", contentType: "video/mp4" },
  } as IssueWorkProduct,
];

const DESIGN_GUIDE_TASK = {
  id: "design-guide-task",
  identifier: "PAP-427",
  title: l10n("local.reconcile_the_navigation_model_across_operato_8172a52d"),
  status: "in_progress",
  priority: "medium",
  blockerAttention: false,
} as unknown as Issue;

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

// Onboarding seam (design §6 + §12.5): the TeamCard tile in its "Pick a starter
// team" 3-col grid, with the first defaultInstall tile selected.
function TeamCardShowcase() {
  const [selectedId, setSelectedId] = useState(onboardingTeams[0]?.id ?? null);
  return (
    <div className="grid max-w-2xl gap-4 md:grid-cols-2 lg:grid-cols-3">
      {onboardingTeams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          selected={team.id === selectedId}
          onSelect={() => setSelectedId(team.id)}
        />
      ))}
    </div>
  );
}

// Reusable environment-variables editor: one shared grid, in-field source
// switch, fuzzy secret picker, sensitive-value detection, inline health.
const DESIGN_GUIDE_SECRETS: CompanySecret[] = [
  {
    id: "dg-github",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "github_token",
    name: "GITHUB_TOKEN",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
  {
    id: "dg-db",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "db_connection",
    name: "DB_CONNECTION",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
];

function EnvironmentVariablesEditorShowcase() {
  const [env, setEnv] = useState<Record<string, EnvBinding>>({
    NODE_ENV: { type: "plain", value: "production" },
    GH_TOKEN: { type: "secret_ref", secretId: "dg-github", version: "latest" },
    DB_URL: { type: "secret_ref", secretId: "dg-db", version: 3 },
    STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
  });
  return (
    <div className="max-w-(--sz-640px) rounded-md border border-border p-4">
      <EnvironmentVariablesEditor
        value={env}
        secrets={DESIGN_GUIDE_SECRETS}
        onChange={(next) => setEnv(next ?? {})}
        onCreateSecret={async (name) => ({
          ...DESIGN_GUIDE_SECRETS[0]!,
          id: `dg-${name}`,
          key: name,
          name: name.toUpperCase(),
          latestVersion: 1,
        })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

function TaskExecutionControlsExample() {
  const [running, setRunning] = useState(true);
  const [dialogMode, setDialogMode] = useState<"resume" | "cancel" | "restore" | null>(null);
  const [wake, setWake] = useState(true);
  return <div className="max-w-xl space-y-4">
    <div className="w-52 rounded-md border border-border p-1">
      <TaskTreeControlMenuItems scope="subtree" canPause={running} canResume={!running} canCancel canRestore={!running}
        onPause={() => setRunning(false)} onResume={() => setDialogMode("resume")}
        onCancel={() => setDialogMode("cancel")} onRestore={() => setDialogMode("restore")} />
    </div>
    <p className="text-sm text-muted-foreground">{running ? l10n("local.running_type_to_switch_stop_to_send_bd880c32") : l10n("local.paused_resume_from_the_menu_43c034ff")}</p>
    <TaskChatProjectCreatedCard item={{ id: "design-project", kind: "project_created", projectId: "example-project", name: "Onboarding improvements", description: l10n("local.help_new_teams_reach_their_first_useful_resul_dc595637"), timestamp: "2026-09-11T00:00:00Z", repositories: [{ id: "1", name: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip" }] }} />
    {!running ? <TaskChatMarker item={{ id: "design-cancelled", kind: "marker", variant: "interrupted", tone: "neutral", label: l10n("local.run_cancelled_2d34c9f1"), detail: "The run was cancelled before returning an answer.", collapsible: true }} /> : null}
    <TaskChatComposer pause={!running ? { scope: "subtree", onResume: () => setDialogMode("resume") } : null} onAdd={async () => {}} workMode="standard" stopScope="subtree" onStop={running ? async () => setRunning(false) : undefined} />
    <TaskTreeControlDialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) setDialogMode(null); }}
      mode={dialogMode ?? "cancel"} scope="subtree" affectedCount={3} affectedAgentCount={2} loading={false} pending={false} valid
      wakeAgents={wake} onWakeAgentsChange={setWake} onRetry={() => {}}
      onApply={() => { setRunning(dialogMode !== "cancel" && wake); setDialogMode(null); }} />
  </div>;
}

function AgentChatPickerExample() {
  const [state, setState] = useState<"closed" | "empty" | "loading" | "error">("closed");
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" onClick={() => setState("empty")}>{l10n("local.empty_picker_ee2e925e")}</Button>
    <Button variant="outline" onClick={() => setState("loading")}>{l10n("local.loading_picker_e7a00dc8")}</Button>
    <Button variant="outline" onClick={() => setState("error")}>{l10n("local.failed_picker_7c4d2b07")}</Button>
    <AgentChatPicker agents={[]} open={state !== "closed"} onOpenChange={(open) => { if (!open) setState("closed"); }} onSelect={() => {}}
      loading={state === "loading"} error={state === "error" ? new Error("Unavailable") : null} onRetry={() => setState("empty")} />
  </div>;
}

export function DesignGuide() {
  const [wizardStep, setWizardStep] = useState(0);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState("Click to edit this text");
  const [inlineTitle, setInlineTitle] = useState("Editable Title");
  const [inlineDesc, setInlineDesc] = useState(
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift."
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: "Status", value: "Active" },
    // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
    ...(SHOW_TASK_PRIORITY_UI
      ? [{ key: "priority", label: "Priority", value: "High" } as FilterValue]
      : []),
  ]);
  const [allowExternal, setAllowExternal] = useState(false);
  const [allowUnpinned, setAllowUnpinned] = useState(false);
  const [allowLocalPath, setAllowLocalPath] = useState(false);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{l10n("local.design_guide_fb859467")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {l10n("local.every_component_style_and_pattern_used_across_11b92d42")}</p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={l10n("local.component_coverage_0ce7e43e")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.this_page_should_be_updated_when_new_ui_primi_87a2a492")}</p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={l10n("local.ui_primitives_8d9de12f")}>
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "resizable-panels",
                "scroll-area", "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title={l10n("local.app_components_3513abbd")}>
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette", "EnvironmentVariablesEditor",
                "InlineBanner", "BuiltInAgentGate", "BuiltInLifecycleChip", "CollectionToolbar",
                "IssueRow", "ContextualSidebarFrame",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      <Section title={l10n("local.announcements_fe02680f")}>
        <div className="grid gap-4 md:grid-cols-2">
          <AnnouncementCard announcement={announcementAnimationPreview} imageSrc="/announcement-preview.svg" animationSrc={announcementAnimationPreviewSrc} onDismiss={() => {}} />
          <AnnouncementCard announcement={announcementPreview} imageSrc="/announcement-preview.svg" onDismiss={() => {}} />
          <AnnouncementCard announcement={{ ...announcementPreview, image: undefined, secondaryLink: undefined }} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title={l10n("local.task_execution_controls_c914f18d")}>
        <TaskExecutionControlsExample />
      </Section>

      <Section title={l10n("local.task_collection_dad69542")}>
        <p className="max-w-prose text-sm text-muted-foreground">
          {l10n("local.collectiontoolbar_owns_shared_geometry_while_0c62113c")}</p>
        <CollectionToolbar
          context={<span className="text-sm font-medium">{l10n("local.recent_tasks_7b940d84")}</span>}
          search={<Input aria-label={l10n("local.search_task_collection_example_386bdeb6")} placeholder={l10n("local.search_tasks_c1af8370")} />}
          controls={<Button variant="outline" size="sm">{l10n("local.filter_638e249f")}</Button>}
          actions={<Button size="sm">{l10n("local.new_task_3e992276")}</Button>}
          feedback={<span className="text-xs text-muted-foreground">{l10n("local.1_task_updated_newest_first_2d381e3e")}</span>}
        />
        <div className="overflow-hidden rounded-lg border border-border">
          <IssueRow
            issue={DESIGN_GUIDE_TASK}
            presentation="task"
            unreadState="visible"
            metadata={<span className="text-xs text-muted-foreground">{l10n("local.updated_12m_ago_6991a5b7")}</span>}
            actions={<Button variant="ghost" size="xs">{l10n("local.more_d47d7cb0")}</Button>}
          />
        </div>
      </Section>

      <Section title={l10n("local.theme_toggle_cafbda6a")}>
        <SubSection title={l10n("local.variants_63d2643b")}>
          <div className="flex max-w-sm flex-col items-start gap-3">
            <ThemeToggle />
            <ThemeToggle variant="menu-action" />
            <ThemeToggle variant="compact-menu-action" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title={l10n("local.colors_88c45d9e")}>
        <SubSection title={l10n("local.core_70ea1983")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Background" cssVar="--background" />
            <Swatch name="Foreground" cssVar="--foreground" />
            <Swatch name="Card" cssVar="--card" />
            <Swatch name="Primary" cssVar="--primary" />
            <Swatch name="Primary foreground" cssVar="--primary-foreground" />
            <Swatch name="Secondary" cssVar="--secondary" />
            <Swatch name="Muted" cssVar="--muted" />
            <Swatch name="Muted foreground" cssVar="--muted-foreground" />
            <Swatch name="Accent" cssVar="--accent" />
            <Swatch name="Destructive" cssVar="--destructive" />
            <Swatch name="Border" cssVar="--border" />
            <Swatch name="Ring" cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.sidebar_f7efa7bc")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.chart_3e5b90ae")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Chart 1" cssVar="--chart-1" />
            <Swatch name="Chart 2" cssVar="--chart-2" />
            <Swatch name="Chart 3" cssVar="--chart-3" />
            <Swatch name="Chart 4" cssVar="--chart-4" />
            <Swatch name="Chart 5" cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={l10n("local.runner_activity_4da41ca2")}>
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-activity", kind: "activity_phase", active: true, summary: "", interstitial: { id: "design-runner-commentary", kind: "message", author: "agent", text: "I’ll inspect the activity feed and check the layout.", interstitial: true }, items: [
          { id: "design-runner-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Found the activity groups." },
          { id: "design-runner-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "in_progress" },
        ] }} />
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-completed", kind: "activity_phase", active: false, summary: "", items: [
          { id: "design-completed-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Read the activity groups." },
          { id: "design-completed-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "failed", detail: "A token check needs another pass." },
        ] }} />
      </Section>

      <Section title={l10n("local.typography_cab94aba")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{l10n("local.page_title_text_xl_font_bold_330ad43b")}</h2>
          <h2 className="text-lg font-semibold">{l10n("local.section_title_text_lg_font_semibold_7ea638dc")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {l10n("local.section_heading_text_sm_font_semibold_upperca_42b0aa57")}</h3>
          <p className="text-sm font-medium">{l10n("local.card_title_text_sm_font_medium_3791e01e")}</p>
          <p className="text-sm font-semibold">{l10n("local.card_title_alt_text_sm_font_semibold_893bc7d7")}</p>
          <p className="text-sm">{l10n("local.body_text_text_sm_dd4663cc")}</p>
          <p className="text-sm text-muted-foreground">
            {l10n("local.muted_description_text_sm_text_muted_foregrou_258b5dff")}</p>
          <p className="text-xs text-muted-foreground">
            {l10n("local.tiny_label_text_xs_text_muted_foreground_96b05260")}</p>
          <p className="text-sm font-mono text-muted-foreground">
            {l10n("local.mono_identifier_text_sm_font_mono_text_muted_49119cee")}</p>
          <p className="text-2xl font-bold">{l10n("local.large_stat_text_2xl_font_bold_056eb9dd")}</p>
          <p className="font-mono text-xs">{l10n("local.log_code_text_font_mono_text_xs_92c7b7d0")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={l10n("local.radius_6fe0661c")}>
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={l10n("local.buttons_d452583a")}>
        <SubSection title={l10n("local.variants_63d2643b")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{l10n("local.default_21b111cb")}</Button>
            <Button variant="secondary">{l10n("local.secondary_62f2ccff")}</Button>
            <Button variant="outline">{l10n("local.outline_eabbf3ab")}</Button>
            <Button variant="ghost">{l10n("local.ghost_df1bc498")}</Button>
            <Button variant="destructive">{l10n("local.destructive_c3e58a73")}</Button>
            <Button variant="link">{l10n("local.link_a6a32dbc")}</Button>
          </div>
        </SubSection>

        <SubSection title={l10n("local.sizes_74a3978d")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{l10n("local.extra_small_c7b3e438")}</Button>
            <Button size="sm">{l10n("local.small_5263293f")}</Button>
            <Button size="default">{l10n("local.default_21b111cb")}</Button>
            <Button size="lg">{l10n("local.large_ab80540d")}</Button>
          </div>
        </SubSection>

        <SubSection title={l10n("local.icon_buttons_19cccce8")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={l10n("local.with_icons_1f71f4bc")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {l10n("local.new_issue_03a81df6")}</Button>
            <Button variant="outline"><Upload /> {l10n("local.upload_865e89de")}</Button>
            <Button variant="destructive"><Trash2 /> {l10n("local.delete_e2d0a549")}</Button>
            <Button size="sm"><Plus /> {l10n("local.add_9fd728c6")}</Button>
          </div>
        </SubSection>

        <SubSection title={l10n("local.states_2f6e9dae")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{l10n("local.disabled_75081b59")}</Button>
            <Button variant="outline" disabled>{l10n("local.disabled_outline_bbf6b43d")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={l10n("local.badges_185d8ef0")}>
        <SubSection title={l10n("local.variants_63d2643b")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{l10n("local.default_21b111cb")}</Badge>
            <Badge variant="secondary">{l10n("local.secondary_62f2ccff")}</Badge>
            <Badge variant="outline">{l10n("local.outline_eabbf3ab")}</Badge>
            <Badge variant="destructive">{l10n("local.destructive_c3e58a73")}</Badge>
            <Badge variant="ghost">{l10n("local.ghost_df1bc498")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={l10n("local.status_system_4805331b")}>
        <SubSection title={l10n("local.statusbadge_all_statuses_7640ba1e")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={l10n("local.issuestatusbadge_brand_chip_glyph_pap_75_4f561819")}>
          <div className="flex items-center gap-2 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].map(
              (s) => (
                <IssueStatusBadge key={s} status={s} />
              )
            )}
          </div>
        </SubSection>

        <SubSection title={l10n("local.idle_slack_conversation_ed0009c9")}>
          <StatusIcon status="in_review" externalConversationState="waiting" showLabel />
          <IssueStatusBadge status="in_review" externalConversationState="waiting" />
        </SubSection>
        <SubSection title={l10n("local.statusicon_interactive_f24d0f6d")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{l10n("local.click_the_icon_to_change_status_current_3d9abd80")}{" "}{status})</span>
          </div>
        </SubSection>

        {/* PAP-411: PriorityIcon showcase gated behind SHOW_TASK_PRIORITY_UI per board decision. */}
        {SHOW_TASK_PRIORITY_UI && (
        <SubSection title={l10n("local.priorityicon_interactive_7effddf5")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{l10n("local.click_the_icon_to_change_current_0e723f2d")}{" "}{priority})</span>
          </div>
        </SubSection>
        )}

        <SubSection title={l10n("local.agent_status_dots_5c9ee51c")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={l10n("local.run_invocation_badges_2b04ef6c")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <Badge variant="ghost" key={label} className={`px-1.5 text-(length:--text-nano) ${cls}`}>
                {label}
              </Badge>
            ))}
          </div>
        </SubSection>

        <SubSection title="IssueReferencePill">
          <p className="text-xs text-muted-foreground">
            {l10n("local.used_wherever_a_task_is_referenced_in_markdow_a894001f")}{" "}<code className="font-mono">status</code> {l10n("local.to_show_the_target_issue_apos_s_state_at_a_gl_29be970d")}{" "}<code className="font-mono">variant="property"</code> {l10n("local.for_compact_badges_with_direct_navigation_pas_9831dbd5")}{" "}<code className="font-mono">onRemove</code> {l10n("local.for_a_separate_blocker_removal_control_with_r_2366c373")}{" "}<code className="font-mono">strikethrough</code> {l10n("local.for_quot_removed_quot_contexts_db359c32")}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <IssueReferencePill issue={{ id: "demo-1", identifier: "PAP-123", title: l10n("local.identifier_only_no_status_yet_ceaa35d0") }} />
            <IssueReferencePill issue={{ id: "demo-2", identifier: "PAP-456", title: l10n("local.with_in_progress_status_b0a7b6df"), status: "in_progress" }} />
            <IssueReferencePill issue={{ id: "demo-3", identifier: "PAP-789", title: l10n("local.done_status_a2c1d162"), status: "done" }} />
            <IssueReferencePill issue={{ id: "demo-4", identifier: "PAP-101", title: l10n("local.blocked_status_31b37cb6"), status: "blocked" }} />
            <IssueReferencePill onRemove={() => window.alert("Blocker removed")} issue={{ id: "demo-blocker", identifier: "PAP-303", title: l10n("local.hover_or_focus_to_remove_blocker_7407b822"), status: "in_review" }} />
            <IssueReferencePill strikethrough issue={{ id: "demo-5", identifier: "PAP-202", title: l10n("local.removed_strikethrough_009f6b18"), status: "todo" }} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  AGENT CAPSULE                                                */}
      {/* ============================================================ */}
      <Section title={l10n("local.agent_capsule_4588fb04")}>
        <p className="text-sm text-muted-foreground max-w-prose">
          {l10n("local.the_brand_quot_capsule_is_the_agent_quot_moti_d3888c57")}<code className="font-mono">--agent-Na</code> →{" "}
          <code className="font-mono">--agent-Nb</code>); <code className="font-mono">prefers-reduced-motion</code>{" "}
          {l10n("local.skips_the_liquid_rise_and_pulses_and_renders_f11dad5c")}</p>
        <SubSection title={l10n("local.states_2f6e9dae")}>
          <div className="flex items-end gap-10">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="slot" />
              <span className="text-xs text-muted-foreground">{l10n("local.slot_65588383")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="configured" />
              <span className="text-xs text-muted-foreground">{l10n("local.configured_20158224")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} />
              <span className="text-xs text-muted-foreground">{l10n("local.online_f6fc84c9")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} glow="blue" />
              <span className="text-xs text-muted-foreground">{l10n("local.online_blue_glow_4d1505f2")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={l10n("local.sizes_74a3978d")}>
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="sm" gradient={1} />
              <span className="text-xs text-muted-foreground">sm</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="md" gradient={4} />
              <span className="text-xs text-muted-foreground">md</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="lg" gradient={8} />
              <span className="text-xs text-muted-foreground">lg</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size={{ width: 28, height: 96 }} gradient={6} />
              <span className="text-xs text-muted-foreground">{l10n("local.custom_px_a051fd34")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={l10n("local.gradients_ab64614f")}>
          <div className="flex items-end gap-3 flex-wrap">
            {Array.from({ length: AGENT_GRADIENT_COUNT }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <AgentCapsule state="online" size="sm" gradient={i + 1} />
                <span className="text-(length:--text-nano) font-mono text-muted-foreground">{i + 1}</span>
              </div>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={l10n("local.form_elements_87340ea4")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={l10n("local.input_36ecb4f8")}>
            <Input placeholder={l10n("local.default_input_6364c7ae")} />
            <Input placeholder={l10n("local.disabled_input_4ba876c7")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={l10n("local.textarea_467065a1")}>
            <Textarea placeholder={l10n("local.write_something_ff2fd355")} />
          </SubSection>

          <SubSection title={l10n("local.checkbox_label_cdc3eb59")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{l10n("local.checked_item_81085a7f")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{l10n("local.unchecked_item_0b21710e")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{l10n("local.disabled_item_40b3f9be")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={l10n("local.inline_editor_3485cc64")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{l10n("local.title_single_line_03d397b7")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{l10n("local.body_text_single_line_fc872109")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{l10n("local.description_multiline_auto_sizing_5926a0e4")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={l10n("local.add_a_description_eed0f05b")}
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title={l10n("local.select_2a78025d")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={l10n("local.default_size_5cbce0f8")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={l10n("local.select_status_f4d3c2a2")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{l10n("local.backlog_bf986e9a")}</SelectItem>
                <SelectItem value="todo">{l10n("local.todo_4ff402d7")}</SelectItem>
                <SelectItem value="in_progress">{l10n("local.in_progress_b4cc4b07")}</SelectItem>
                <SelectItem value="in_review">{l10n("local.in_review_2677214a")}</SelectItem>
                <SelectItem value="done">{l10n("local.done_11a6767d")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{l10n("local.current_value_00fca59b")}{" "}{selectValue}</p>
          </SubSection>
          <SubSection title={l10n("local.small_trigger_bf7c6628")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{l10n("local.critical_427dd296")}</SelectItem>
                <SelectItem value="high">{l10n("local.high_c4ebc6d4")}</SelectItem>
                <SelectItem value="medium">{l10n("local.medium_8e588cd1")}</SelectItem>
                <SelectItem value="low">{l10n("local.low_f793de20")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={l10n("local.dropdown_menu_d5c53c63")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {l10n("local.quick_actions_2cc2b6f7")}<ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {l10n("local.mark_as_done_62aa4b87")}<DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {l10n("local.open_docs_76deaf7d")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {l10n("local.watch_issue_3e773f12")}</DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {l10n("local.delete_issue_085be85d")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={l10n("local.popover_064f6ac1")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{l10n("local.open_popover_6d22c4c6")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{l10n("local.agent_heartbeat_ed550be0")}</p>
            <p className="text-xs text-muted-foreground">
              {l10n("local.last_run_succeeded_24s_ago_next_timer_run_in_d3a181a1")}</p>
            <Button size="xs">{l10n("local.wake_now_b14d667b")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={l10n("local.collapsible_d4a5d5f8")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? l10n("local.hide_ac20a57b") : l10n("local.show_0df6f1ca")} {l10n("local.advanced_filters_ed8c87fe")}</Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{l10n("local.owner_4b1b8aa3")}</Label>
              <Input id="owner-filter" placeholder={l10n("local.filter_by_agent_name_0f60d859")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={l10n("local.sheet_54bf0ebb")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{l10n("local.open_side_panel_6451992b")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{l10n("local.issue_properties_851c1082")}</SheetTitle>
              <SheetDescription>{l10n("local.edit_metadata_without_leaving_the_current_pag_16dc84b3")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{l10n("local.title_7e8cd205")}</Label>
                <Input id="sheet-title" defaultValue="Improve onboarding docs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{l10n("local.description_526e0087")}</Label>
                <Textarea id="sheet-description" defaultValue="Capture setup pitfalls and screenshots." />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{l10n("local.cancel_19766ed6")}</Button>
              <Button>{l10n("local.save_1509f561")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={l10n("local.scroll_area_9b26d240")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {l10n("local.heartbeat_run_3cce5263")}{i + 1}{l10n("local._completed_successfully_40f23c15")}</div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={l10n("local.command_cmdk_b42efd2f")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={l10n("local.type_a_command_or_search_14d048ec")} />
            <CommandList>
              <CommandEmpty>{l10n("local.no_results_found_7ecdbfee")}</CommandEmpty>
              <CommandGroup heading="Pages">
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {l10n("local.dashboard_67b69646")}</CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {l10n("local.issues_666067dd")}</CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {l10n("local.open_command_palette_c022b19a")}</CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {l10n("local.create_new_issue_f27a451c")}</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={l10n("local.breadcrumb_2bd873d6")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{l10n("local.projects_04e2a972")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{l10n("local.paperclip_app_a2afee2c")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{l10n("local.issue_list_b8a227c7")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={l10n("local.cards_a52fcbbc")}>
        <SubSection title={l10n("local.dashboard_agent_runs_0aaef703")}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {["running", "queued", "succeeded", "failed", "timed_out", "cancelled", "interrupted"].map((status) => (
              <AgentRunCard
                key={status}
                companyId="design-guide"
                run={{
                  id: `design-guide-${status}`, agentId: "design-guide-agent", agentName: "CodexCoder",
                  status, adapterType: "codex_local", invocationSource: "on_demand", triggerDetail: "manual",
                  startedAt: null, finishedAt: null, createdAt: "2026-09-11T12:00:00Z", issueId: "design-guide-task",
                }}
                issue={{ identifier: "PAP-559", title: l10n("local.recreate_this_wireframe_on_pages_paperclip_d70afc1d"), status: status === "succeeded" ? "done" : "in_progress" }}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{l10n("local.the_dashboard_and_live_runs_page_use_the_same_27b8dd39")}</p>
        </SubSection>
        <SubSection title={l10n("local.standard_card_e0086453")}>
          <Card>
            <CardHeader>
              <CardTitle>{l10n("local.card_title_1441a295")}</CardTitle>
              <CardDescription>{l10n("local.card_description_with_supporting_text_d94e320e")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{l10n("local.card_content_goes_here_this_is_the_main_body_86e31a71")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{l10n("local.action_64cff131")}</Button>
              <Button variant="outline" size="sm">{l10n("local.cancel_19766ed6")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={l10n("local.metric_cards_b0916fef")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={l10n("local.active_agents_86622a87")} description={l10n("local._3_this_week_6f7320b6")} />
            <MetricCard icon={CircleDot} value={48} label={l10n("local.open_issues_4e2912a7")} />
            <MetricCard icon={DollarSign} value="$1,234" label={l10n("local.monthly_cost_7294a203")} description={l10n("local.under_budget_fffd7412")} />
            <MetricCard icon={Zap} value="99.9%" label={l10n("local.uptime_d63ab471")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={l10n("local.tabs_8e5ea509")}>
        <SubSection title={l10n("local.default_pill_variant_ec1cb396")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{l10n("local.overview_d4b1ea57")}</TabsTrigger>
              <TabsTrigger value="runs">{l10n("local.runs_848f54e8")}</TabsTrigger>
              <TabsTrigger value="config">{l10n("local.config_87e89abb")}</TabsTrigger>
              <TabsTrigger value="costs">{l10n("local.costs_b88fc5fc")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.overview_tab_content_b2cef641")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.runs_tab_content_6ca368f4")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.config_tab_content_64f6f1ee")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.costs_tab_content_f1e79d4d")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={l10n("local.line_variant_aa513964")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{l10n("local.summary_8e76a94a")}</TabsTrigger>
              <TabsTrigger value="details">{l10n("local.details_45989de4")}</TabsTrigger>
              <TabsTrigger value="comments">{l10n("local.comments_355f79f2")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.summary_content_with_underline_tabs_ba0d2125")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.details_content_255afa72")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{l10n("local.comments_content_e0def86b")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={l10n("local.entity_rows_6d199ef5")}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                {/* PAP-411: PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="high" />}
              </>
            }
            identifier="PAP-001"
            title={l10n("local.implement_authentication_flow_8b4c3fed")}
            subtitle={l10n("local.responsible_agent_alpha_00fdc444")}
            trailing={<IssueStatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="medium" />}
              </>
            }
            identifier="PAP-002"
            title={l10n("local.set_up_ci_cd_pipeline_bbae4496")}
            subtitle={l10n("local.completed_2_days_ago_2b00e1ec")}
            trailing={<IssueStatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="low" />}
              </>
            }
            identifier="PAP-003"
            title={l10n("local.write_api_documentation_7ffde9f0")}
            trailing={<IssueStatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="critical" />}
              </>
            }
            identifier="PAP-004"
            title={l10n("local.deploy_to_production_edc8c3dc")}
            subtitle={l10n("local.blocked_by_pap_001_c8d7dcd8")}
            trailing={<IssueStatusBadge status="blocked" />}
            selected
          />
        </div>
        <SubSection title={l10n("local.membership_action_3ac5eb84")}>
          <div className="border border-border rounded-md">
            <EntityRow
              title={l10n("local.joined_resource_33c4f605")}
              subtitle={l10n("local.hover_or_focus_the_row_to_reveal_the_reserved_232477a5")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  resourceName="Joined resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={l10n("local.left_resource_cdd43bd9")}
              subtitle={l10n("local.persistent_action_with_dimmed_row_content_792ff7cc")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  resourceName="Left resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={l10n("local.leaving_resource_64205cc8")}
              subtitle={l10n("local.disabled_while_the_optimistic_mutation_is_pen_1d2ed025")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  pending
                  pendingState="left"
                  resourceName="Leaving resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={l10n("local.joining_resource_6dcaccef")}
              subtitle={l10n("local.the_target_state_is_visible_immediately_while_81c33361")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  pending
                  pendingState="joined"
                  resourceName="Joining resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={l10n("local.filter_bar_75d3ce37")}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: "Status", value: "Active" },
                // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
                ...(SHOW_TASK_PRIORITY_UI
                  ? [{ key: "priority", label: "Priority", value: "High" } as FilterValue]
                  : []),
              ])
            }
          >
            {l10n("local.reset_filters_10afa984")}</Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={l10n("local.avatars_fedfdc14")}>
        <SubSection title={l10n("local.sizes_74a3978d")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={l10n("local.group_34ca0e76")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      <Section title={l10n("local.app_logos_b9810433")}>
        <SubSection title={l10n("local.official_marks_and_runtime_fallback_ebbfad89")}>
          <div className="flex items-center gap-3">
            <AppLogo
              name="Notion"
              logoUrl="/brands/apps/notion.svg"
              darkLogoUrl="/brands/apps/notion-dark.svg"
              size={36}
            />
            <AppLogo name="Jira" logoUrl="/brands/apps/jira.svg" darkLogoUrl="/brands/apps/jira-dark.svg" size={44} />
            <AppLogo name="Fallback" logoUrl="/brands/apps/does-not-exist.svg" size={36} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={l10n("local.agent_personas_0f26abe6")}>
        <SubSection title={l10n("local.stable_palette_identities_973eab1b")}>
          <div className="flex flex-wrap gap-3">{AGENT_PALETTE_IDS.map(palette => <AgentAvatar key={palette} appearance={appearanceForPalette(palette)} size={48} label={palette} />)}</div>
        </SubSection>
        <SubSection title={l10n("local.onboarding_and_live_character_af25f8ad")}>
          <p className="text-sm text-muted-foreground">{l10n("local.place_one_live_character_beside_the_agent_nam_43bf80fc")}</p>
          <div className="flex gap-4"><AgentCharacter muted state="sleepy" motion="still" size={128} /><AgentCharacter size={128} /></div>
        </SubSection>
      </Section>
      <Section title={l10n("local.human_identity_c421cb46")}>
        <SubSection title={l10n("local.sizes_74a3978d")}>
          <div className="flex items-center gap-6">
            <Identity name="Alex Morgan" size="sm" />
            <Identity name="Alex Morgan" />
            <Identity name="Alex Morgan" size="lg" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.initials_derivation_9cec7db7")}>
          <div className="flex flex-col gap-2">
            <Identity name="Casey Jordan" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quinn Lee" size="sm" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.custom_initials_dba05082")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={l10n("local.tooltips_1cfb0bd9")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{l10n("local.hover_me_1d8fb154")}</Button>
            </TooltipTrigger>
            <TooltipContent>{l10n("local.this_is_a_tooltip_cf6a28c0")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{l10n("local.settings_74a883a0")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={l10n("local.dialog_69b51517")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{l10n("local.open_dialog_7482430e")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{l10n("local.dialog_title_f40917a7")}</DialogTitle>
              <DialogDescription>
                {l10n("local.this_is_a_sample_dialog_showing_the_standard_146d0c0d")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{l10n("local.name_dcd1d522")}</Label>
                <Input placeholder={l10n("local.enter_a_name_c13b0e08")} className="mt-1.5" />
              </div>
              <div>
                <Label>{l10n("local.description_526e0087")}</Label>
                <Textarea placeholder={l10n("local.describe_682fdb6b")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{l10n("local.cancel_19766ed6")}</Button>
              <Button>{l10n("local.save_1509f561")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={l10n("local.empty_state_1a969227")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message="No items to show. Create your first one to get started."
            action="Create Item"
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={l10n("local.progress_bars_budget_2faeb28c")}>
        <div className="space-y-3">
          {[
            { label: l10n("local.under_budget_40_2867ec07"), pct: 40, color: "bg-green-400" },
            { label: l10n("local.warning_75_92ca76cb"), pct: 75, color: "bg-yellow-400" },
            { label: l10n("local.over_budget_95_afc09c08"), pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-(--tp-width-background-color) duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title={l10n("local.log_viewer_b26528cf")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  Agent started successfully</div>
          <div className="text-foreground">[12:00:02] INFO  Processing task PAP-001</div>
          <div className="text-yellow-400">[12:00:05] WARN  Rate limit approaching (80%)</div>
          <div className="text-foreground">[12:00:08] INFO  Task PAP-001 completed</div>
          <div className="text-red-400">[12:00:12] ERROR Connection timeout to upstream service</div>
          <div className="text-blue-300">[12:00:12] SYS   Retrying connection in 5s...</div>
          <div className="text-foreground">[12:00:17] INFO  Reconnected successfully</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-blue-500" />
            </span>
            <span className="text-blue-600 dark:text-blue-400">{l10n("local.live_b64ac05f")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={l10n("local.property_row_pattern_f7883e78")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{l10n("local.status_920e413c")}</span>
            <StatusBadge status="active" />
          </div>
          {/* PAP-411: priority metadata row hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">{l10n("local.priority_d60dbba0")}</span>
              <PriorityIcon priority="high" />
            </div>
          )}
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{l10n("local.responsible_bc110a6d")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">Agent Alpha</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{l10n("local.created_d70b9e24")}</span>
            <span className="text-xs">{l10n("local.jan_15_2025_618176e8")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={l10n("local.navigation_patterns_423846c4")}>
        <SubSection title={l10n("local.independent_mcp_connections_21832da2")}>
          <p className="text-sm text-muted-foreground">{l10n("local.zapier_arcade_composio_and_executor_each_own_85739bb6")}</p>
          <RemoteMcpDesignExample />
        </SubSection>
        <SubSection title={l10n("local.setup_wizard_dfcce1df")}>
          <p className="text-sm text-muted-foreground">{l10n("local.shared_by_connection_setup_and_trigger_previe_5dd973e1")}</p>
          <div className="max-w-sm space-y-6">
            <SetupWizardNavigation inline labels={["Choose trigger", "Configure", "Review"]} step={wizardStep} availableStep={2} onSelect={setWizardStep} />
            <SetupWizardFooter onSaveExit={() => setWizardStep(0)}><Button onClick={() => setWizardStep((wizardStep + 1) % 3)}>{l10n("local.continue_31fbef16")}</Button></SetupWizardFooter>
          </div>
        </SubSection>
        <SubSection title={l10n("local.agent_chat_picker_25f7f290")}>
          <AgentChatPickerExample />
        </SubSection>
        <SubSection title={l10n("local.sidebar_nav_items_51d712db")}>
          <p className="text-sm text-muted-foreground">
            {l10n("local.layout_accepts_sidebarsections_to_compose_add_8a74107f")}</p>
          <Card className="block w-60 p-3 space-y-0.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {l10n("local.dashboard_67b69646")}</div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {l10n("local.issues_666067dd")}<Badge variant="ghost" className="ml-auto bg-primary text-primary-foreground px-1.5">
                12
              </Badge>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {l10n("local.agents_279b44d2")}</div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {l10n("local.projects_04e2a972")}</div>
          </Card>
        </SubSection>

        <SubSection title={l10n("local.view_toggle_3f2f0df8")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {l10n("local.list_6f202f54")}</button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {l10n("local.org_b1ee7e97")}</button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={l10n("local.grouped_list_issues_pattern_b43e0a87")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{l10n("local.in_progress_b4cc4b07")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            {/* PAP-411: leading PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="high" /> : undefined}
              identifier="PAP-101"
              title={l10n("local.build_agent_heartbeat_system_d355e8ac")}
              onClick={() => {}}
            />
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="medium" /> : undefined}
              identifier="PAP-102"
              title={l10n("local.add_cost_tracking_dashboard_abd57cbb")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={l10n("local.comment_thread_pattern_9e84ba5b")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{l10n("local.comments_2_88e50051")}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{l10n("local.agent_11b39c93")}</span>
                <span className="text-xs text-muted-foreground">{l10n("local.jan_15_2025_618176e8")}</span>
              </div>
              <p className="text-sm">{l10n("local.started_working_on_the_authentication_module_6a5b34f3")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{l10n("local.human_9ffa865f")}</span>
                <span className="text-xs text-muted-foreground">{l10n("local.jan_16_2025_68db3dbe")}</span>
              </div>
              <p className="text-sm">{l10n("local.api_keys_have_been_added_to_the_vault_please_ad6210e9")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={l10n("local.leave_a_comment_4dff58ab")} rows={3} />
            <Button size="sm">{l10n("local.comment_44f5e3fb")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={l10n("local.cost_table_pattern_48212c43")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{l10n("local.model_5e2c614c")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{l10n("local.tokens_a039dfb9")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{l10n("local.cost_204a5eb2")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-sonnet-4-20250514</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-haiku-4-20250506</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">{l10n("local.total_c9b3c382")}</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title={l10n("local.skeletons_f6fb698c")}>
        <SubSection title={l10n("local.individual_010dd7b9")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.page_skeleton_list_39ecd32d")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={l10n("local.page_skeleton_detail_0a8ae9fd")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={l10n("local.separator_be237eda")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{l10n("local.horizontal_0abba441")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{l10n("local.left_58eb9032")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{l10n("local.right_883361d5")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      {/*  TEAM CATALOG                                                 */}
      {/* ============================================================ */}
      <Section title={l10n("local.team_catalog_d2fa1c21")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.components_from_the_team_catalog_browse_insta_52a75d10")}<code className="font-mono text-xs">/teams-catalog</code>{l10n("local._fixtures_are_shared_with_the_storybook_stori_6f383b3e")}</p>

        <SubSection title={l10n("local.teamrow_browse_list_ae39d7cf")}>
          <div className="w-(--sz-28rem) rounded-md border border-border">
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {l10n("local.bundled_1_f2ee24d4")}</div>
            <TeamRow team={sampleTeam} selected onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {l10n("local.optional_2_934c00b0")}</div>
            <TeamRow team={optionalTeam} selected={false} onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {l10n("local.installed_2_a893f422")}</div>
            <TeamRow team={sampleTeam} selected={false} onSelect={() => {}} installed={outOfDateInstalledState} />
            <TeamRow team={warnTeam} selected={false} onSelect={() => {}} installed={currentInstalledState} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.installed_teams_collapse_under_3b6c7e10")}{" "}<code className="font-mono">INSTALLED · N</code>{l10n("local._an_out_of_date_install_server_478a3388")}{" "}<code className="font-mono">originHash</code> {l10n("local._catalog_c88ce249")}{" "}<code className="font-mono">contentHash</code>{l10n("local._shows_the_amber_12619349")}{" "}<code className="font-mono">↑</code> {l10n("local.badge_pap_10256_f211f584")}</p>
        </SubSection>

        <SubSection title={l10n("local.teamcard_onboarding_grid_74466b3f")}>
          <p className="text-xs text-muted-foreground">
            {l10n("local.square_tile_for_the_onboarding_ldquo_pick_a_s_6f146044")}{" "}
            <code className="font-mono">ring-2 ring-ring</code>{l10n("local._drives_the_9441a41f")}{" "}
            <code className="font-mono">useInstallTeamCatalogEntry</code> {l10n("local.simplified_flow_5d1f6cde")}</p>
          <TeamCardShowcase />
        </SubSection>

        <SubSection title="TeamHierarchyPreview">
          <div className="max-w-md">
            <TeamHierarchyPreview team={sampleTeam} />
          </div>
        </SubSection>

        <SubSection title="RequiredSkillsList">
          <div className="max-w-xl">
            <RequiredSkillsList skills={sampleTeam.requiredSkills} />
          </div>
        </SubSection>

        <SubSection title="EnvInputsList">
          <div className="max-w-xl">
            <EnvInputsList inputs={sampleTeam.envInputs} />
          </div>
        </SubSection>

        <SubSection title="ExternalSourcesList">
          <div className="max-w-xl">
            <ExternalSourcesList sources={sampleTeam.sourceRefs} />
          </div>
        </SubSection>

        <SubSection title={l10n("local.source_policy_step_stepsourcepolicy_3c591dbb")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSourcePolicy
              team={warnTeam}
              allowExternalSources={allowExternal}
              allowUnpinnedOptionalSources={allowUnpinned}
              allowLocalPathSources={allowLocalPath}
              onChange={(key, value) => {
                if (key === "external") setAllowExternal(value);
                if (key === "unpinned") setAllowUnpinned(value);
                if (key === "localPath") setAllowLocalPath(value);
              }}
            />
          </div>
        </SubSection>

        <SubSection title={l10n("local.skill_plan_step_stepskillplan_29edcbc5")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSkillPlan team={sampleTeam} preparations={sampleSkillPreparations} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      <Section title={l10n("local.common_icons_lucide_fcdd09a5")}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-(length:--text-nano) text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title={l10n("local.keyboard_shortcuts_59cdaa26")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Issue (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],

            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>

      <Section title={l10n("local.issue_output_surface_3ae7b4b1")}>
        <SubSection title={l10n("local.multiple_outputs_primary_video_also_produced_0cf1290b")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_OUTPUTS} />
        </SubSection>
        <SubSection title={l10n("local.degraded_output_invalid_failed_attachment_met_21e53992")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_DEGRADED_OUTPUTS} />
        </SubSection>
        <SubSection title={l10n("local.empty_state_b725568f")}>
          <p className="text-xs text-muted-foreground">
            {l10n("local.when_an_issue_has_produced_no_artifact_work_p_384376dc")}</p>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLS & ACCESS (PAP-10389)                                   */}
      {/* ============================================================ */}
      <Section title={l10n("local.tools_access_168341ff")}>
        <SubSection title={l10n("local.enforcementbanner_default_denied_detected_4957fe67")}>
          <div className="space-y-3">
            <EnforcementBanner companyId="" forceVariant="default" recentDenialCount={0} />
            <EnforcementBanner companyId="" forceVariant="denied-detected" recentDenialCount={3} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.persistent_at_the_top_of_the_tools_amp_access_26e4de31")}{" "}<code>denied-detected</code> {l10n("local.when_governed_tool_calls_were_denied_or_faile_a3295a61")}</p>
        </SubSection>

        <SubSection title={l10n("local.enforcementbanner_presentational_tones_info_w_ecfa53bb")}>
          <div className="space-y-3">
            <EnforcementBanner
              tone="info"
              title={l10n("local.effective_access_server_resolved_62affc02")}
              body={l10n("local.this_is_exactly_what_the_tool_gateway_will_ac_f7e93aef")}
            />
            <EnforcementBanner
              tone="warning"
              title={l10n("local.local_stdio_is_local_code_execution_not_a_sec_ec72dcff")}
              body={l10n("local.a_local_stdio_slot_runs_with_the_orchestrator_c73d339a")}
            />
            <EnforcementBanner
              tone="error"
              title={l10n("local.runtime_failed_closed_182c306e")}
              body={l10n("local.the_supervisor_is_restarting_attempt_2_3_the_3210e848")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.static_governance_copy_with_a_tone_used_for_t_d373da6e")}{" "}<code>title</code>/<code>body</code> {l10n("local.and_an_optional_2cb9f9d5")}{" "}
            <code>icon</code>.
          </p>
        </SubSection>

        <SubSection title={l10n("local.action_approval_card_pending_stale_surfaces_1_f3f8dba9")}>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionCard
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉", unfurl_links: false }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel={l10n("local.expires_in_23h_51m_88e51d2f")}
            />
            <ActionCard
              variant="stale"
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7a4b1b2b0b822cd15d6c15b0f00a0e3f1",
                previousCatalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉", unfurl_links: false }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel={l10n("local.expires_in_18h_02m_e165b7a2")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.signed_payload_sha256_expiry_surface_on_every_61178a82")}{" "}
            <code>stale</code> {l10n("local.variant_tints_the_border_amber_banners_the_ca_7be742c8")}{" "}<code>Approve</code> {l10n("local.disabled_until_the_request_is_re_issued_e7b48ce9")}</p>
        </SubSection>

        <SubSection title={l10n("local.action_approval_card_mobile_390_844_surface_9_22124d87")}>
          <div className="w-(--sz-390px) max-w-full rounded-xl border border-border bg-background p-3">
            <ActionCardMobile
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉" }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel={l10n("local.expires_in_23h_51m_88e51d2f")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.identical_content_the_three_buttons_stack_ful_1c31ca4a")}</p>
        </SubSection>

        <SubSection title={l10n("local.bindingstable_reused_in_the_audit_row_drilldo_412f4ae6")}>
          <BindingsTable
            rows={[
              { label: l10n("local.application_e7ad522e"), value: "Slack · manifest v2.4.1" },
              { label: l10n("local.connection_639a40e8"), value: "https://slack.com/api · acme-workspace", mono: true },
              { label: l10n("local.catalog_3877d148"), value: "sha256:9f86d081…f00a08", mono: true },
              { label: l10n("local.payload_99733344"), value: "sha256:2c26b46b…66e7ae", mono: true },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.two_column_key_value_block_with_mono_values_l_9ec51167")}{" "}<code>ActionCard</code> {l10n("local.and_is_reused_standalone_in_the_audit_row_dri_e36d3979")}</p>
        </SubSection>

        <SubSection title={l10n("local.tool_access_status_keys_statusbadge_6c64d2c4")}>
          <div className="flex flex-wrap items-center gap-2">
            {[
              "allowed", "denied", "block", "require-approval", "redacted", "rate-limit",
              "deferred", "hidden", "quarantined", "healthy", "degraded", "runtime-error", "unchecked",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {l10n("local.policy_decisions_connection_runtime_health_an_85d9e724")}{" "}
            <code>StatusBadge</code> {l10n("local.keys_defined_in_e8c92062")}{" "}<code>lib/status-colors</code>.
          </p>
        </SubSection>

        <SubSection title={l10n("local.emptystate_canonical_with_description_action_b3132a7e")}>
          <EmptyState
            icon={Inbox}
            message="No connections yet"
            description={l10n("local.add_a_connection_to_an_application_to_configu_99930f06")}
            action="New connection"
            onAction={() => {}}
          />
        </SubSection>
      </Section>

      <Section title={l10n("local.source_repositories_e0eeae29")}>
        <SubSection title={l10n("local.empty_and_disconnected_bbc2c7c5")}>
          <RepositoryEditor selected={[]} onChange={() => {}} state="disconnected" onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <SubSection title={l10n("local.selected_and_searchable_8cc1dc4e")}>
          <RepositoryEditor selected={[{ id: "1", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: ["Your GitHub"] }]}
            available={[{ id: "2", fullName: "paperclipai/docs", url: "https://github.com/paperclipai/docs", connections: ["Company GitHub"] }]}
            onChange={() => {}} onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <p className="text-sm text-muted-foreground">{l10n("local.loading_errors_empty_search_mobile_and_short_32c00075")}</p>
      </Section>

      <Section title={l10n("local.environment_variables_editor_069e0a97")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.reusable_env_var_editor_agents_projects_envir_dd3b335b")}{" "}<span className="font-mono">{l10n("local.product_environment_variables_editor_732eaa27")}</span> {l10n("local.stories_for_all_10_states_927481cf")}</p>
        <EnvironmentVariablesEditorShowcase />
      </Section>

      <Section title={l10n("local.tasks_created_from_a_task_74fdf581")}>
        <SubSection title={l10n("local.subtasks_and_created_work_are_independent_7ba2ef08")}>
          <div className="max-w-xl">
            <TaskDetailTasksPanel
              subtasks={[DESIGN_GUIDE_TASK]}
              createdTasks={[
                { ...DESIGN_GUIDE_TASK, projectId: "design-board", project: { id: "design-board", name: "Board UI" } as Issue["project"] },
                { ...DESIGN_GUIDE_TASK, id: "design-followup", identifier: "PAP-428", title: l10n("local.write_release_notes_36392fa8"), status: "todo", projectId: null },
              ]}
              projects={[]}
            />
          </div>
        </SubSection>
        <SubSection title={l10n("local.empty_loading_and_failed_a89ee796")}>
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} isLoading />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} hasError onRetry={() => {}} />
        </SubSection>
      </Section>

      <Section title={l10n("local.execution_recovery_ce899bed")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.recovery_runs_in_the_background_task_lists_ke_64269568")}</p>
      </Section>

      <Section title={l10n("local.saved_provider_api_keys_90ca1568")}>
        <SavedProviderKeySelect options={[{ id: "example", label: l10n("local.claude_api_key_your_key_fa51d00e"), binding: { type: "user_secret_ref", key: "ANTHROPIC_API_KEY", version: "latest" } }]} value="example" onChange={() => {}} loading={false} error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading={false} error />
      </Section>

      <Section title={l10n("local.connection_intent_7a2a4540")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.the_task_card_is_the_dialog_host_for_the_shar_2b14d8c3")}</p>
        <div className="grid gap-4 xl:grid-cols-3">
          <IssueThreadInteractionCard
            interaction={pendingConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={retryConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={connectedConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
        </div>
      </Section>

      <Section title={l10n("local.resizable_panels_4f98ed37")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.design_system_wrapper_over_5ed9fd82")}{" "}<span className="font-mono">react-resizable-panels</span>{" "}
          {l10n("local._skill_studio_d2_drag_a_handle_to_resize_pane_ee21b74e")}<span className="font-mono">minSize="240px"</span>{l10n("local._constraints_and_the_middle_panel_is_collapsi_d13d6b64")}</p>
        <div className="h-48 max-w-2xl overflow-hidden rounded-md border border-border">
          <ResizablePanelGroup>
            <ResizablePanel id="a" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {l10n("local.panel_a_e1010dcd")}</div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="b" minSize="120px" collapsible collapsedSize="40px" className="bg-muted/10">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {l10n("local.panel_b_collapsible_9e3c09a5")}</div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="c" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {l10n("local.panel_c_8a631860")}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  INLINE BANNER + BUILT-IN AGENTS                              */}
      {/* ============================================================ */}
      <Section title={l10n("local.webhook_url_warnings_dd8bebbb")}>
        <div className="space-y-3">
          {["http://localhost:3100", "https://paperclip.internal", "https://paperclip.example-tailnet.ts.net", "http://paperclip.example.com", "not-a-url"].map((url) => <WebhookUrlWarning key={url} url={url} />)}
        </div>
      </Section>

      <Section title={l10n("local.inline_banner_15aba1d3")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.token_backed_full_width_notice_d293a201")}<span className="font-mono">brandBanner</span> {l10n("local.tones_use_eb738c46")}{" "}
          <span className="font-mono">{l10n("local.info_06271baf")}</span> {l10n("local.for_provenance_context_and_04246ff9")}{" "}
          <span className="font-mono">{l10n("local.warning_4bd9354b")}</span> {l10n("local.for_paused_attention_supports_an_optional_bol_08c70433")}{" "}
          <span className="font-mono">bg-yellow-*</span>/<span className="font-mono">bg-blue-*</span>{" "}
          {l10n("local.banners_20f31d31")}</p>
        <div className="space-y-3">
          <InlineBanner
            tone="info"
            title={l10n("local.built_in_agent_4bdd2857")}
            actions={<Button variant="outline" size="sm">{l10n("local.reset_to_defaults_e240e635")}</Button>}
          >
            {l10n("local.ships_with_paperclip_and_powers_f7a276fa")}{" "}<strong>{l10n("local.briefs_997b201d")}</strong>{l10n("local._it_can_be_paused_but_not_deleted_07b1fed8")}</InlineBanner>
          <InlineBanner
            tone="warning"
            title={l10n("local.briefs_is_paused_2cea4b8c")}
            actions={
              <>
                <Button variant="ghost" size="sm">{l10n("local.view_agent_7ce7832e")}</Button>
                <Button size="sm">{l10n("local.resume_agent_0bb60c45")}</Button>
              </>
            }
          >
            {l10n("local.its_built_in_agent_was_paused_2_days_ago_so_n_1deb8dee")}</InlineBanner>
          <InlineBanner
            tone="danger"
            title={l10n("local.summary_generation_failed_6a0cb00a")}
            actions={<Button size="sm">{l10n("local.retry_942087cc")}</Button>}
          >
            {l10n("local.the_linked_issue_reached_a_terminal_state_bef_ad3323b1")}</InlineBanner>
          <InlineBanner tone="info" compact>
            {l10n("local.compact_variant_for_embedding_inside_dialogs_aa514eb4")}</InlineBanner>
        </div>
      </Section>

      <Section title={l10n("local.media_artifacts_d7a87fbd")}>
        <p className="text-sm text-muted-foreground">{l10n("local.images_and_videos_use_gallery_tiles_the_whole_22e9e022")}</p>
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <MediaArtifactCard id="design-image" title={l10n("local.launch_artwork_c361304e")} contentPath="/announcement-preview.svg" contentType="image/svg+xml" originalFilename="launch.svg" detail={l10n("local.image_1aa4cb0b")} />
          <MediaArtifactCard id="design-video" title={l10n("local.video_preview_unavailable_ba6b8bcc")} contentPath="" contentType="video/mp4" originalFilename="preview.mp4" detail={l10n("local.video_d534be82")} />
        </div>
      </Section>

      <Section title={l10n("local.ai_connections_7d808727")}>
        <AiConnectionDesignExamples />
      </Section>

      <Section title={l10n("local.built_in_agent_lifecycle_chips_c6dd7903")}>
        <p className="text-sm text-muted-foreground">
          {l10n("local.a_derived_lifecycle_chip_amber_for_attention_d3769aca")}{" "}
          <span className="font-mono">needs_setup</span> / <span className="font-mono">pending_approval</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <BuiltInLifecycleChip status="needs_setup" />
          <BuiltInLifecycleChip status="pending_approval" />
          <BuiltInLifecycleChip status="needs_setup" compact />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          <span className="font-mono">&lt;BuiltInAgentGate agentKey&gt;</span> {l10n("local.composes_52c3473e")}{" "}
          <span className="font-mono">PageSkeleton</span> + <span className="font-mono">EmptyState</span>{" "}
          + <span className="font-mono">InlineBanner</span> {l10n("local.to_render_the_loading_setup_pending_approval_0cf5cdf2")}</p>
      </Section>
    </div>
  );
}
