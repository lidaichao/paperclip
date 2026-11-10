import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { l10n } from "@/i18n";
import { useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssuePriority, WorkRecord, WorkRecordBusinessStatus, WorkRecordDefectSeverity, WorkRecordIterationAssignmentMode, WorkRecordKind, WorkRecordUserRole } from "@paperclipai/shared";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { useAccountIdentity } from "@/api/companies-query";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { registerNavigationLeaveGuard } from "@/lib/navigation-leave-guard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WorkPackageConsole } from "@/components/WorkPackageConsole";
import { WorkRecordContainerTree } from "@/components/WorkRecordContainerTree";
import { WorkRecordGantt } from "@/components/WorkRecordGantt";
import { useWorkRecordAutosave } from "@/hooks/use-work-record-autosave";
import {
  emptyWorkRecordDraft,
  workRecordEditorDraftFromRecord,
  type WorkRecordDraftField,
  type WorkRecordEditorDraft,
} from "@/lib/work-record-autosave";

const BUSINESS_STATUS_OPTIONS: Array<{ value: WorkRecordBusinessStatus; labelKey: string }> = [
  { value: "backlog", labelKey: "local.backlog_bf986e9a" },
  { value: "todo", labelKey: "local.todo_4ff402d7" },
  { value: "in_progress", labelKey: "local.in_progress_c1f88e9d" },
  { value: "in_review", labelKey: "local.in_review_c3905914" },
  { value: "blocked", labelKey: "local.blocked_18f2a094" },
  { value: "done", labelKey: "local.done_11a6767d" },
  { value: "cancelled", labelKey: "local.cancelled_d353a99e" },
];

const DRAFT_FIELD_LABELS: Record<WorkRecordDraftField, string> = {
  title: "标题", description: "描述", businessStatus: "状态", assigneeAgentId: "执行人", qaAssigneeAgentId: "QA / 验收者",
  userResponsibilities: "人工责任", parentRecordId: "上级计划", predecessorRecordIds: "前置记录", packageQaRole: "工作包角色",
  qaRetestExemptionReason: "QA 复测豁免原因", iterationId: "迭代", iterationAssignmentMode: "迭代归属",
  plannedStartDate: "计划开始", plannedCompletionDate: "计划完成", priority: "优先级", defectSeverity: "严重度", foundInVersionId: "发现版本",
};

function summarizeConflictGroup(draft: RecordDraft, fields: WorkRecordDraftField[]) {
  const summary = fields.map((field) => {
    const value = draft[field];
    const text = Array.isArray(value)
      ? value.map((item) => typeof item === "string" ? item : `${item.userId}:${item.role}`).join(", ")
      : String(value || "未设置");
    return `${DRAFT_FIELD_LABELS[field]}：${text}`;
  }).join("；");
  return summary.length > 240 ? `${summary.slice(0, 240)}…` : summary;
}

type RecordDraft = WorkRecordEditorDraft;

function blankDraft(): RecordDraft {
  return emptyWorkRecordDraft();
}

function draftFromRecord(record: WorkRecord): RecordDraft {
  return workRecordEditorDraftFromRecord(record);
}

