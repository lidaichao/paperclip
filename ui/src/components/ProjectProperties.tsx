import { l10n } from "../i18n";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { useState, type ReactNode } from "react";
import { environmentDisplayLabel, filterManagedSandboxSelectableEnvironments } from "@/lib/managed-sandbox-environment";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SharedWorkspaceConcurrency } from "@paperclipai/shared";
import { ProjectRepositories } from "./ProjectRepositories";
import { cn, formatDate } from "../lib/utils";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Archive, ArchiveRestore, Check, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { Badge } from "@/components/ui/badge";

interface ProjectPropertiesProps {
  project: Project;
  repositories?: ReactNode;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  onArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";
export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "env"
  | "execution_workspace_enabled"
  | "execution_workspace_default_mode"
  | "execution_workspace_shared_concurrency"
  | "execution_workspace_environment"
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_runtime_provision_command"
  | "execution_workspace_teardown_command";

const SHARED_WORKSPACE_CONCURRENCY_OPTIONS: {
  value: SharedWorkspaceConcurrency;
  label: string;
  help: string;
}[] = [
  {
    value: "auto",
    label: l10n("local.auto_02862497"),
    help: "Concurrent runs on local/SSH runners; runs take turns in cloud environments.",
  },
  {
    value: "serialize",
    label: l10n("local.serialize_be3403d5"),
    help: "Sandbox runs take turns in the shared project workspace. Local/SSH folders allow concurrent runs.",
  },
  {
    value: "allow",
    label: l10n("local.allow_e213c161"),
    help: "Runs never wait for the workspace; concurrent edits are possible.",
  },
];

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {l10n("local.saving_096b7362")}</span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        {l10n("local.saved_b5c120b3")}</span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-destructive">
        <AlertCircle className="h-3 w-3" />
        {l10n("local.failed_031a8f0f")}</span>
    );
  }
  return null;
}

function FieldLabel({
  label,
  state,
}: {
  label: string;
  state: ProjectFieldSaveState;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SaveIndicator state={state} />
    </div>
  );
}

function PropertyRow({
  label,
  children,
  alignStart = false,
  valueClassName = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  alignStart?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-20 mt-0.5">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap", valueClassName)}>
        {children}
      </div>
    </div>
  );
}

