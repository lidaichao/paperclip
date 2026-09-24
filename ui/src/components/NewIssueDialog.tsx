import { l10n } from "../i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { AgentAvatar } from "@/components/AgentAvatar";
import { normalizeLegacyRunnerProvider } from "@paperclipai/adapter-utils";
import { memo, useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type CSSProperties, type DragEvent, type RefObject } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentEnvConfig, EnvBinding, IssueWorkMode } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { MissingUserSecretsBanner } from "../pages/secrets/MissingUserSecretsBanner";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { buildCompanyUserInlineOptions, buildMarkdownMentionOptions, isAgentTaskTarget } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { orderReusableExecutionWorkspaces } from "../lib/reusable-execution-workspaces";
import {
  defaultExecutionWorkspaceModeForProject,
  defaultProjectWorkspaceIdForProject,
  issueExecutionWorkspaceModeForExistingWorkspace,
} from "../lib/project-workspace-defaults";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { recordRecentTask } from "../lib/recent-tasks";
import { buildExecutionPolicy } from "../lib/issue-execution-policy";
import { isIssueWorkMode, nextWorkMode, workModeMetaFor, workModeMetaList } from "../lib/work-mode-meta";
import { useToastActions } from "../context/ToastContext";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  Check,
  CircleDot,
  Minus,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Tag,
  Calendar,
  Paperclip,
  FileText,
  Flag,
  PauseCircle,
  Loader2,
  ListTree,
  X,
  Eye,
  ShieldAlert,
  ShieldCheck,
  ScanEye,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/utils";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { InlineBanner } from "./InlineBanner";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { getTrustPreset } from "../lib/trust-policy-ui";
import { ReusableExecutionWorkspaceSelect } from "./ReusableExecutionWorkspaceSelect";
import { codexReasoningEffortOptions } from "../lib/codex-reasoning-effort";

const DRAFT_KEY = "paperclip:issue-draft";
const DEBOUNCE_MS = 800;

type VisualViewportLayout = {
  height: number;
  offsetTop: number;
  constrained: boolean;
};

type NewIssueDialogViewportStyle = CSSProperties & {
  "--new-issue-visual-viewport-height"?: string;
  "--new-issue-visual-viewport-offset-top"?: string;
  "--new-issue-dialog-top"?: string;
  "--new-issue-dialog-height"?: string;
};

function readVisualViewportLayout(): VisualViewportLayout | null {
  if (typeof window === "undefined" || !window.visualViewport) return null;
  const { height, offsetTop } = window.visualViewport;
  return {
    height,
    offsetTop,
    constrained: height < window.innerHeight,
  };
}

function useVisualViewportLayout(enabled: boolean) {
  const [layout, setLayout] = useState<VisualViewportLayout | null>(() =>
    enabled ? readVisualViewportLayout() : null,
  );

  useEffect(() => {
    if (!enabled) {
      setLayout(null);
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateLayout = () => setLayout(readVisualViewportLayout());
    updateLayout();
    viewport.addEventListener("resize", updateLayout);
    viewport.addEventListener("scroll", updateLayout);
    window.addEventListener("resize", updateLayout);
    return () => {
      viewport.removeEventListener("resize", updateLayout);
      viewport.removeEventListener("scroll", updateLayout);
      window.removeEventListener("resize", updateLayout);
    };
  }, [enabled]);

  return layout;
}

interface IssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeValue: string;
  reviewerValue: string;
  approverValue: string;
  watchdogAgentId?: string;
  watchdogInstructions?: string;
  assigneeId?: string;
  projectId: string;
  projectWorkspaceId?: string;
  assigneeModelLane?: IssueModelLane;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  executionWorkspaceMode?: string;
  selectedExecutionWorkspaceId?: string;
  useIsolatedExecutionWorkspace?: boolean;
  workMode?: IssueWorkMode;
}

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

import { Badge } from "@/components/ui/badge";
import {
  buildAssigneeAdapterOverrides,
  ISSUE_OVERRIDE_ADAPTER_TYPES,
  type IssueModelLane,
} from "../lib/issue-assignee-overrides";

const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: l10n("local.default_21b111cb") },
    { value: "low", label: l10n("local.low_f793de20") },
    { value: "medium", label: l10n("local.medium_8e588cd1") },
    { value: "high", label: l10n("local.high_c4ebc6d4") },
  ],
  opencode_local: [
    { value: "", label: l10n("local.default_21b111cb") },
    { value: "minimal", label: l10n("local.minimal_057b5de4") },
    { value: "low", label: l10n("local.low_f793de20") },
    { value: "medium", label: l10n("local.medium_8e588cd1") },
    { value: "high", label: l10n("local.high_c4ebc6d4") },
    { value: "xhigh", label: l10n("local.x_high_393d3e4b") },
    { value: "max", label: l10n("local.max_a1a5936d") },
  ],
} as const;

function loadDraft(): IssueDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IssueDraft;
  } catch {
    return null;
  }
}