export function ProjectWorkRecords({ companyId, projectId, projectName, topNavigation, kind, viewMode = "table", railOpen, onRailOpenChange, onNavigationGuardChange }: {
  companyId: string;
  projectId: string;
  projectName?: string;
  topNavigation?: ReactNode;
  kind: WorkRecordKind;
  viewMode?: "table" | "gantt";
  railOpen?: boolean;
  onRailOpenChange?: (open: boolean) => void;
  onNavigationGuardChange?: (state: { dirty: boolean; guard: () => Promise<boolean> } | null) => void;
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const deepLinkHandledRef = useRef<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WorkRecord | null>(null);
  const [coverageRecord, setCoverageRecord] = useState<WorkRecord | null>(null);
  const [coverageIds, setCoverageIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<RecordDraft>(blankDraft);
  const [viewDraftDirty, setViewDraftDirty] = useState(false);
  const viewLeaveGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const navigationGuardPromiseRef = useRef<Promise<boolean> | null>(null);
  const businessDecisionPromiseRef = useRef<Promise<boolean> | null>(null);
  const businessDecisionResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const lastEditorFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const lastBusinessFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const latestNavigationGuardRef = useRef<() => Promise<boolean>>(async () => true);
  const confirmedDialogCloseRef = useRef(false);
  const [businessDecisionOpen, setBusinessDecisionOpen] = useState(false);
  const [internalRailOpen, setInternalRailOpen] = useState(true);
  const [containerAdminOpen, setContainerAdminOpen] = useState(false);
  const [containerScope, setContainerScope] = useState("pool");
  const resolvedRailOpen = railOpen ?? internalRailOpen;
  const setRailOpen = (open: boolean) => {
    if (onRailOpenChange) onRailOpenChange(open);
    else setInternalRailOpen(open);
  };
  const recordsKey = useMemo(() => queryKeys.workRecords.list(companyId, projectId), [companyId, projectId]);
  const records = useQuery({
    queryKey: recordsKey,
    queryFn: () => workRecordsApi.list(companyId, projectId),
    refetchInterval: 15_000,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const users = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const capabilities = useQuery({
    queryKey: queryKeys.workRecords.capabilities(companyId, projectId),
    queryFn: () => workRecordsApi.capabilities(companyId, projectId),
  });
  const iterations = useQuery({
    queryKey: queryKeys.workRecords.iterations(companyId, projectId),
    queryFn: () => workRecordsApi.iterations(companyId, projectId),
  });
  const versions = useQuery({
    queryKey: queryKeys.workRecords.versions(companyId, projectId),
    queryFn: () => workRecordsApi.versions(companyId, projectId),
  });
  const allRecords = records.data ?? [];
  const scopedIterationIds = useMemo(() => {
    if (containerScope === "pool") return null;
    if ((iterations.data ?? []).some((iteration) => iteration.id === containerScope)) return new Set([containerScope]);
    return new Set((iterations.data ?? []).filter((iteration) => iteration.versionId === containerScope).map((iteration) => iteration.id));
  }, [containerScope, iterations.data]);
  const visibleRecords = useMemo(
    () => allRecords.filter((record) => record.kind === kind && (!scopedIterationIds || (record.iterationId ? scopedIterationIds.has(record.iterationId) : false))),
    [allRecords, kind, scopedIterationIds],
  );
  const visibleRecordIds = useMemo(() => new Set(visibleRecords.map((record) => record.id)), [visibleRecords]);
  const scopedRecords = useMemo(
    () => allRecords.filter((record) => record.kind !== kind || visibleRecordIds.has(record.id)),
    [allRecords, kind, visibleRecordIds],
  );
  const kindLabel = kind === "plan" ? l10n("local.work_record_plan") : l10n("local.work_record_defect");
  const scopeTitle = containerScope === "pool"
    ? kind === "plan" ? "需求池" : "缺陷池"
    : (iterations.data ?? []).find((iteration) => iteration.id === containerScope)?.name
      ?? (versions.data ?? []).find((version) => version.id === containerScope)?.name
      ?? kindLabel;
  const editCapability = capabilities.data?.editRecords;
  const accountIdentity = useAccountIdentity();
  const autosavePrincipalId = accountIdentity.settled ? accountIdentity.userId : null;
  const recordWritable = editCapability?.allowed === true && Boolean(autosavePrincipalId);
  const onAutosaveSaved = useCallback((saved: WorkRecord) => {
    setEditingRecord((current) => current?.id === saved.id ? saved : current);
    queryClient.setQueryData<WorkRecord[] | undefined>(recordsKey, (current) => current?.map((record) => record.id === saved.id ? saved : record));
  }, [queryClient, recordsKey]);
  const autosave = useWorkRecordAutosave({
    companyId,
    projectId,
    kind,
    principalId: autosavePrincipalId,
    record: editingRecord,
    draft,
    setDraft,
    enabled: dialogOpen && Boolean(editingRecord) && recordWritable,
    onSaved: onAutosaveSaved,
  });
  const fallbackEditingDirty = Boolean(editingRecord) && JSON.stringify(draft) !== JSON.stringify(draftFromRecord(editingRecord!));
  const businessDraftDirty = dialogOpen && (editingRecord
    ? (autosavePrincipalId ? autosave.isDirty : fallbackEditingDirty)
    : JSON.stringify(draft) !== JSON.stringify(blankDraft()));

  useEffect(() => {
    if (!editingRecord) return;
    const latest = allRecords.find((record) => record.id === editingRecord.id);
    if (!latest) return;
    if (latest.revision > editingRecord.revision || latest.dependencySetRevision > editingRecord.dependencySetRevision) {
      setEditingRecord(latest);
    }
  }, [allRecords, editingRecord?.dependencySetRevision, editingRecord?.id, editingRecord?.revision]);

  useEffect(() => {
    setContainerScope("pool");
    setContainerAdminOpen(false);
  }, [projectId]);

  useEffect(() => {
    if (!businessDraftDirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [businessDraftDirty]);

  const closeDialog = (confirmed = false) => {
    const focusTarget = lastEditorFocusRef.current;
    lastEditorFocusRef.current = null;
    confirmedDialogCloseRef.current = confirmed;
    setDialogOpen(false);
    setEditingRecord(null);
    setDraft(blankDraft());
    window.setTimeout(() => { if (focusTarget?.isConnected) focusTarget.focus(); }, 0);
  };
  useEffect(() => {
    if (!dialogOpen) confirmedDialogCloseRef.current = false;
  }, [dialogOpen]);

  const save = useMutation({
    mutationFn: async () => {
      if (editingRecord) throw new Error("Existing records are saved through the revision-aware autosave queue");
      const shared = {
        title: draft.title.trim(),
        description: draft.description === "" ? null : draft.description,
        parentRecordId: draft.parentRecordId || null,
        assigneeAgentId: draft.assigneeAgentId || null,
        qaAssigneeAgentId: draft.qaAssigneeAgentId || null,
        userResponsibilities: draft.userResponsibilities,
        iterationAssignmentMode: draft.iterationAssignmentMode,
        iterationId: draft.iterationAssignmentMode === "inherit_parent" ? null : draft.iterationId || null,
        plannedStartDate: draft.plannedStartDate || null,
        plannedCompletionDate: draft.plannedCompletionDate || null,
        priority: draft.priority,
        ...(kind === "defect" ? { defectSeverity: draft.defectSeverity || null, foundInVersionId: draft.foundInVersionId || null } : {}),
        ...(kind === "plan" && draft.parentRecordId ? {
          packageQaRole: draft.packageQaRole,
          qaRetestExemptionReason: draft.packageQaRole === "execution" ? draft.qaRetestExemptionReason.trim() || null : null,
        } : {}),
      };
      return workRecordsApi.create(companyId, { projectId, kind, ...shared, predecessorRecordIds: draft.predecessorRecordIds });
    },
    onSuccess: async () => {
      closeDialog(true);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });
  const saveCurrent = useCallback(async (closeAfterSave = true) => {
    if (!editingRecord) {
      await save.mutateAsync();
      return true;
    }
    const saved = await autosave.flush();
    if (!saved) return false;
    if (closeAfterSave) closeDialog(true);
    return true;
  // `save` is a stable mutation object; draft/editing changes are intentionally captured.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave.flush, editingRecord, draft]);
  const recordSaveState = editingRecord
    ? autosave.status
    : save.isPending ? "saving" : save.isError ? "failed" : "unsaved";
  const recordSaving = save.isPending || autosave.status === "saving" || autosave.status === "queued";
  const recordSaveError = editingRecord ? autosave.error : save.error;
  const autosaveConflict = autosave.conflict;

  const restoreBusinessFieldFocus = () => window.setTimeout(() => lastBusinessFieldRef.current?.focus(), 0);
  const finishBusinessDecision = (allowed: boolean) => {
    setBusinessDecisionOpen(false);
    businessDecisionResolveRef.current?.(allowed);
    businessDecisionResolveRef.current = null;
    businessDecisionPromiseRef.current = null;
    if (!allowed) restoreBusinessFieldFocus();
  };
  const beforeViewSwitch = useCallback(async () => {
    if (!businessDraftDirty) return true;
    if (businessDecisionPromiseRef.current) return businessDecisionPromiseRef.current;
    const pending = new Promise<boolean>((resolve) => {
      businessDecisionResolveRef.current = resolve;
      setBusinessDecisionOpen(true);
    });
    businessDecisionPromiseRef.current = pending;
    return pending;
  }, [businessDraftDirty]);
  const saveAndContinue = async () => {
    try {
      const saved = await saveCurrent(true);
      finishBusinessDecision(saved);
    } catch {
      finishBusinessDecision(false);
    }
  };
  const guardNavigation = useCallback(() => {
    if (navigationGuardPromiseRef.current) return navigationGuardPromiseRef.current;
    const pending = (viewLeaveGuardRef.current?.() ?? beforeViewSwitch())
      .finally(() => { navigationGuardPromiseRef.current = null; });
    navigationGuardPromiseRef.current = pending;
    return pending;
  }, [beforeViewSwitch]);
  latestNavigationGuardRef.current = guardNavigation;
  useEffect(() => {
    if (!businessDraftDirty && !viewDraftDirty) return;
    return registerNavigationLeaveGuard(() => latestNavigationGuardRef.current());
  }, [businessDraftDirty, viewDraftDirty]);
  useEffect(() => {
    onNavigationGuardChange?.({ dirty: businessDraftDirty || viewDraftDirty, guard: guardNavigation });
    return () => onNavigationGuardChange?.(null);
  }, [businessDraftDirty, guardNavigation, onNavigationGuardChange, viewDraftDirty]);

  const reopen = useMutation({
    mutationFn: (record: WorkRecord) => workRecordsApi.update(companyId, projectId, record.id, {
      expectedRevision: record.revision,
      businessStatus: "todo",
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  const saveCoverage = useMutation({
    mutationFn: () => {
      if (!coverageRecord) throw new Error("No coverage record selected");
      return workRecordsApi.update(companyId, projectId, coverageRecord.id, {
        expectedRevision: coverageRecord.revision,
        qaCoverageRecordIds: coverageIds,
      });
    },
    onSuccess: async () => {
      setCoverageRecord(null);
      setCoverageIds([]);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  const beginCreate = (source?: HTMLElement) => {
    save.reset();
    lastEditorFocusRef.current = source ?? null;
    setEditingRecord(null);
    setDraft(blankDraft());
    setDialogOpen(true);
  };

  const beginEdit = (record: WorkRecord, source?: HTMLElement | SVGElement | null) => {
    save.reset();
    lastEditorFocusRef.current = source ?? null;
    setEditingRecord(record);
    setDraft(draftFromRecord(record));
    setDialogOpen(true);
  };

  const selectRecord = async (record: WorkRecord, source?: HTMLElement | SVGElement | null) => {
    if (record.id === editingRecord?.id) return;
    if (!(await beforeViewSwitch())) return;
    beginEdit(record, source);
  };

  const deepLinkRecordId = new URLSearchParams(location.search).get("record");
  useEffect(() => {
    if (!deepLinkRecordId || deepLinkHandledRef.current === deepLinkRecordId) return;
    const record = visibleRecords.find((item) => item.id === deepLinkRecordId);
    if (!record) return;
    deepLinkHandledRef.current = deepLinkRecordId;
    void selectRecord(record);
  }, [deepLinkRecordId, visibleRecords]);

  const beginCoverage = (record: WorkRecord) => {
    saveCoverage.reset();
    setCoverageRecord(record);
    setCoverageIds(record.qaCoverageRecordIds);
  };

  const selectableRecords = allRecords.filter((record) => record.id !== editingRecord?.id);
  const parentRecords = selectableRecords.filter((record) => record.kind === "plan");
  const iterationLabels = useMemo(() => Object.fromEntries((iterations.data ?? []).map((iteration) => [iteration.id, iteration.name])), [iterations.data]);
  const versionLabels = useMemo(() => Object.fromEntries((versions.data ?? []).map((version) => [version.id, version.name])), [versions.data]);
  const iterationVersionIds = useMemo(() => Object.fromEntries((iterations.data ?? []).map((iteration) => [iteration.id, iteration.versionId])), [iterations.data]);
  const selectedParent = parentRecords.find((record) => record.id === draft.parentRecordId) ?? null;
  const changeParent = (parentRecordId: string) => setDraft((current) => {
    if (!parentRecordId) {
      return {
        ...current,
        parentRecordId: "",
        iterationAssignmentMode: current.iterationAssignmentMode === "inherit_parent" ? "independent" : current.iterationAssignmentMode,
      };
    }
    const parent = parentRecords.find((record) => record.id === parentRecordId) ?? null;
    const shouldInherit = editingRecord ? current.iterationAssignmentMode === "inherit_parent" : true;
    return {
      ...current,
      parentRecordId,
      iterationAssignmentMode: shouldInherit ? "inherit_parent" : current.iterationAssignmentMode,
      iterationId: shouldInherit ? parent?.iterationId ?? "" : current.iterationId,
    };
  });
  const changeIterationAssignmentMode = (iterationAssignmentMode: WorkRecordIterationAssignmentMode) => setDraft((current) => ({
    ...current,
    iterationAssignmentMode,
    iterationId: iterationAssignmentMode === "inherit_parent" ? selectedParent?.iterationId ?? "" : current.iterationId,
  }));
  const userLabels = buildCompanyUserLabelMap(users.data?.users);
  const toggleUserRole = (userId: string, role: WorkRecordUserRole, checked: boolean) => setDraft((current) => ({
    ...current,
    userResponsibilities: checked
      ? [...current.userResponsibilities, { userId, role }]
      : current.userResponsibilities.filter((responsibility) => responsibility.userId !== userId || responsibility.role !== role),
  }));

  return (
    <section className="@container" data-testid="work-records-main" data-kind={kind} data-view-mode={viewMode}>
      <div className="work-record-workspace" data-testid="work-record-workspace-grid" data-rail-open={resolvedRailOpen ? "true" : "false"}>
        <div className="work-record-rail-shell" data-testid="work-record-rail-shell">
          <div className="work-record-rail-panel" aria-hidden={!resolvedRailOpen}>
            <WorkRecordContainerTree
              className="h-full"
              companyId={companyId}
              projectId={projectId}
              projectName={projectName}
              writable={capabilities.data?.manageContainers.allowed !== false}
              mode="navigation"
              managementActive={containerAdminOpen}
              selectedScope={containerScope}
              onSelectScope={(scopeId) => {
                setContainerScope(scopeId);
                setContainerAdminOpen(false);
              }}
              onManageContainers={() => {
                void guardNavigation().then((allowed) => {
                  if (allowed) setContainerAdminOpen(true);
                });
              }}
            />
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 translate-x-1/2 rounded-full bg-background"
            aria-label={resolvedRailOpen ? "收起版本与迭代导航" : "展开版本与迭代导航"}
            aria-expanded={resolvedRailOpen}
            onClick={() => setRailOpen(!resolvedRailOpen)}
            data-testid="work-record-rail-toggle"
          >
            {resolvedRailOpen ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        </div>
        <div className="min-w-0 overflow-hidden" data-testid="work-record-workspace-content">
          {topNavigation ? <div className="mb-3 min-h-12 border-b" data-testid="work-record-top-navigation">{topNavigation}</div> : null}
          {containerAdminOpen ? (
            <WorkRecordContainerTree
              companyId={companyId}
              projectId={projectId}
              writable={capabilities.data?.manageContainers.allowed !== false}
              mode="management"
              onCloseManagement={() => {
                setContainerScope("pool");
                setContainerAdminOpen(false);
              }}
            />
          ) : <>
            <div className="mb-3 flex min-h-11 flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{scopeTitle}</h2>
                <p className="text-sm text-muted-foreground">
                  {visibleRecords.length} 项{kind === "plan" ? "任务" : "缺陷"} · {" "}
                  {kind === "plan"
                    ? l10n("local.work_record_saving_editing_and_assigning_an_owne")
                    : l10n("local.work_record_defects_use_the_same_statuses_and_de")}
                </p>
              </div>
              <Button disabled={!recordWritable} onClick={(event) => beginCreate(event.currentTarget)}>
                <Plus className="size-4" />
                {l10n("local.work_record_new_kind", { kind: kindLabel })}
              </Button>
            </div>

            {reopen.error ? <p role="alert" className="mb-3 text-sm text-destructive">{l10n("local.work_record_failed_to_reopen_defect")}{reopen.error.message}</p> : null}

            {viewMode === "gantt" ? (
              <WorkRecordGantt companyId={companyId} projectId={projectId} records={visibleRecords} writable={recordWritable} onOpen={(record, source) => { void selectRecord(record, source); }} />
            ) : (
              <WorkPackageConsole
                companyId={companyId}
                projectId={projectId}
                records={scopedRecords}
                visibleKind={kind}
                agentNames={Object.fromEntries((agents.data ?? []).map((agent) => [agent.id, agent.name]))}
                iterationLabels={iterationLabels}
                versionLabels={versionLabels}
                iterationVersionIds={iterationVersionIds}
                recordsLoading={records.isLoading}
                recordsError={records.error}
                onRetryRecords={() => records.refetch()}
                onEditRecord={(record, source) => { beginEdit(record, source); }}
                onEditCoverage={kind === "plan" ? beginCoverage : undefined}
                onReopenRecord={kind === "defect" ? (record) => reopen.mutate(record) : undefined}
                reopeningRecordId={reopen.isPending ? reopen.variables?.id ?? null : null}
                beforeViewSwitch={beforeViewSwitch}
                onViewDraftDirtyChange={setViewDraftDirty}
                registerLeaveGuard={(guard) => { viewLeaveGuardRef.current = guard; }}
              />
            )}
          </>}
        </div>
      </div>

      <Dialog modal={false} open={dialogOpen} onOpenChange={(open) => { if (open) setDialogOpen(true); else if (confirmedDialogCloseRef.current || !businessDraftDirty) closeDialog(true); else void beforeViewSwitch(); }}>
        <DialogContent
          data-testid="work-record-detail-drawer"
          className="left-auto right-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none sm:w-3/5 lg:w-2/5 md:top-0 md:translate-y-0"
          overlayClassName="hidden"
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              if (recordWritable && draft.title.trim() && !recordSaving) void saveCurrent(true);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (businessDraftDirty) void beforeViewSwitch();
              else closeDialog(true);
            }
          }}
          onFocusCapture={(event) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) lastBusinessFieldRef.current = event.target; }}
        >
          <DialogHeader>
            <DialogTitle>{editingRecord ? l10n("local.work_record_edit_kind", { kind: kindLabel }) : l10n("local.work_record_new_kind", { kind: kindLabel })}</DialogTitle>
            <DialogDescription>{l10n("local.work_record_this_saves_a_business_record_only_it")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" aria-live="polite" data-testid="work-record-save-state" data-state={recordSaveState} className="text-sm text-muted-foreground">
              {l10n(`local.work_record_save_state_${recordSaveState}`)}
            </p>
            {!recordWritable ? <p role="note" className="text-sm text-muted-foreground">{editCapability?.reason ?? l10n("local.work_record_read_only_editor")}</p> : null}
          </div>

          {editingRecord && autosaveConflict ? <section className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="work-record-autosave-conflict">
            <div>
              <h3 className="font-semibold">{l10n("local.work_record_autosave_conflict_title")}</h3>
              <p className="text-muted-foreground">{l10n("local.work_record_autosave_conflict_help")}</p>
            </div>
            {autosaveConflict.conflictGroups.map((fields, index) => <div key={fields.join(":")} className="space-y-2 rounded-md border bg-background p-3">
              <p className="font-medium">{fields.map((field) => DRAFT_FIELD_LABELS[field]).join(" / ")}</p>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <p><span className="font-medium text-foreground">我的：</span>{summarizeConflictGroup(autosaveConflict.local, fields)}</p>
                <p><span className="font-medium text-foreground">服务器：</span>{summarizeConflictGroup(autosaveConflict.remote, fields)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant={autosaveConflict.choices[index] === "local" ? "default" : "outline"} onClick={() => autosave.chooseConflictGroup(index, "local")}>{l10n("local.work_record_autosave_keep_mine")}</Button>
                <Button type="button" size="sm" variant={autosaveConflict.choices[index] === "remote" ? "default" : "outline"} onClick={() => autosave.chooseConflictGroup(index, "remote")}>{l10n("local.work_record_autosave_use_remote")}</Button>
              </div>
            </div>)}
          </section> : null}

          <fieldset disabled={!recordWritable} className="contents">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>{l10n("local.work_record_title")}</span>
              <Input
                maxLength={500}
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder={kind === "plan" ? l10n("local.work_record_for_example_complete_release_notes") : l10n("local.work_record_for_example_action_bar_covers_conten")}
                autoFocus
              />
            </label>

            {editingRecord ? (
              <label className="space-y-1 text-sm font-medium">
                <span>{l10n("local.work_record_business_status")}</span>
                <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.businessStatus} onChange={(event) => setDraft((current) => ({ ...current, businessStatus: event.target.value as WorkRecordBusinessStatus }))}>
                  {BUSINESS_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{l10n(option.labelKey)}</option>)}
                </select>
              </label>
            ) : null}

            {kind === "plan" ? <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_parent_plan")}</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.parentRecordId} onChange={(event) => changeParent(event.target.value)}>
                <option value="">{l10n("local.work_record_no_parent_plan")}</option>
                {parentRecords.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
              </select>
            </label> : null}

            {kind === "plan" ? <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_iteration_assignment")}</span>
              <select
                aria-label={l10n("local.work_record_iteration_assignment")}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={draft.iterationAssignmentMode}
                disabled={!draft.parentRecordId}
                onChange={(event) => changeIterationAssignmentMode(event.target.value as WorkRecordIterationAssignmentMode)}
              >
                <option value="independent">{l10n("local.work_record_iteration_independent")}</option>
                {draft.parentRecordId ? <option value="inherit_parent">{l10n("local.work_record_iteration_inherit_parent")}</option> : null}
              </select>
            </label> : null}

            <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_iteration")}</span>
              <select
                aria-label={l10n("local.work_record_iteration")}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted"
                value={draft.iterationId}
                disabled={draft.iterationAssignmentMode === "inherit_parent"}
                onChange={(event) => setDraft((current) => ({ ...current, iterationId: event.target.value }))}
              >
                <option value="">{l10n("local.work_record_unassigned_iteration")}</option>
                {(iterations.data ?? []).filter((iteration) => !iteration.archivedAt).map((iteration) => <option key={iteration.id} value={iteration.id}>{iteration.name}</option>)}
              </select>
              {draft.iterationAssignmentMode === "inherit_parent" ? <span className="block text-xs font-normal text-muted-foreground" data-testid="work-record-inherited-iteration-help">
                {l10n("local.work_record_iteration_inherited_help", {
                  iteration: selectedParent?.iterationId ? [versionLabels[iterationVersionIds[selectedParent.iterationId]], iterationLabels[selectedParent.iterationId]].filter(Boolean).join(" / ") || l10n("local.work_record_unassigned_iteration") : l10n("local.work_record_unassigned_iteration"),
                })}
              </span> : null}
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>优先级</span>
              <select aria-label="优先级" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.priority} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value as IssuePriority }))}>
                <option value="critical">最高</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
              </select>
            </label>

            {kind === "defect" ? <>
              <label className="space-y-1 text-sm font-medium">
                <span>严重度</span>
                <select aria-label="严重度" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.defectSeverity} onChange={(event) => setDraft((current) => ({ ...current, defectSeverity: event.target.value as WorkRecordDefectSeverity | "" }))}>
                  <option value="">未指定</option><option value="critical">致命</option><option value="high">严重</option><option value="medium">一般</option><option value="low">轻微</option>
                </select>
              </label>
              <label className="space-y-1 text-sm font-medium">
                <span>发现版本</span>
                <select aria-label="发现版本" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.foundInVersionId} onChange={(event) => setDraft((current) => ({ ...current, foundInVersionId: event.target.value }))}>
                  <option value="">未指定</option>
                  {(versions.data ?? []).map((version) => <option key={version.id} value={version.id}>{version.name}{version.archivedAt ? "（已归档）" : ""}</option>)}
                </select>
              </label>
            </> : null}

            {kind === "plan" ? <label className="space-y-1 text-sm font-medium"><span>{l10n("local.work_record_planned_start")}</span><Input type="date" value={draft.plannedStartDate} onChange={(event) => setDraft((current) => ({ ...current, plannedStartDate: event.target.value }))} /></label> : null}
            <label className="space-y-1 text-sm font-medium"><span>{l10n("local.work_record_planned_completion")}</span><Input type="date" value={draft.plannedCompletionDate} onChange={(event) => setDraft((current) => ({ ...current, plannedCompletionDate: event.target.value }))} /></label>

            {kind === "plan" && draft.parentRecordId ? <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_package_qa_role")}</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.packageQaRole} onChange={(event) => setDraft((current) => ({ ...current, packageQaRole: event.target.value as "execution" | "qa" }))}>
                <option value="execution">{l10n("local.work_record_package_execution_role")}</option>
                <option value="qa">{l10n("local.work_record_package_qa_task_role")}</option>
              </select>
            </label> : null}

            {kind === "plan" && draft.parentRecordId && draft.packageQaRole === "execution" ? <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>{l10n("local.work_record_qa_retest_exemption_reason")}</span>
              <Input maxLength={2000} value={draft.qaRetestExemptionReason} onChange={(event) => setDraft((current) => ({ ...current, qaRetestExemptionReason: event.target.value }))} placeholder={l10n("local.work_record_qa_retest_exemption_optional")} />
            </label> : null}

            <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_assignee")}</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.assigneeAgentId} onChange={(event) => setDraft((current) => ({ ...current, assigneeAgentId: event.target.value }))}>
                <option value="">{l10n("local.work_record_defer_assignment")}</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>{kind === "defect" ? "验收者" : "QA"}</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.qaAssigneeAgentId} onChange={(event) => setDraft((current) => ({ ...current, qaAssigneeAgentId: event.target.value }))}>
                <option value="">{l10n("local.work_record_defer_assignment")}</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>

            <fieldset className="space-y-2 rounded-md border p-3 text-sm md:col-span-2">
              <legend className="px-1 font-medium">{l10n("local.my_todo_human_responsibility")}</legend>
              <p className="text-xs text-muted-foreground">{l10n("local.my_todo_human_responsibility_help")}</p>
              {users.isPending ? <p className="text-muted-foreground">{l10n("local.my_todo_members_loading")}</p> : users.isError ? <p role="alert" className="text-destructive">{l10n("local.my_todo_members_failed")}</p> : null}
              {([ ["execution", "local.my_todo_role_execution"], ["qa", "local.my_todo_role_qa"], ["po", "local.my_todo_role_po"] ] as const).map(([role, labelKey]) => <div key={role} role="group" aria-label={l10n(labelKey)} className="grid gap-1 sm:grid-cols-[4rem_1fr]">
                <span className="pt-1 font-medium">{l10n(labelKey)}</span>
                <div className="flex max-h-24 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
                  {(users.data?.users ?? []).map((user) => <label key={`${role}:${user.principalId}`} className="inline-flex min-h-7 items-center gap-1.5 font-normal">
                    <input type="checkbox" className="size-4 accent-primary" checked={draft.userResponsibilities.some((responsibility) => responsibility.userId === user.principalId && responsibility.role === role)} onChange={(event) => toggleUserRole(user.principalId, role, event.target.checked)} />
                    <span>{userLabels.get(user.principalId) ?? user.principalId}</span>
                  </label>)}
                  {users.data?.users.length === 0 ? <span className="text-muted-foreground">{l10n("local.my_todo_members_empty")}</span> : null}
                </div>
              </div>)}
            </fieldset>

            {kind === "plan" ? <fieldset className="space-y-1 text-sm font-medium">
              <legend>{l10n("local.work_record_predecessor_record")}</legend>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-input p-2">
                {selectableRecords.length === 0 ? <p className="text-muted-foreground">{l10n("local.work_record_no_predecessor")}</p> : null}
                {selectableRecords.map((record) => <label key={record.id} className="flex min-h-8 cursor-pointer items-center gap-2 font-normal">
                  <input type="checkbox" className="size-4 accent-primary" checked={draft.predecessorRecordIds.includes(record.id)} onChange={(event) => setDraft((current) => ({
                    ...current,
                    predecessorRecordIds: event.target.checked
                      ? [...new Set([...current.predecessorRecordIds, record.id])]
                      : current.predecessorRecordIds.filter((id) => id !== record.id),
                  }))} />
                  <span className="truncate" title={record.title}>{record.title}</span>
                </label>)}
              </div>
            </fieldset> : null}

            <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>{l10n("local.work_record_description")}</span>
              <Textarea maxLength={100_000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder={l10n("local.work_record_describe_scope_constraints_and_accep")} />
            </label>
          </div>
          </fieldset>

          {recordSaveError ? <p role="alert" className="text-sm text-destructive">{l10n("local.work_record_kind_save_failed", { kind: kindLabel })}{recordSaveError.message}</p> : null}

          <DialogFooter className="items-center justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => { if (!businessDraftDirty) closeDialog(true); else void beforeViewSwitch(); }}>{l10n("local.work_record_cancel")}</Button>
            {recordWritable ? <Button disabled={!draft.title.trim() || recordSaving || Boolean(autosave.conflict)} onClick={() => void saveCurrent(true)}>
              {recordSaving ? l10n("local.work_record_saving") : l10n("local.work_record_save_kind", { kind: kindLabel })}
            </Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={businessDecisionOpen} onOpenChange={(open) => { if (!open && businessDecisionOpen) finishBusinessDecision(false); }}>
        <DialogContent className="sm:max-w-lg" showCloseButton={false} data-testid="business-draft-decision" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{l10n("local.work_record_unsaved_record_title")}</DialogTitle>
            <DialogDescription>{l10n("local.work_record_unsaved_record_help")}</DialogDescription>
          </DialogHeader>
          {recordSaveError ? <p role="alert" className="text-sm text-destructive">{l10n("local.work_record_unsaved_save_failed", { reason: recordSaveError.message })}</p> : null}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={() => void saveAndContinue()} disabled={recordSaving || Boolean(autosave.conflict)}>{l10n(recordSaving ? "local.work_record_unsaved_saving" : "local.work_record_unsaved_save_continue")}</Button>
            <Button variant="destructive" disabled={recordSaving} onClick={() => { if (editingRecord) autosave.discardLocal(); closeDialog(true); finishBusinessDecision(true); }}>{l10n("local.work_record_unsaved_discard_continue")}</Button>
            <Button autoFocus variant="outline" onClick={() => finishBusinessDecision(false)}>{l10n("local.work_record_unsaved_stay")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(coverageRecord)} onOpenChange={(open) => { if (!open) { setCoverageRecord(null); setCoverageIds([]); } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{l10n("local.work_record_edit_qa_coverage")}</DialogTitle>
            <DialogDescription>{coverageRecord?.title} · {l10n("local.work_record_qa_coverage_help")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
            {allRecords.filter((record) => record.id !== coverageRecord?.id && record.parentRecordId === coverageRecord?.parentRecordId && record.packageQaRole === "qa").length === 0 ? <p className="text-sm text-muted-foreground">{l10n("local.work_record_no_qa_children")}</p> : null}
            {allRecords.filter((record) => record.id !== coverageRecord?.id && record.parentRecordId === coverageRecord?.parentRecordId && record.packageQaRole === "qa").map((record) => <label key={record.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={coverageIds.includes(record.id)} onChange={(event) => setCoverageIds((current) => event.target.checked ? [...new Set([...current, record.id])] : current.filter((id) => id !== record.id))} />
              <span>{record.title}</span>
            </label>)}
          </div>
          {saveCoverage.error ? <p role="alert" className="text-sm text-destructive">{saveCoverage.error.message}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCoverageRecord(null); setCoverageIds([]); }}>{l10n("local.work_record_cancel")}</Button>
            <Button disabled={saveCoverage.isPending} onClick={() => saveCoverage.mutate()}>{l10n("local.work_record_save_qa_coverage")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <span className="sr-only" aria-live="polite">{l10n("local.work_record_showing_kind_count", { count: visibleRecords.length, kind: kindLabel })}</span>
    </section>
  );
}