function ArchiveDangerZone({
  project,
  onArchive,
  archivePending,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  archivePending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? "Archive" : "Unarchive";

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? l10n("local.archive_this_project_to_hide_it_from_the_side_4b63f9ea")
          : l10n("local.unarchive_this_project_to_restore_it_in_the_s_36b12ead")}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? l10n("local.archiving_6f340711") : l10n("local.unarchiving_e845716c")}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {action} &ldquo;{project.name}&rdquo;?
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >
            {l10n("local.confirm_eebdd24a")}</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            {l10n("local.cancel_19766ed6")}</Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{action} {l10n("local.project_244210e4")}</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{action} {l10n("local.project_244210e4")}</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, repositories, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) {
      onFieldUpdate(field, data);
      return;
    }
    onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "none"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select an organization to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
  });

  const workspaces = project.workspaces ?? [];
  const codebase = project.codebase;
  const primaryCodebaseWorkspace = project.primaryWorkspace ?? null;
  const hasAdditionalLegacyWorkspaces = workspaces.some((workspace) => workspace.id !== primaryCodebaseWorkspace?.id && !workspace.metadata?.githubRepositoryId);
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated_workspace" ? "isolated_workspace" : "shared_workspace";
  // Absent/unset round-trips as "auto" — we only write a value once the user picks one.
  const executionWorkspaceSharedConcurrency: SharedWorkspaceConcurrency =
    executionWorkspacePolicy?.sharedWorkspaceConcurrency ?? "auto";
  const executionWorkspaceEnvironmentId = executionWorkspacePolicy?.environmentId ?? "";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
    type: "git_worktree",
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };
  // Defense in depth alongside the server's managed-sandbox-only read
  // filter: a cached environments list may still carry the local row.
  const managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
  // The gate for the host-path surfaces below. It fails closed whenever the
  // policy is unknown — in flight and also on a failed read: an unresolved
  // policy reads as "not managed", which would show the local folder the policy
  // exists to hide.
  const hideHostPaths = experimentalSettings === undefined || managedSandboxOnly;
  const runSelectableEnvironments = filterManagedSandboxSelectableEnvironments(
    environments ?? [],
    managedSandboxOnly,
  ).filter((environment) => {
    if (environment.driver === "local" || environment.driver === "ssh") return true;
    if (environment.driver !== "sandbox") return false;
    const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
    return provider !== null && provider !== "fake";
  });
  const showExecutionWorkspaceEnvironmentControl = environmentsEnabled && runSelectableEnvironments.length > 1;

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (project.urlKey !== project.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId) });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const updateExecutionWorkspacePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate && !onFieldUpdate) return;
    return {
      executionWorkspacePolicy: {
        enabled: executionWorkspacesEnabled,
        defaultMode: executionWorkspaceDefaultMode,
        allowIssueOverride: executionWorkspacePolicy?.allowIssueOverride ?? true,
        ...executionWorkspacePolicy,
        ...patch,
      },
    };
  };

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const isSafeExternalUrl = (value: string | null | undefined) => {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const deriveSourceType = (cwd: string | null, repoUrl: string | null) => {
    if (repoUrl) return "git_repo";
    if (cwd) return "local_path";
    return undefined;
  };

  const persistCodebase = (patch: { cwd?: string | null; repoUrl?: string | null }) => {
    const nextCwd = patch.cwd !== undefined ? patch.cwd : codebase.localFolder;
    const nextRepoUrl = patch.repoUrl !== undefined ? patch.repoUrl : codebase.repoUrl;
    if (!nextCwd && !nextRepoUrl) {
      if (primaryCodebaseWorkspace) {
        removeWorkspace.mutate(primaryCodebaseWorkspace.id);
      }
      return;
    }

    const data: Record<string, unknown> = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(deriveSourceType(nextCwd, nextRepoUrl) ? { sourceType: deriveSourceType(nextCwd, nextRepoUrl) } : {}),
      isPrimary: true,
    };

    if (primaryCodebaseWorkspace) {
      updateWorkspace.mutate({ workspaceId: primaryCodebaseWorkspace.id, data });
      return;
    }

    createWorkspace.mutate(data);
  };

  const submitLocalWorkspace = () => {
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      setWorkspaceError(null);
      persistCodebase({ cwd: null });
      return;
    }
    if (!isAbsolutePath(cwd)) {
      setWorkspaceError(l10n("local.local_folder_must_be_a_full_absolute_path_14606c00"));
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ cwd });
  };

  const clearLocalWorkspace = () => {
    const confirmed = window.confirm(
      codebase.repoUrl
        ? "Clear local folder from this workspace?"
        : "Delete this workspace local folder?",
    );
    if (!confirmed) return;
    persistCodebase({ cwd: null });
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label={l10n("local.name_dcd1d522")} state={fieldState("name")} />}>
          {onUpdate || onFieldUpdate ? (
            <DraftInput
              value={project.name}
              onCommit={(name) => commitField("name", { name })}
              immediate
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
              placeholder={l10n("local.project_name_25498193")}
            />
          ) : (
            <span className="text-sm">{project.name}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label={l10n("local.description_526e0087")} state={fieldState("description")} />}
          alignStart
          valueClassName="space-y-0.5"
        >
          {onUpdate || onFieldUpdate ? (
            <InlineEditor
              value={project.description ?? ""}
              onSave={(description) => commitField("description", { description })}
              nullable
              as="p"
              className="text-sm text-muted-foreground"
              placeholder={l10n("local.add_a_description_eed0f05b")}
              multiline
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.description?.trim() || l10n("local.no_description_bcd8cc53")}
            </p>
          )}
        </PropertyRow>
        {repositories ?? <ProjectRepositories key={project.id} project={project} />}
        <PropertyRow
          label={<FieldLabel label={l10n("local.env_494d9aa0")} state={fieldState("env")} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvironmentVariablesEditor
              footerHint={null}
              value={project.env ?? {}}
              secrets={availableSecrets}
              userSecretDefinitions={userSecretDefinitions}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />

          </div>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label={l10n("local.updated_3a5ecca1")} state="idle" />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label={l10n("local.target_date_be142222")} state="idle" />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator className="my-4" />

      <div className="space-y-1 py-4">
        {(!hideHostPaths || (primaryCodebaseWorkspace?.runtimeServices?.length ?? 0) > 0) && <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{l10n("local.codebase_75d4293d")}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                  aria-label={l10n("local.codebase_help_4505bd9b")}
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {hideHostPaths
                  ? l10n("local.repo_identifies_the_source_of_truth_agents_ch_5d972893")
                  : l10n("local.repo_identifies_the_source_of_truth_local_fol_5de0dddf")}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
            {/*
              The local folder is an absolute path on the execution host. Under
              the managed-sandbox-only policy every agent runs in the
              platform-managed environment, so the path, the folder controls,
              and the edit panel below all disappear. A managed checkout keeps
              its one-line label so the codebase still reads as accounted for,
              but never renders the path itself.
            */}
            {hideHostPaths ? (
              codebase.origin === "managed_checkout" ? (
                <div className="text-(length:--text-micro) text-muted-foreground">{l10n("local.paperclip_managed_folder_9f173c4c")}</div>
              ) : null
            ) : (
              <div className="space-y-1">
                <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">{l10n("local.local_folder_b53e4dcc")}</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {codebase.effectiveLocalFolder}
                    </div>
                    {codebase.origin === "managed_checkout" && (
                      <div className="text-(length:--text-micro) text-muted-foreground">{l10n("local.paperclip_managed_folder_9f173c4c")}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      onClick={() => {
                        setWorkspaceMode("local");
                        setWorkspaceCwd(codebase.localFolder ?? "");
                        setWorkspaceError(null);
                      }}
                    >
                      {codebase.localFolder ? l10n("local.change_local_folder_213dcf73") : l10n("local.set_local_folder_69894467")}
                    </Button>
                    {codebase.localFolder ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={clearLocalWorkspace}
                        aria-label={l10n("local.clear_local_folder_845edc73")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {hasAdditionalLegacyWorkspaces && (
              <div className="text-(length:--text-micro) text-muted-foreground">
                {l10n("local.additional_legacy_workspace_records_exist_on_71b817a6")}</div>
            )}

            {primaryCodebaseWorkspace?.runtimeServices && primaryCodebaseWorkspace.runtimeServices.length > 0 ? (
              <div className="space-y-1">
                {primaryCodebaseWorkspace.runtimeServices.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-(length:--text-micro) font-medium">{service.serviceName}</span>
                        <Badge variant="ghost"
                          className={cn(
                            "px-1.5 text-(length:--text-nano) uppercase tracking-wide",
                            service.status === "running"
                              ? "bg-green-500/15 text-green-700 dark:text-green-300"
                              : service.status === "failed"
                                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {service.status}
                        </Badge>
                      </div>
                      <div className="text-(length:--text-micro) text-muted-foreground">
                        {service.url ? (
                          <a
                            href={service.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-foreground hover:underline"
                          >
                            {service.url}
                          </a>
                        ) : (
                          service.command ?? l10n("local.no_url_d15bb2d4")
                        )}
                      </div>
                      {service.exposure && service.exposure.state !== "removed" ? (
                        <div
                          className={cn(
                            "text-(length:--text-nano)",
                            service.exposure.state === "failed" || service.exposure.state === "cleanup_pending"
                              ? "text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {l10n("local.https_205ecf3f")}{" "}{service.exposure.state.replace("_", " ")}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-(length:--text-nano) text-muted-foreground whitespace-nowrap">
                      {service.lifecycle}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {!hideHostPaths && workspaceMode === "local" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                  value={workspaceCwd}
                  onChange={(e) => setWorkspaceCwd(e.target.value)}
                  placeholder="/absolute/path/to/workspace"
                />
                <ChoosePathButton />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!workspaceCwd.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitLocalWorkspace}
                >
                  {l10n("local.save_1509f561")}</Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceCwd("");
                    setWorkspaceError(null);
                  }}
                >
                  {l10n("local.cancel_19766ed6")}</Button>
              </div>
            </div>
          )}
          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">{l10n("local.failed_to_save_workspace_08f774be")}</p>
          )}
          {removeWorkspace.isError && (
            <p className="text-xs text-destructive">{l10n("local.failed_to_delete_workspace_f06ebbe9")}</p>
          )}
          {updateWorkspace.isError && (
            <p className="text-xs text-destructive">{l10n("local.failed_to_update_workspace_def40bab")}</p>
          )}
        </div>}

        {isolatedWorkspacesEnabled && workspaceIsolationControlsVisible ? (
          <>
            <Separator className="my-4" />

            <div className="py-1.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{l10n("local.execution_workspaces_50070986")}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                      aria-label={l10n("local.execution_workspaces_help_edd694f9")}
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {l10n("local.project_owned_defaults_for_isolated_task_chec_26625247")}</TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{l10n("local.enable_isolated_task_checkouts_6b02ced0")}</span>
                      <SaveIndicator state={fieldState("execution_workspace_enabled")} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {l10n("local.let_tasks_choose_between_the_project_s_primar_0e077e1e")}</div>
                  </div>
                  {onUpdate || onFieldUpdate ? (
                    <ToggleSwitch
                      checked={executionWorkspacesEnabled}
                      onCheckedChange={() =>
                        commitField(
                          "execution_workspace_enabled",
                          updateExecutionWorkspacePolicy({ enabled: !executionWorkspacesEnabled })!,
                        )}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {executionWorkspacesEnabled ? l10n("local.enabled_92c1cdfd") : l10n("local.disabled_75081b59")}
                    </span>
                  )}
                </div>

                {executionWorkspacesEnabled ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span>{l10n("local.new_tasks_default_to_isolated_checkout_e2b6f92c")}</span>
                          <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                        </div>
                        <div className="text-(length:--text-micro) text-muted-foreground">
                          {l10n("local.if_disabled_new_tasks_stay_on_the_project_s_p_e03fbea8")}</div>
                      </div>
                      <ToggleSwitch
                        checked={executionWorkspaceDefaultMode === "isolated_workspace"}
                        onCheckedChange={() =>
                          commitField(
                            "execution_workspace_default_mode",
                            updateExecutionWorkspacePolicy({
                              defaultMode:
                                executionWorkspaceDefaultMode === "isolated_workspace"
                                  ? "shared_workspace"
                                  : "isolated_workspace",
                            })!,
                          )}
                      />
                    </div>

                    <div className="space-y-0.5">
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-sm">
                          <span>{l10n("local.shared_workspace_concurrency_85c39d51")}</span>
                          <SaveIndicator state={fieldState("execution_workspace_shared_concurrency")} />
                        </label>
                      </div>
                      {onUpdate || onFieldUpdate ? (
                        <select
                          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                          aria-label={l10n("local.shared_workspace_concurrency_85c39d51")}
                          value={executionWorkspaceSharedConcurrency}
                          onChange={(e) =>
                            commitField(
                              "execution_workspace_shared_concurrency",
                              updateExecutionWorkspacePolicy({
                                sharedWorkspaceConcurrency: e.target.value as SharedWorkspaceConcurrency,
                              })!,
                            )}
                        >
                          {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="text-xs">
                          {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.find(
                            (option) => option.value === executionWorkspaceSharedConcurrency,
                          )?.label}
                        </div>
                      )}
                      <p className="text-(length:--text-micro) text-muted-foreground">
                        {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.find(
                          (option) => option.value === executionWorkspaceSharedConcurrency,
                        )?.help}
                      </p>
                    </div>

                    <div className="border-t border-border/60 pt-2">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                      >
                        {executionWorkspaceAdvancedOpen
                          ? l10n("local.hide_advanced_checkout_settings_9980c7cf")
                          : l10n("local.show_advanced_checkout_settings_67863632")}
                      </button>
                    </div>

                    {executionWorkspaceAdvancedOpen ? (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">
                          {l10n("local.host_managed_implementation_a908a6bb")}{" "}<span className="text-foreground">{l10n("local.git_worktree_3810db71")}</span>
                        </div>
                        {showExecutionWorkspaceEnvironmentControl ? (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5">
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{l10n("local.environment_9e471951")}</span>
                                <SaveIndicator state={fieldState("execution_workspace_environment")} />
                              </label>
                            </div>
                            <select
                              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                              value={executionWorkspaceEnvironmentId}
                              onChange={(e) =>
                                commitField(
                                  "execution_workspace_environment",
                                  updateExecutionWorkspacePolicy({
                                    environmentId: e.target.value || null,
                                  })!,
                                )}
                            >
                              <option value="">{l10n("local.no_environment_8d33facf")}</option>
                              {runSelectableEnvironments.map((environment) => (
                                <option key={environment.id} value={environment.id}>
                                  {environmentDisplayLabel(environment)}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.base_ref_9c6c10f9")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_base_ref")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.baseRef ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_base_ref", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    baseRef: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="origin/main"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.branch_template_af312cfa")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_branch_template")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.branchTemplate ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_branch_template", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    branchTemplate: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="{{issue.identifier}}-{{slug}}"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.worktree_parent_dir_d25dc459")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_worktree_parent_dir")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.worktreeParentDir ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_worktree_parent_dir", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    worktreeParentDir: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder=".paperclip/worktrees"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.provision_command_bfbc86f8")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_provision_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.provisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_provision_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    provisionCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/provision-worktree.sh"
                          />
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.runtime_provision_command_e538baaa")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_runtime_provision_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.runtimeProvisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_runtime_provision_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    runtimeProvisionCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/provision-worktree-runtime.sh"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            {l10n("local.runs_once_before_the_first_runtime_service_st_bc07753c")}</p>
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{l10n("local.teardown_command_b6a15677")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_teardown_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.teardownCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_teardown_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    teardownCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/teardown-worktree.sh"
                          />
                        </div>
                        <p className="text-(length:--text-micro) text-muted-foreground">
                          {l10n("local.provision_runs_inside_the_derived_worktree_be_63da1d23")}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

      </div>

      {onArchive && (
        <>
          <Separator className="my-4" />
          <div className="space-y-4 py-4">
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">
              {l10n("local.danger_zone_3c1c01b4")}</div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
            />
          </div>
        </>
      )}
        <PropertyRow label={<FieldLabel label={l10n("local.created_d70b9e24")} state="idle" />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
    </div>
  );
}