function saveDraft(draft: IssueDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedIssueFile[]) {
  const existingKeys = new Set(
    stagedFiles
      .filter((file) => file.kind === "document")
      .map((file) => file.documentKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (!existingKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildStatusOptions(): ReadonlyArray<{ value: string; label: string; color: string; description?: string }> {
  const palette = issueStatusText;
  return [
    {
      value: "backlog",
      label: l10n("local.backlog_bf986e9a"),
      color: palette.backlog ?? issueStatusTextDefault,
      description: l10n("local.parked_assignee_will_not_be_woken_0a17f3a3"),
    },
    {
      value: "todo",
      label: l10n("local.todo_4ff402d7"),
      color: palette.todo ?? issueStatusTextDefault,
      description: l10n("local.executable_assignee_will_be_woken_ffa5f594"),
    },
    { value: "in_progress", label: l10n("local.in_progress_b4cc4b07"), color: palette.in_progress ?? issueStatusTextDefault },
    { value: "in_review", label: l10n("local.in_review_2677214a"), color: palette.in_review ?? issueStatusTextDefault },
    { value: "done", label: l10n("local.done_11a6767d"), color: palette.done ?? issueStatusTextDefault },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequiredUserSecretBinding(value: unknown): value is Extract<EnvBinding, { type: "user_secret_ref" }> {
  return isRecord(value)
    && value.type === "user_secret_ref"
    && typeof value.key === "string"
    && value.key.trim().length > 0
    && value.required !== false
    && value.allowMissingOverride !== true;
}

function collectRequiredUserSecretKeysFromEnv(env: AgentEnvConfig | Record<string, unknown> | null | undefined): string[] {
  if (!isRecord(env)) return [];
  return Object.values(env).flatMap((binding) =>
    isRequiredUserSecretBinding(binding) ? [binding.key.trim()] : [],
  );
}

function uniqueRequiredUserSecretKeys(inputs: Array<AgentEnvConfig | Record<string, unknown> | null | undefined>): string[] {
  return [...new Set(inputs.flatMap(collectRequiredUserSecretKeysFromEnv))];
}

function shouldWarnAboutRunUserSecrets(status: string, assigneeAgentId: string | null | undefined) {
  return Boolean(assigneeAgentId) && (status === "todo" || status === "in_progress");
}

const priorities = [
  { value: "critical", label: l10n("local.critical_427dd296"), icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: l10n("local.high_c4ebc6d4"), icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: l10n("local.medium_8e588cd1"), icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: l10n("local.low_f793de20"), icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];

const EXECUTION_WORKSPACE_MODES = [
  { value: "shared_workspace", label: l10n("local.project_default_e8cb80e5") },
  { value: "isolated_workspace", label: l10n("local.new_isolated_workspace_0c67029f") },
  { value: "reuse_existing", label: l10n("local.reuse_existing_workspace_c84ba2b6") },
] as const;

function defaultExecutionWorkspaceModeForIssueDefaults(
  defaults: {
    executionWorkspaceId?: unknown;
    executionWorkspaceMode?: unknown;
  },
  project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined,
) {
  if (typeof defaults.executionWorkspaceId === "string" && defaults.executionWorkspaceId.length > 0) {
    return "reuse_existing";
  }
  return typeof defaults.executionWorkspaceMode === "string" && defaults.executionWorkspaceMode.length > 0
    ? defaults.executionWorkspaceMode
    : defaultExecutionWorkspaceModeForProject(project);
}

function isWorkModePeriodShortcut(e: Pick<React.KeyboardEvent, "code" | "ctrlKey" | "key" | "metaKey">) {
  const isPeriod = e.code === "Period" || e.key === ".";
  return (e.metaKey || e.ctrlKey) && isPeriod;
}

function isWorkModeEscapeShortcut(e: Pick<KeyboardEvent, "key" | "metaKey">) {
  return e.metaKey && e.key === "Escape";
}

const IssueTitleTextarea = memo(function IssueTitleTextarea({
  value,
  pending,
  assigneeValue,
  projectId,
  descriptionEditorRef,
  assigneeSelectorRef,
  projectSelectorRef,
  onChange,
}: {
  value: string;
  pending: boolean;
  assigneeValue: string;
  projectId: string;
  descriptionEditorRef: RefObject<MarkdownEditorRef | null>;
  assigneeSelectorRef: RefObject<HTMLButtonElement | null>;
  projectSelectorRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <textarea
      className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
      placeholder={l10n("local.task_title_11622e0f")}
      rows={1}
      value={draftValue}
      onChange={(e) => {
        const nextValue = e.target.value;
        setDraftValue(nextValue);
        onChange(nextValue);
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      readOnly={pending}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault();
          descriptionEditorRef.current?.focus();
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          if (assigneeValue) {
            if (projectId) {
              descriptionEditorRef.current?.focus();
            } else {
              projectSelectorRef.current?.focus();
            }
          } else {
            assigneeSelectorRef.current?.focus();
          }
        }
      }}
      autoFocus
    />
  );
});

const IssueDescriptionEditor = memo(function IssueDescriptionEditor({
  value,
  expanded,
  mentions,
  descriptionEditorRef,
  imageUploadHandler,
  onChange,
}: {
  value: string;
  expanded: boolean;
  mentions: MentionOption[];
  descriptionEditorRef: RefObject<MarkdownEditorRef | null>;
  imageUploadHandler: (file: File) => Promise<string>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <MarkdownEditor
      ref={descriptionEditorRef}
      value={draftValue}
      onChange={(nextValue) => {
        setDraftValue(nextValue);
        onChange(nextValue);
      }}
      placeholder={l10n("local.add_description_94123522")}
      bordered={false}
      mentions={mentions}
      contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)")}
      imageUploadHandler={imageUploadHandler}
    />
  );
});

export function NewIssueDialog() {
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const visualViewportLayout = useVisualViewportLayout(newIssueOpen);
  const dialogBodyRef = useRef<HTMLDivElement>(null);
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const workModeOptions = useMemo(() => workModeMetaList(), []);
  const statuses = useMemo(() => buildStatusOptions(), []);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const titleRef = useRef("");
  const descriptionRef = useRef("");
  const [titleHasText, setTitleHasText] = useState(false);
  const [draftHasText, setDraftHasText] = useState(false);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [reviewerValue, setReviewerValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [showReviewerRow, setShowReviewerRow] = useState(false);
  const [showApproverRow, setShowApproverRow] = useState(false);
  const [watchdogAgentId, setWatchdogAgentId] = useState("");
  const [watchdogInstructions, setWatchdogInstructions] = useState("");
  const [showWatchdogRow, setShowWatchdogRow] = useState(false);
  const [watchdogEditorOpen, setWatchdogEditorOpen] = useState(false);
  const [participantMenuOpen, setParticipantMenuOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelLane, setAssigneeModelLane] = useState<IssueModelLane>("primary");
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [executionWorkspaceMode, setExecutionWorkspaceMode] = useState<string>("shared_workspace");
  const [selectedExecutionWorkspaceId, setSelectedExecutionWorkspaceId] = useState("");
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionWorkspaceDefaultProjectId = useRef<string | null>(null);
  const initializationKeyRef = useRef<string | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;
  const isSubIssueMode = Boolean(newIssueDefaults.parentId);
  const parentIssueLabel = newIssueDefaults.parentIdentifier
    ?? (newIssueDefaults.parentId ? newIssueDefaults.parentId.slice(0, 8) : "");
  const parentExecutionWorkspaceId = newIssueDefaults.executionWorkspaceId ?? "";
  const parentExecutionWorkspaceLabel = newIssueDefaults.parentExecutionWorkspaceLabel ?? parentExecutionWorkspaceId;

  // Popover states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [workModeOpen, setWorkModeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const stageFileInputRef = useRef<HTMLInputElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const {
    data: reusableExecutionWorkspaces,
    isLoading: reusableExecutionWorkspacesLoading,
    isError: reusableExecutionWorkspacesError,
  } = useQuery({
    queryKey: queryKeys.executionWorkspaces.summaryList(effectiveCompanyId!, {
      projectId,
      projectWorkspaceId: projectWorkspaceId || undefined,
      reuseEligible: true,
    }),
    queryFn: () =>
      executionWorkspacesApi.listSummaries(effectiveCompanyId!, {
        projectId,
        projectWorkspaceId: projectWorkspaceId || undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && Boolean(projectId) && workspaceIsolationControlsVisible,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(effectiveCompanyId!),
    queryFn: () => accessApi.listUserDirectory(effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: newIssueOpen,
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const activeProjects = useMemo(
    () => projects ?? [],
    [projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });

  const selectedAssignee = useMemo(() => parseAssigneeValue(assigneeValue), [assigneeValue]);
  const selectedAssigneeAgentId = selectedAssignee.assigneeAgentId;
  const selectedAssigneeUserId = selectedAssignee.assigneeUserId;

  const selectedAssigneeAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId) ?? null,
    [agents, selectedAssigneeAgentId],
  );
  const assigneeAdapterType = selectedAssigneeAgent?.adapterType ?? null;
  const assigneePrimaryModel = isRecord(selectedAssigneeAgent?.adapterConfig)
    && typeof selectedAssigneeAgent.adapterConfig.model === "string"
    ? selectedAssigneeAgent.adapterConfig.model
    : "";
  const effectiveAssigneeModel = assigneeModelOverride || assigneePrimaryModel;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, orderedProjects]);

  const catalogProvider = assigneeAdapterType === "paperclip_runner" ? String(normalizeLegacyRunnerProvider(selectedAssigneeAgent?.adapterConfig ?? {}).provider ?? "codex") : undefined;
  const { data: assigneeAdapterModels } = useQuery({
    queryKey:
      effectiveCompanyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(effectiveCompanyId, assigneeAdapterType, null, catalogProvider)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(effectiveCompanyId!, assigneeAdapterType!, { provider: catalogProvider }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && supportsAssigneeOverrides,
  });

  const createIssue = useMutation({
    mutationFn: async ({
      companyId,
      stagedFiles: pendingStagedFiles,
      ...data
    }: { companyId: string; stagedFiles: StagedIssueFile[] } & Record<string, unknown>) => {
      const issue = await issuesApi.create(companyId, data);
      const failures: string[] = [];

      for (const stagedFile of pendingStagedFiles) {
        try {
          if (stagedFile.kind === "document") {
            const body = await stagedFile.file.text();
            await issuesApi.upsertDocument(issue.id, stagedFile.documentKey ?? "document", {
              title: stagedFile.documentKey === "plan" ? null : stagedFile.title ?? null,
              format: "markdown",
              body,
              baseRevisionId: null,
            });
          } else {
            await issuesApi.uploadAttachment(companyId, issue.id, stagedFile.file);
          }
        } catch {
          failures.push(stagedFile.file.name);
        }
      }

      return { issue, companyId, failures };
    },
    onSuccess: ({ issue, companyId, failures }) => {
      if (streamlinedUiEnabled) recordRecentTask(issue, currentUserId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (failures.length > 0) {
        const prefix = (companies.find((company) => company.id === companyId)?.issuePrefix ?? "").trim();
        const issueRef = issue.identifier ?? issue.id;
        pushToast({
          title: l10n("local.created_value_with_upload_warnings_0ea4aa99", {v0: (issueRef)}),
          body: l10n("local.value_staged_value_could_not_be_added_2bd8f0dd", {v0: (failures.length), v1: (failures.length === 1 ? "file" : "files")}),
          tone: "warn",
          action: prefix
            ? { label: l10n("local.open_value_afaef5c3", {v0: (issueRef)}), href: `/${prefix}/issues/${issueRef}` }
            : undefined,
        });
      }
      clearDraft();
      reset();
      closeNewIssue();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });
  const uploadDescriptionImageHandler = useCallback(async (file: File) => {
    const asset = await uploadDescriptionImage.mutateAsync(file);
    return asset.contentPath;
  }, [uploadDescriptionImage.mutateAsync]);

  // Debounced draft saving
  const scheduleSave = useCallback(
    (draft: IssueDraft) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (draft.title.trim()) saveDraft(draft);
      }, DEBOUNCE_MS);
    },
    [],
  );

  const setIssueText = useCallback((nextTitle: string, nextDescription: string) => {
    titleRef.current = nextTitle;
    descriptionRef.current = nextDescription;
    setTitle(nextTitle);
    setDescription(nextDescription);
    setTitleHasText(nextTitle.trim().length > 0);
    setDraftHasText(nextTitle.trim().length > 0 || nextDescription.trim().length > 0);
  }, []);

  const queueDraftSave = useCallback((overrides: { title?: string; description?: string } = {}) => {
    if (!newIssueOpen) return;
    const nextTitle = overrides.title ?? titleRef.current;
    const nextDescription = overrides.description ?? descriptionRef.current;
    scheduleSave({
      title: nextTitle,
      description: nextDescription,
      status,
      priority,
      assigneeValue,
      reviewerValue,
      approverValue,
      watchdogAgentId,
      watchdogInstructions,
      projectId,
      projectWorkspaceId,
      assigneeModelLane,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      executionWorkspaceMode,
      selectedExecutionWorkspaceId,
      workMode,
    });
  }, [
    newIssueOpen,
    scheduleSave,
    status,
    priority,
    assigneeValue,
    reviewerValue,
    approverValue,
    watchdogAgentId,
    watchdogInstructions,
    projectId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
    workMode,
  ]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    titleRef.current = nextTitle;
    const nextTitleHasText = nextTitle.trim().length > 0;
    const nextDraftHasText = nextTitleHasText || descriptionRef.current.trim().length > 0;
    setTitleHasText((current) => current === nextTitleHasText ? current : nextTitleHasText);
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ title: nextTitle });
  }, [queueDraftSave]);

  const handleDescriptionChange = useCallback((nextDescription: string) => {
    descriptionRef.current = nextDescription;
    const nextDraftHasText = titleRef.current.trim().length > 0 || nextDescription.trim().length > 0;
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ description: nextDescription });
  }, [queueDraftSave]);

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    queueDraftSave();
  }, [
    status,
    priority,
    assigneeValue,
    reviewerValue,
    approverValue,
    watchdogAgentId,
    watchdogInstructions,
    projectId,
    projectWorkspaceId,
    assigneeModelLane,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
    workMode,
    newIssueOpen,
    queueDraftSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) {
      initializationKeyRef.current = null;
      return;
    }
    const initializationKey = `${selectedCompanyId ?? ""}:${JSON.stringify(newIssueDefaults)}`;
    if (initializationKeyRef.current === initializationKey) return;
    initializationKeyRef.current = initializationKey;
    setDialogCompanyId(selectedCompanyId);
    executionWorkspaceDefaultProjectId.current = null;

    const draft = loadDraft();
    if (newIssueDefaults.parentId) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      const defaultProjectWorkspaceId = newIssueDefaults.projectWorkspaceId
        ?? defaultProjectWorkspaceIdForProject(defaultProject);
      const defaultExecutionWorkspaceMode = defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, defaultProject);
      setIssueText(newIssueDefaults.title ?? "", newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceId);
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelLane("primary");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceMode);
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = hasExplicitProjectWorkspaceId || defaultProject
        ? defaultProjectId || null
        : null;
    } else if (newIssueDefaults.title) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      setIssueText(newIssueDefaults.title, newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newIssueDefaults.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setWatchdogAgentId("");
      setWatchdogInstructions("");
      setShowWatchdogRow(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, defaultProject));
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = hasExplicitProjectWorkspaceId || newIssueDefaults.executionWorkspaceId || defaultProject
        ? defaultProjectId || null
        : null;
    } else if (draft && draft.title.trim()) {
      const nextWorkMode = isIssueWorkMode(draft.workMode) ? draft.workMode : "standard";
      const restoredProjectId = newIssueDefaults.projectId ?? draft.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      const hasExplicitExecutionWorkspaceId = newIssueDefaults.executionWorkspaceId !== undefined;
      const hasExplicitExecutionWorkspaceMode = newIssueDefaults.executionWorkspaceMode !== undefined;
      setIssueText(draft.title, draft.description);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId || newIssueDefaults.assigneeUserId
          ? assigneeValueFromSelection(newIssueDefaults)
          : (draft.assigneeValue ?? draft.assigneeId ?? ""),
      );
      setReviewerValue(draft.reviewerValue ?? "");
      setApproverValue(draft.approverValue ?? "");
      setShowReviewerRow(!!(draft.reviewerValue));
      setShowApproverRow(!!(draft.approverValue));
      setWatchdogAgentId(draft.watchdogAgentId ?? "");
      setWatchdogInstructions(draft.watchdogInstructions ?? "");
      setShowWatchdogRow(!!(draft.watchdogAgentId));
      setProjectId(restoredProjectId);
      setProjectWorkspaceId(
        hasExplicitProjectWorkspaceId
          ? (newIssueDefaults.projectWorkspaceId ?? "")
          : (draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject)),
      );
      setAssigneeModelLane(draft.assigneeModelLane ?? "primary");
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setExecutionWorkspaceMode(
        hasExplicitExecutionWorkspaceId || hasExplicitExecutionWorkspaceMode
          ? defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, restoredProject)
          : (
              draft.executionWorkspaceMode
              ?? (draft.useIsolatedExecutionWorkspace ? "isolated_workspace" : defaultExecutionWorkspaceModeForProject(restoredProject))
            ),
      );
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(
        hasExplicitExecutionWorkspaceId
          ? (newIssueDefaults.executionWorkspaceId ?? "")
          : (draft.selectedExecutionWorkspaceId ?? ""),
      );
      executionWorkspaceDefaultProjectId.current = hasExplicitProjectWorkspaceId || hasExplicitExecutionWorkspaceId || draft.projectWorkspaceId || restoredProject
        ? restoredProjectId || null
        : null;
    } else {
      setWorkMode("standard");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      setIssueText("", "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newIssueDefaults.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setWatchdogAgentId("");
      setWatchdogInstructions("");
      setShowWatchdogRow(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, defaultProject));
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = hasExplicitProjectWorkspaceId || newIssueDefaults.executionWorkspaceId || defaultProject
        ? defaultProjectId || null
        : null;
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, selectedCompanyId, setIssueText]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelLane("primary");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      return;
    }
    const validThinkingValues =
      assigneeAdapterType === "codex_local"
        ? codexReasoningEffortOptions(effectiveAssigneeModel)
        : assigneeAdapterType === "opencode_local"
          ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
          : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
    if (!validThinkingValues.some((option) => option.value === assigneeThinkingEffort)) {
      setAssigneeThinkingEffort("");
    }
  }, [
    supportsAssigneeOverrides,
    assigneeAdapterType,
    effectiveAssigneeModel,
    assigneeThinkingEffort,
  ]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setIssueText("", "");
    setStatus("todo");
    setPriority("");
    setAssigneeValue("");
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setWatchdogAgentId("");
    setWatchdogInstructions("");
    setShowWatchdogRow(false);
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelLane("primary");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExecutionWorkspaceMode("shared_workspace");
    setSelectedExecutionWorkspaceId("");
    setWorkMode("standard");
    setExpanded(false);
    setDialogCompanyId(null);
    setStagedFiles([]);
    setIsFileDragOver(false);
    setCompanyOpen(false);
    executionWorkspaceDefaultProjectId.current = null;
    initializationKeyRef.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (isSubIssueMode) return;
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeValue("");
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setWatchdogAgentId("");
    setWatchdogInstructions("");
    setShowWatchdogRow(false);
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeModelLane("primary");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExecutionWorkspaceMode("shared_workspace");
    setSelectedExecutionWorkspaceId("");
    setWorkMode("standard");
  }

  function discardDraft() {
    clearDraft();
    reset();
    closeNewIssue();
  }

  function handleSubmit() {
    const currentTitle = titleRef.current.trim();
    const currentDescription = descriptionRef.current.trim();
    if (!effectiveCompanyId || !currentTitle || createIssue.isPending) return;
    const assigneeAdapterOverrides = buildAssigneeAdapterOverrides({
      adapterType: assigneeAdapterType,
      lane: assigneeModelLane,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
    });
    const selectedProject = orderedProjects.find((project) => project.id === projectId);
    // Hidden selectors must not submit a restored draft over the managed default.
    const executionWorkspacePolicy =
      workspaceIsolationControlsVisible && experimentalSettings?.enableIsolatedWorkspaces === true
        ? selectedProject?.executionWorkspacePolicy ?? null
        : null;
    const selectedReusableExecutionWorkspace = selectableReusableWorkspaces.find(
      (workspace) => workspace.id === selectedExecutionWorkspaceId,
    );
    const requestedExecutionWorkspaceMode =
      executionWorkspaceMode === "reuse_existing"
        ? issueExecutionWorkspaceModeForExistingWorkspace(selectedReusableExecutionWorkspace?.mode)
        : executionWorkspaceMode;
    const executionWorkspaceSettings = executionWorkspacePolicy?.enabled
      ? { mode: requestedExecutionWorkspaceMode }
      : null;
    // A task launched from a workspace (or its parent task) keeps that explicit
    // context. Draft-only choices are ignored while the selector is hidden.
    const contextualWorkspaceId = !workspaceIsolationControlsVisible
      && newIssueDefaults.projectId === projectId
      ? newIssueDefaults.executionWorkspaceId
      : undefined;
    const executionPolicy = buildExecutionPolicy({
      reviewerValues: reviewerValue ? [reviewerValue] : [],
      approverValues: approverValue ? [approverValue] : [],
    });
    createIssue.mutate({
      companyId: effectiveCompanyId,
      stagedFiles,
      title: currentTitle,
      description: currentDescription || undefined,
      status,
      priority: priority || "medium",
      workMode,
      ...(selectedAssigneeAgentId ? { assigneeAgentId: selectedAssigneeAgentId } : {}),
      ...(selectedAssigneeUserId ? { assigneeUserId: selectedAssigneeUserId } : {}),
      ...(newIssueDefaults.parentId ? { parentId: newIssueDefaults.parentId } : {}),
      ...(newIssueDefaults.goalId ? { goalId: newIssueDefaults.goalId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionWorkspacePolicy?.enabled ? { executionWorkspacePreference: executionWorkspaceMode } : {}),
      ...(workspaceIsolationControlsVisible && executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId
        ? { executionWorkspaceId: selectedExecutionWorkspaceId }
        : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
      ...(contextualWorkspaceId ? { executionWorkspaceId: contextualWorkspaceId, executionWorkspacePreference: "reuse_existing" } : {}),
      ...(executionPolicy ? { executionPolicy } : {}),
      ...(watchdogAgentId
        ? { watchdog: { agentId: watchdogAgentId, instructions: watchdogInstructions.trim() || null } }
        : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (isWorkModePeriodShortcut(e)) {
      e.preventDefault();
      setWorkMode((current) => nextWorkMode(current));
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    setStagedFiles((current) => {
      const next = [...current];
      for (const file of files) {
        if (isTextDocumentFile(file)) {
          const baseName = fileBaseName(file.name);
          const documentKey = createUniqueDocumentKey(slugifyDocumentKey(baseName), next);
          next.push({
            id: `${file.name}:${file.size}:${file.lastModified}:${documentKey}`,
            file,
            kind: "document",
            documentKey,
            title: titleizeFilename(baseName),
          });
          continue;
        }
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          kind: "attachment",
        });
      }
      return next;
    });
  }

  function handleStageFilesPicked(evt: ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(evt.target.files ?? []));
    if (stageFileInputRef.current) {
      stageFileInputRef.current.value = "";
    }
  }

  function handleFileDragEnter(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    setIsFileDragOver(true);
  }

  function handleFileDragOver(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleFileDragLeave(evt: DragEvent<HTMLDivElement>) {
    if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }

  function handleFileDrop(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.files.length) return;
    evt.preventDefault();
    setIsFileDragOver(false);
    stageFiles(Array.from(evt.dataTransfer.files));
  }

  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }

  const hasDraft = draftHasText || stagedFiles.length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((a) => a.id === selectedAssigneeAgentId)
    : null;
  const currentAssigneeLowTrust = getTrustPreset(currentAssignee?.permissions) === "low_trust_review";
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const neededUserSecretKeys = useMemo(
    () => {
      if (!shouldWarnAboutRunUserSecrets(status, selectedAssigneeAgentId)) return [];
      return uniqueRequiredUserSecretKeys([
        isRecord(currentAssignee?.adapterConfig) ? currentAssignee.adapterConfig.env as Record<string, unknown> : null,
        currentProject?.env ?? null,
      ]);
    },
    [currentAssignee?.adapterConfig, currentProject?.env, selectedAssigneeAgentId, status],
  );
  const currentProjectExecutionWorkspacePolicy =
    experimentalSettings?.enableIsolatedWorkspaces === true
      ? currentProject?.executionWorkspacePolicy ?? null
      : null;
  const currentProjectSupportsExecutionWorkspace = Boolean(currentProjectExecutionWorkspacePolicy?.enabled);
  const selectableReusableWorkspaces = reusableExecutionWorkspaces ?? [];
  const selectedReusableExecutionWorkspace = selectableReusableWorkspaces.find(
    (workspace) => workspace.id === selectedExecutionWorkspaceId,
  );
  const isUsingParentExecutionWorkspace = isSubIssueMode && parentExecutionWorkspaceId
    ? executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId === parentExecutionWorkspaceId
    : false;
  const showParentWorkspaceWarning = isSubIssueMode
    && currentProjectSupportsExecutionWorkspace
    && Boolean(parentExecutionWorkspaceId)
    && !isUsingParentExecutionWorkspace;
  const assigneeOptionsTitle =
    assigneeAdapterType === "claude_local"
      ? l10n("local.claude_options_73fe8e88")
      : assigneeAdapterType === "codex_local"
        ? l10n("local.codex_options_31d56d5b")
        : assigneeAdapterType === "opencode_local"
          ? l10n("local.opencode_options_4a902fc0")
        : l10n("local.agent_options_31eb33af");
  const thinkingEffortOptions =
    assigneeAdapterType === "codex_local"
      ? codexReasoningEffortOptions(effectiveAssigneeModel)
      : assigneeAdapterType === "opencode_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
      : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const recentAssigneeOptionIds = useMemo(
    () => recentAssigneeIds.map((id) => assigneeValueFromSelection({ assigneeAgentId: id })),
    [recentAssigneeIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] }),
      ...sortAgentsByRecency(
        (agents ?? []).filter(isAgentTaskTarget),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, companyMembers?.users, currentUserId, recentAssigneeIds],
  );
  const watchdogAgentOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentAssigneeIds).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const selectedWatchdogAgent = useMemo(
    () => (watchdogAgentId ? (agents ?? []).find((agent) => agent.id === watchdogAgentId) ?? null : null),
    [agents, watchdogAgentId],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const savedDraft = useMemo(() => newIssueOpen ? loadDraft() : null, [newIssueOpen]);
  const hasSavedDraft = Boolean(savedDraft?.title.trim() || savedDraft?.description.trim());
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : l10n("local.failed_to_create_task_try_again_1c9651e0");
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback((nextProjectId: string) => {
    if (nextProjectId) trackRecentProject(nextProjectId);
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    executionWorkspaceDefaultProjectId.current = nextProjectId || null;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(nextProject));
    setSelectedExecutionWorkspaceId("");
  }, [orderedProjects]);

  useEffect(() => {
    if (
      !newIssueOpen ||
      !projectId ||
      selectedExecutionWorkspaceId ||
      executionWorkspaceDefaultProjectId.current === projectId
    ) {
      return;
    }
    const project = orderedProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    executionWorkspaceDefaultProjectId.current = projectId;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(project));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(project));
    setSelectedExecutionWorkspaceId("");
  }, [newIssueOpen, orderedProjects, projectId, selectedExecutionWorkspaceId]);
  const modelOverrideOptions = useMemo<InlineEntityOption[]>(
    () => {
      return [...(assigneeAdapterModels ?? [])]
        .sort((a, b) => {
          const providerA = extractProviderIdWithFallback(a.id);
          const providerB = extractProviderIdWithFallback(b.id);
          const byProvider = providerA.localeCompare(providerB);
          if (byProvider !== 0) return byProvider;
          return a.id.localeCompare(b.id);
        })
        .map((model) => ({
          id: model.id,
          label: model.label,
          searchText: `${model.id} ${extractProviderIdWithFallback(model.id)}`,
        }));
    },
    [assigneeAdapterModels],
  );
  const currentWorkMode = workModeMetaFor(workMode);
  const CurrentWorkModeIcon = currentWorkMode.icon;
  const dialogViewportStyle = useMemo<NewIssueDialogViewportStyle>(() => {
    const dialogGeometry = {
      "--new-issue-dialog-top":
        "calc(var(--new-issue-visual-viewport-offset-top) + var(--new-issue-dialog-top-gap))",
      "--new-issue-dialog-height":
        "calc(var(--new-issue-visual-viewport-height) - var(--new-issue-dialog-top-gap) - var(--new-issue-dialog-bottom-gap))",
    };
    if (!visualViewportLayout) return dialogGeometry;
    return {
      ...dialogGeometry,
      "--new-issue-visual-viewport-height": `${visualViewportLayout.height}px`,
      "--new-issue-visual-viewport-offset-top": `${visualViewportLayout.offsetTop}px`,
      ...(visualViewportLayout.constrained
        ? {
            top: "var(--new-issue-dialog-top)",
            height: "var(--new-issue-dialog-height)",
            translate: "var(--pct-neg-50)",
          }
        : {}),
    };
  }, [visualViewportLayout]);

  useEffect(() => {
    if (!visualViewportLayout?.constrained) return;
    const focusedElement = document.activeElement;
    if (
      !(focusedElement instanceof HTMLElement)
      || !dialogBodyRef.current?.contains(focusedElement)
      || typeof focusedElement.scrollIntoView !== "function"
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusedElement.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visualViewportLayout]);

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        style={dialogViewportStyle}
        className={cn(
          "flex h-(--new-issue-dialog-height) max-h-(--new-issue-dialog-height) flex-col gap-0 overflow-hidden p-0 sm:h-auto",
          expanded
            ? "sm:max-w-2xl sm:h-(--new-issue-dialog-height)"
            : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (event.defaultPrevented) return;
          // iOS Safari maps command-period to Escape for hardware keyboards.
          // Treat modifier-Escape as the same mode-cycle shortcut so the
          // dialog does not dismiss before the shortcut can run.
          if (isWorkModeEscapeShortcut(event)) {
            event.preventDefault();
            setWorkMode((current) => nextWorkMode(current));
            return;
          }
          if (createIssue.isPending) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
            return;
          }
          // Radix Dialog's modal DismissableLayer calls preventDefault() on
          // pointerdown events that originate outside the Dialog DOM tree.
          // Popover and editor autocomplete portals render at the body level
          // (outside the Dialog), so touch/click events on their content get
          // their default prevented. Telling Radix "this event is handled" skips
          // that preventDefault, restoring popover scroll and autocomplete taps.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper], [data-paperclip-floating-ui]")) {
            event.preventDefault();
          }
        }}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  data-slot="new-issue-compact-control"
                  className="rounded bg-muted p-1.5 text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity sm:px-1.5 sm:py-0.5"
                  disabled={isSubIssueMode}
                >
                  {dialogCompany?.issuePrefix ?? ""}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {companies.filter((c) => c.status !== "archived").map((c) => (
                  <button
                    key={c.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      c.id === effectiveCompanyId && "bg-accent",
                    )}
                    onClick={() => {
                      handleCompanyChange(c.id);
                      setCompanyOpen(false);
                    }}
                  >
                    <span className="px-1 py-0.5 rounded bg-muted text-(length:--text-nano) font-semibold leading-none">
                      {c.issuePrefix}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{isSubIssueMode ? l10n("local.new_sub_task_158c2dae") : l10n("local.new_task_3e992276")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              disabled={createIssue.isPending}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => closeNewIssue()}
              disabled={createIssue.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div ref={dialogBodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Title */}
          <div className="px-4 pt-4 pb-2">
            <IssueTitleTextarea
              value={title}
              pending={createIssue.isPending}
              assigneeValue={assigneeValue}
              projectId={projectId}
              descriptionEditorRef={descriptionEditorRef}
              assigneeSelectorRef={assigneeSelectorRef}
              projectSelectorRef={projectSelectorRef}
              onChange={handleTitleChange}
            />
          </div>

          {effectiveCompanyId ? (
            <div className="px-4 pb-2">
              {neededUserSecretKeys.length > 0 ? (
                <MissingUserSecretsBanner
                  companyId={effectiveCompanyId}
                  definitionKeys={neededUserSecretKeys}
                />
              ) : null}
            </div>
          ) : null}

          <div className="px-4 pb-2">
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
              <span className="min-w-6 shrink-0 whitespace-nowrap text-center">{l10n("local.for_ca15ebc0")}</span>
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={assigneeValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
                placeholder={l10n("local.assignee_5e20d20e")}
                className="h-8 px-2.5 py-0 sm:h-auto sm:px-2 sm:py-1"
                triggerDataSlot="new-issue-compact-control"
                disablePortal
                noneLabel={l10n("local.no_assignee_d64d8cec")}
                searchPlaceholder={l10n("local.search_assignees_ad7ec86d")}
                emptyMessage={l10n("local.no_assignees_found_0c8e6590")}
                onChange={(value) => {
                  const nextAssignee = parseAssigneeValue(value);
                  if (nextAssignee.assigneeAgentId) {
                    trackRecentAssignee(nextAssignee.assigneeAgentId);
                  }
                  setAssigneeValue(value);
                  const hasAssignee = Boolean(nextAssignee.assigneeAgentId || nextAssignee.assigneeUserId);
                  if (hasAssignee && status === "backlog") {
                    setStatus("todo");
                  }
                }}
                onConfirm={() => {
                  if (projectId) {
                    descriptionEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <>
                        <AgentAvatar agent={currentAssignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">{l10n("local.assignee_5e20d20e")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {assignee ? <AgentAvatar agent={assignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                      <span className="truncate">{option.label}</span>
                      {assignee && getTrustPreset(assignee.permissions) === "low_trust_review" ? (
                        <ShieldAlert className="ml-auto h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-label={l10n("local.low_trust_review_agent_613df605")} />
                      ) : null}
                    </>
                  );
                }}
              />
              <span>{l10n("local.in_58296753")}</span>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                recentOptionIds={recentProjectIds}
                placeholder={l10n("local.project_98595978")}
                className="h-8 px-2.5 py-0 sm:h-auto sm:px-2 sm:py-1"
                triggerDataSlot="new-issue-compact-control"
                disablePortal
                noneLabel={l10n("local.no_project_f34c2be0")}
                searchPlaceholder={l10n("local.search_projects_c59dd5a3")}
                emptyMessage={l10n("local.no_projects_found_26e92309")}
                onChange={handleProjectChange}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "var(--project-seed)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{l10n("local.project_98595978")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "var(--project-seed)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />

              {/* Three-dot menu to add Reviewer / Approver rows */}
              <Popover open={participantMenuOpen} onOpenChange={setParticipantMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent/50 transition-colors"
                    title={l10n("local.add_reviewer_approver_or_watchdog_c5ad7735")}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-44 p-1" align="start">
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showReviewerRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowReviewerRow((v) => !v);
                      if (showReviewerRow) setReviewerValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <Eye className="h-3 w-3" />
                    {l10n("local.reviewer_d29f4677")}</button>
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showApproverRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowApproverRow((v) => !v);
                      if (showApproverRow) setApproverValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {l10n("local.approver_3ebb5648")}</button>
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showWatchdogRow && "bg-accent",
                    )}
                    onClick={() => {
                      if (showWatchdogRow) {
                        setShowWatchdogRow(false);
                        setWatchdogAgentId("");
                        setWatchdogInstructions("");
                        setWatchdogEditorOpen(false);
                      } else {
                        setShowWatchdogRow(true);
                        setWatchdogEditorOpen(true);
                      }
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <ScanEye className="h-3 w-3" />
                    {l10n("local.watchdog_da0ccfea")}</button>
                </PopoverContent>
              </Popover>
              </div>
            </div>

            {/* Reviewer row */}
            {showReviewerRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><Eye className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={reviewerValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
                placeholder={l10n("local.reviewer_d29f4677")}
                disablePortal
                noneLabel={l10n("local.no_reviewer_ab68c6a8")}
                searchPlaceholder={l10n("local.search_reviewers_1cd86433")}
                emptyMessage={l10n("local.no_reviewers_found_712cb821")}
                onChange={setReviewerValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const reviewer = parseAssigneeValue(option.id).assigneeAgentId
                          ? (agents ?? []).find((a) => a.id === parseAssigneeValue(option.id).assigneeAgentId)
                          : null;
                        return reviewer ? <AgentAvatar agent={reviewer} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{l10n("local.reviewer_d29f4677")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const reviewer = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {reviewer ? <AgentAvatar agent={reviewer} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}

            {/* Approver row */}
            {showApproverRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><ShieldCheck className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={approverValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
                placeholder={l10n("local.approver_3ebb5648")}
                disablePortal
                noneLabel={l10n("local.no_approver_31322c37")}
                searchPlaceholder={l10n("local.search_approvers_14a9f989")}
                emptyMessage={l10n("local.no_approvers_found_f1a7922d")}
                onChange={setApproverValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const approver = parseAssigneeValue(option.id).assigneeAgentId
                          ? (agents ?? []).find((a) => a.id === parseAssigneeValue(option.id).assigneeAgentId)
                          : null;
                        return approver ? <AgentAvatar agent={approver} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{l10n("local.approver_3ebb5648")}</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const approver = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {approver ? <AgentAvatar agent={approver} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}

            {/* Watchdog row */}
            {showWatchdogRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><ScanEye className="h-3.5 w-3.5" /></span>
                <Popover open={watchdogEditorOpen} onOpenChange={setWatchdogEditorOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors min-w-0"
                      title={l10n("local.configure_watchdog_24ca6eff")}
                    >
                      {selectedWatchdogAgent ? (
                        <>
                          <AgentAvatar agent={selectedWatchdogAgent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                          <span className="truncate text-foreground">{selectedWatchdogAgent.name}</span>
                          {watchdogInstructions.trim() ? (
                            <span className="truncate text-muted-foreground">· {watchdogInstructions.trim()}</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">{l10n("local.set_watchdog_03d6a683")}</span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-3 space-y-3" align="start">
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-foreground">{l10n("local.watchdog_agent_c6f340c4")}</div>
                      <InlineEntitySelector
                        value={watchdogAgentId}
                        options={watchdogAgentOptions}
                        placeholder={l10n("local.select_agent_e9a702a9")}
                        noneLabel={l10n("local.no_watchdog_agent_3c2f721b")}
                        searchPlaceholder={l10n("local.search_agents_32f4468b")}
                        emptyMessage={l10n("local.no_agents_found_61666542")}
                        onChange={setWatchdogAgentId}
                        renderTriggerValue={(option) =>
                          option ? (
                            <>
                              {selectedWatchdogAgent ? (
                                <AgentAvatar agent={selectedWatchdogAgent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                              ) : null}
                              <span className="truncate">{option.label}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">{l10n("local.select_agent_e9a702a9")}</span>
                          )
                        }
                        renderOption={(option) => {
                          const agent = (agents ?? []).find((a) => a.id === option.id);
                          return (
                            <>
                              {agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                              <span className="truncate">{option.label}</span>
                            </>
                          );
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-foreground">{l10n("local.instructions_934652dc")}{" "}<span className="font-normal text-muted-foreground">{l10n("local._optional_0059798b")}</span></div>
                      <Textarea
                        value={watchdogInstructions}
                        onChange={(event) => setWatchdogInstructions(event.target.value)}
                        placeholder={l10n("local.what_should_the_watchdog_watch_for_and_how_sh_f3065c6b")}
                        rows={4}
                        className="text-xs"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => {
                          setWatchdogAgentId("");
                          setWatchdogInstructions("");
                          setShowWatchdogRow(false);
                          setWatchdogEditorOpen(false);
                        }}
                      >
                        {l10n("local.remove_c3812fc4")}</button>
                      <Button type="button" size="sm" className="h-7 text-xs" onClick={() => setWatchdogEditorOpen(false)}>
                        {l10n("local.done_11a6767d")}</Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>

          {isSubIssueMode ? (
            <div className="px-4 pb-2">
            <div className="max-w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ListTree className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0">{l10n("local.sub_task_of_e0574640")}</span>
                <span className="font-medium text-foreground">{parentIssueLabel}</span>
              </div>
              {newIssueDefaults.parentTitle ? (
                <div className="pl-5 text-foreground/80 truncate">
                  {newIssueDefaults.parentTitle}
                </div>
              ) : null}
            </div>
            </div>
          ) : null}

          {workspaceIsolationControlsVisible && currentProject && currentProjectSupportsExecutionWorkspace && (
            <div className="px-4 py-3 space-y-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium">{l10n("local.execution_workspace_d31c92b6")}</div>
              <div className="text-(length:--text-micro) text-muted-foreground">
                {l10n("local.control_whether_this_task_runs_in_the_shared_fb95aa69")}</div>
              <select
                className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
                value={executionWorkspaceMode}
                onChange={(e) => {
                  setExecutionWorkspaceMode(e.target.value);
                  if (e.target.value !== "reuse_existing") {
                    setSelectedExecutionWorkspaceId("");
                  }
                }}
              >
                {EXECUTION_WORKSPACE_MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {executionWorkspaceMode === "reuse_existing" && (
                <ReusableExecutionWorkspaceSelect
                  value={selectedExecutionWorkspaceId}
                  workspaces={selectableReusableWorkspaces}
                  onValueChange={(workspaceId) => setSelectedExecutionWorkspaceId(workspaceId)}
                  loading={reusableExecutionWorkspacesLoading}
                  error={reusableExecutionWorkspacesError}
                  disablePortal
                />
              )}
              {/*
                The label used to fall back to the workspace working directory,
                a path on the execution host. It now falls back to a neutral
                phrase, so the dialog never renders a host path.
              */}
              {executionWorkspaceMode === "reuse_existing" && selectedReusableExecutionWorkspace && (
                <div className="text-(length:--text-micro) text-muted-foreground">
                  {l10n("local.reusing_7f0f95dc")}{" "}{selectedReusableExecutionWorkspace.name} {l10n("local.from_75857a45")}{" "}{selectedReusableExecutionWorkspace.branchName ?? l10n("local.existing_execution_workspace_1f713815")}.
                </div>
              )}
              {showParentWorkspaceWarning ? (
                <div className="rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-(length:--text-micro) text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100">
                  {l10n("local.warning_this_sub_task_will_no_longer_use_the_a3b32035")}{parentExecutionWorkspaceLabel ? ` (${parentExecutionWorkspaceLabel})` : ""}.
                </div>
              ) : null}
            </div>
            </div>
          )}

          {supportsAssigneeOverrides && (
            <div className="px-4 pb-2">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAssigneeOptionsOpen((open) => !open)}
            >
              {assigneeOptionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {assigneeOptionsTitle}
            </button>
            {assigneeOptionsOpen && (
              <div className="mt-2 rounded-md border border-border p-3 bg-muted/20 space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">{l10n("local.model_lane_7cd1d36f")}</div>
                  <div
                    className="flex w-full overflow-hidden rounded-md border border-border"
                    role="radiogroup"
                    aria-label={l10n("local.model_lane_7cd1d36f")}
                  >
                    {(["primary", "custom"] as const).map((lane) => (
                      <button
                        key={lane}
                        type="button"
                        role="radio"
                        aria-checked={assigneeModelLane === lane}
                        className={cn(
                          "flex-1 px-2 py-1 text-xs capitalize transition-colors hover:bg-accent/40",
                          assigneeModelLane === lane && "bg-accent text-foreground",
                        )}
                        onClick={() => setAssigneeModelLane(lane)}
                      >
                        {lane === "primary" ? l10n("local.primary_efe10c80") : l10n("local.custom_494ca78f")}
                      </button>
                    ))}
                  </div>
                  {assigneeModelLane === "primary" && (
                    <p className="text-(length:--text-micro) text-muted-foreground">{l10n("local.runs_on_the_agent_s_primary_model_ba89c30c")}</p>
                  )}
                  {assigneeModelLane === "custom" && (
                    <p className="text-(length:--text-micro) text-muted-foreground">{l10n("local.override_the_model_and_effort_for_this_task_o_68f8f178")}</p>
                  )}
                </div>
                {assigneeModelLane === "custom" && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-muted-foreground">{l10n("local.model_5e2c614c")}</div>
                    <InlineEntitySelector
                      value={assigneeModelOverride}
                      options={modelOverrideOptions}
                      placeholder={l10n("local.default_model_3840d9d2")}
                      disablePortal
                      noneLabel={l10n("local.default_model_3840d9d2")}
                      searchPlaceholder={l10n("local.search_models_37b90680")}
                      emptyMessage={l10n("local.no_models_found_339e5fcd")}
                      onChange={setAssigneeModelOverride}
                    />
                  </div>
                )}
                {assigneeModelLane === "custom" && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-muted-foreground">{l10n("local.thinking_effort_264c28cb")}</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {thinkingEffortOptions.map((option) => (
                        <button
                          key={option.value || "default"}
                          className={cn(
                            "px-2 py-1 rounded-md text-xs border border-border hover:bg-accent/50 transition-colors",
                            assigneeThinkingEffort === option.value && "bg-accent"
                          )}
                          onClick={() => setAssigneeThinkingEffort(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {assigneeAdapterType === "claude_local" && assigneeModelLane === "custom" && (
                  <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                    <div className="text-xs text-muted-foreground">{l10n("local.enable_chrome_chrome_df1c9d67")}</div>
                    <ToggleSwitch
                      checked={assigneeChrome}
                      onCheckedChange={() => setAssigneeChrome((value) => !value)}
                    />
                  </div>
                )}
              </div>
            )}
            </div>
          )}

          {/* Description */}
          <div
            className="border-t border-border/60 px-4 pb-2 pt-3"
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            <div
              className={cn(
                "rounded-md transition-colors",
                isFileDragOver && "bg-accent/20",
              )}
            >
              <IssueDescriptionEditor
                value={description}
                expanded={expanded}
                mentions={mentionOptions}
                descriptionEditorRef={descriptionEditorRef}
                imageUploadHandler={uploadDescriptionImageHandler}
                onChange={handleDescriptionChange}
              />
            </div>
            {stagedFiles.length > 0 ? (
              <div className="mt-4 space-y-3 rounded-lg border border-border/70 p-3">
              {stagedDocuments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{l10n("local.documents_b4e929d8")}</div>
                  <div className="space-y-2">
                    {stagedDocuments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                              {file.documentKey}
                            </Badge>
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span>{file.title || file.file.name}</span>
                            <span>•</span>
                            <span>{formatFileSize(file.file)}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={createIssue.isPending}
                          title={l10n("local.remove_document_e17eb479")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {stagedAttachments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{l10n("local.attachments_634de114")}</div>
                  <div className="space-y-2">
                    {stagedAttachments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 text-(length:--text-micro) text-muted-foreground">
                            {file.file.type || "application/octet-stream"} • {formatFileSize(file.file)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={createIssue.isPending}
                          title={l10n("local.remove_attachment_595b066a")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Property chips bar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
          {/* Status chip */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button
                data-slot="new-issue-compact-control"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 py-0 text-xs hover:bg-accent/50 transition-colors sm:h-auto sm:px-2 sm:py-1"
              >
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {statuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex w-full items-start gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  <CircleDot className={cn("h-3 w-3 mt-0.5 shrink-0", s.color)} />
                  <span className="flex flex-col text-left leading-tight">
                    <span>{s.label}</span>
                    {s.description ? (
                      <span className="text-(length:--text-nano) text-muted-foreground">{s.description}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Priority chip — PAP-411: hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && (
          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="new-issue-priority-chip"
                className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent/50 sm:inline-flex"
              >
                {currentPriority ? (
                  <>
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    {l10n("local.priority_d60dbba0")}</>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    p.value === priority && "bg-accent"
                  )}
                  onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                >
                  <p.icon className={cn("h-3 w-3", p.color)} />
                  {p.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          )}

          {/* Labels chip — disabled, not wired up yet */}
          {/* <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
            <Tag className="h-3 w-3" />
            Labels
          </button> */}

          <input
            ref={stageFileInputRef}
            type="file"
            accept={STAGED_FILE_ACCEPT}
            className="hidden"
            onChange={handleStageFilesPicked}
            multiple
          />
          <button
            data-slot="new-issue-compact-control"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 py-0 text-xs hover:bg-accent/50 transition-colors text-muted-foreground sm:h-auto sm:px-2 sm:py-1"
            onClick={() => stageFileInputRef.current?.click()}
            disabled={createIssue.isPending}
          >
            <Paperclip className="h-3 w-3" />
            {l10n("local.upload_865e89de")}</button>

          {/* Work mode chip */}
          <Popover open={workModeOpen} onOpenChange={setWorkModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-issue-work-mode-chip={workMode}
                data-slot="new-issue-compact-control"
                aria-keyshortcuts="Meta+Period Control+Period"
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 py-0 text-xs transition-colors sm:h-auto sm:px-2 sm:py-1",
                  currentWorkMode.classes.chip,
                )}
              >
                <CurrentWorkModeIcon className="h-3 w-3" />
                {currentWorkMode.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {workModeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    data-issue-work-mode={option.value}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                      option.value === workMode && "bg-accent",
                      option.classes.menuItem,
                    )}
                    onClick={() => {
                      setWorkMode(option.value);
                      setWorkModeOpen(false);
                    }}
                  >
                    <Icon className="h-3 w-3" />
                    {option.label}
                    {option.value === workMode ? <Check className="ml-auto h-3 w-3" aria-hidden /> : null}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>

          {/* More */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="new-issue-more-menu-trigger"
                data-slot="new-issue-compact-control"
                className="inline-flex size-8 items-center justify-center rounded-md border border-border p-0 text-xs text-muted-foreground transition-colors hover:bg-accent/50 sm:size-auto sm:p-1"
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start" data-testid="new-issue-more-menu">
              {/* PAP-411: mobile priority section hidden behind SHOW_TASK_PRIORITY_UI. */}
              {SHOW_TASK_PRIORITY_UI && (
              <div className="sm:hidden">
                <div className="px-2 py-1 text-(length:--text-nano) font-medium uppercase text-muted-foreground">
                  {l10n("local.priority_d60dbba0")}</div>
                {priorities.map((p) => (
                  <button
                    type="button"
                    key={p.value}
                    data-testid={`new-issue-more-priority-${p.value}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                      p.value === priority && "bg-accent",
                    )}
                    onClick={() => {
                      setPriority(p.value);
                      setMoreOpen(false);
                    }}
                  >
                    <p.icon className={cn("h-3 w-3", p.color)} />
                    {p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
              </div>
              )}
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {l10n("local.start_date_81696931")}</button>
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {l10n("local.due_date_e1cb6d30")}</button>
            </PopoverContent>
          </Popover>
        </div>

        {assigneeValue && status === "backlog" ? (
          <div
            data-testid="new-issue-assigned-backlog-note"
            className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
          >
            <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
            <span className="leading-snug">
              {l10n("local.assigning_implies_executable_intent_leave_sta_9fc3338d")}{" "}<span className="font-medium">{l10n("local.backlog_bf986e9a")}</span> {l10n("local.only_to_deliberately_park_this_the_assignee_w_cdd53561")}{" "}<span className="font-medium">{l10n("local.todo_4ff402d7")}</span> {l10n("local.or_7175517a")}{" "}<span className="font-medium">{l10n("local.in_progress_b4cc4b07")}</span>.
            </span>
          </div>
        ) : null}

        {selectedAssigneeAgent?.status === "paused" ? (
          <div data-testid="new-issue-paused-assignee-note" className="mx-4 mb-2">
            <InlineBanner tone="warning" icon={PauseCircle} compact>
              <span className="font-medium">{selectedAssigneeAgent.name}</span> {l10n("local.is_paused_and_will_not_start_work_on_this_tas_c1601e7c")}{selectedAssigneeAgent.pauseReason === "import" ? (" " + l10n("local._it_arrived_paused_from_an_organization_impor_9dd8d76f")) : ""}{l10n("local._you_can_resume_it_from_the_task_page_after_c_b0733d3b")}</InlineBanner>
          </div>
        ) : null}

        {currentAssigneeLowTrust ? (
          <div
            data-testid="new-issue-low-trust-assignee-note"
            className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
            <span className="leading-snug">
              {l10n("local.low_trust_review_agent_it_can_only_act_inside_d92516ba")}</span>
          </div>
        ) : null}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={discardDraft}
            disabled={createIssue.isPending || !canDiscardDraft}
          >
            {l10n("local.discard_draft_35cefb4d")}</Button>
          <div className="flex items-center gap-3">
            {createIssue.isError ? (
              <div className="min-h-5 text-right">
                <span className="text-xs text-destructive">{createIssueErrorMessage}</span>
              </div>
            ) : null}
            <Button
              size="sm"
              className="min-w-(--sz-8_5rem) disabled:opacity-100"
              disabled={!titleHasText || createIssue.isPending}
              onClick={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? l10n("local.creating_def70944") : isSubIssueMode ? l10n("local.create_sub_task_71cc5bc3") : l10n("local.create_task_5a9133ce")}</span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
