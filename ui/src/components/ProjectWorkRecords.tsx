import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { l10n } from "@/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkRecord, WorkRecordBusinessStatus, WorkRecordDefectSeverity, WorkRecordKind } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { agentsApi } from "@/api/agents";
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

const BUSINESS_STATUS_OPTIONS: Array<{ value: WorkRecordBusinessStatus; labelKey: string }> = [
  { value: "backlog", labelKey: "local.backlog_bf986e9a" },
  { value: "todo", labelKey: "local.todo_4ff402d7" },
  { value: "in_progress", labelKey: "local.in_progress_c1f88e9d" },
  { value: "in_review", labelKey: "local.in_review_c3905914" },
  { value: "blocked", labelKey: "local.blocked_18f2a094" },
  { value: "done", labelKey: "local.done_11a6767d" },
  { value: "cancelled", labelKey: "local.cancelled_d353a99e" },
];

interface RecordDraft {
  title: string;
  description: string;
  businessStatus: WorkRecordBusinessStatus;
  assigneeAgentId: string;
  qaAssigneeAgentId: string;
  parentRecordId: string;
  predecessorRecordIds: string[];
  packageQaRole: "execution" | "qa";
  qaRetestExemptionReason: string;
  iterationId: string;
  plannedStartDate: string;
  plannedCompletionDate: string;
  defectSeverity: WorkRecordDefectSeverity | "";
}

function blankDraft(): RecordDraft {
  return {
    title: "",
    description: "",
    businessStatus: "backlog",
    assigneeAgentId: "",
    qaAssigneeAgentId: "",
    parentRecordId: "",
    predecessorRecordIds: [],
    packageQaRole: "execution",
    qaRetestExemptionReason: "",
    iterationId: "",
    plannedStartDate: "",
    plannedCompletionDate: "",
    defectSeverity: "",
  };
}

function draftFromRecord(record: WorkRecord): RecordDraft {
  return {
    title: record.title,
    description: record.description ?? "",
    businessStatus: record.businessStatus,
    assigneeAgentId: record.assigneeAgentId ?? "",
    qaAssigneeAgentId: record.qaAssigneeAgentId ?? "",
    parentRecordId: record.parentRecordId ?? "",
    predecessorRecordIds: record.dependencies.map((dependency) => dependency.predecessorRecordId),
    packageQaRole: record.packageQaRole ?? "execution",
    qaRetestExemptionReason: record.qaRetestExemptionReason ?? "",
    iterationId: record.iterationId ?? "",
    plannedStartDate: record.plannedStartDate ?? "",
    plannedCompletionDate: record.plannedCompletionDate ?? "",
    defectSeverity: record.defectSeverity ?? "",
  };
}

export function ProjectWorkRecords({ companyId, projectId, kind, viewMode = "table", onNavigationGuardChange }: {
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  viewMode?: "table" | "gantt";
  onNavigationGuardChange?: (state: { dirty: boolean; guard: () => Promise<boolean> } | null) => void;
}) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WorkRecord | null>(null);
  const [coverageRecord, setCoverageRecord] = useState<WorkRecord | null>(null);
  const [coverageIds, setCoverageIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<RecordDraft>(blankDraft);
  const [viewDraftDirty, setViewDraftDirty] = useState(false);
  const viewLeaveGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const navigationGuardPromiseRef = useRef<Promise<boolean> | null>(null);
  const latestNavigationGuardRef = useRef<() => Promise<boolean>>(async () => true);
  const confirmedDialogCloseRef = useRef(false);
  const recordsKey = queryKeys.workRecords.list(companyId, projectId);
  const records = useQuery({
    queryKey: recordsKey,
    queryFn: () => workRecordsApi.list(companyId, projectId),
    refetchInterval: 15_000,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const capabilities = useQuery({
    queryKey: queryKeys.workRecords.capabilities(companyId, projectId),
    queryFn: () => workRecordsApi.capabilities(companyId, projectId),
  });
  const iterations = useQuery({
    queryKey: queryKeys.workRecords.iterations(companyId, projectId),
    queryFn: () => workRecordsApi.iterations(companyId, projectId),
  });
  const allRecords = records.data ?? [];
  const visibleRecords = useMemo(
    () => allRecords.filter((record) => record.kind === kind),
    [allRecords, kind],
  );
  const kindLabel = kind === "plan" ? l10n("local.work_record_plan") : l10n("local.work_record_defect");
  const businessDraftDirty = dialogOpen && JSON.stringify(draft) !== JSON.stringify(editingRecord ? draftFromRecord(editingRecord) : blankDraft());

  useEffect(() => {
    if (!businessDraftDirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [businessDraftDirty]);

  const closeDialog = (confirmed = false) => {
    confirmedDialogCloseRef.current = confirmed;
    setDialogOpen(false);
    setEditingRecord(null);
    setDraft(blankDraft());
  };
  useEffect(() => {
    if (!dialogOpen) confirmedDialogCloseRef.current = false;
  }, [dialogOpen]);

  const save = useMutation({
    mutationFn: async () => {
      const shared = {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        parentRecordId: draft.parentRecordId || null,
        assigneeAgentId: draft.assigneeAgentId || null,
        qaAssigneeAgentId: draft.qaAssigneeAgentId || null,
        predecessorRecordIds: draft.predecessorRecordIds,
        iterationId: draft.iterationId || null,
        plannedStartDate: draft.plannedStartDate || null,
        plannedCompletionDate: draft.plannedCompletionDate || null,
        ...(kind === "defect" ? { defectSeverity: draft.defectSeverity || null } : {}),
        ...(kind === "plan" && draft.parentRecordId ? {
          packageQaRole: draft.packageQaRole,
          qaRetestExemptionReason: draft.packageQaRole === "execution" ? draft.qaRetestExemptionReason.trim() || null : null,
        } : {}),
      };
      if (editingRecord) {
        return workRecordsApi.update(companyId, projectId, editingRecord.id, {
          expectedRevision: editingRecord.revision,
          ...shared,
          businessStatus: draft.businessStatus,
        });
      }
      return workRecordsApi.create(companyId, { projectId, kind, ...shared });
    },
    onSuccess: async () => {
      closeDialog(true);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  const beforeViewSwitch = async () => {
    if (!businessDraftDirty) return true;
    if (window.confirm("有未保存的业务记录草稿。确定先保存记录并继续切换视图吗？")) {
      try { await save.mutateAsync(); return true; } catch { return false; }
    }
    if (window.confirm("确定放弃业务记录草稿并继续切换视图吗？视图草稿不会被改动。")) { closeDialog(true); return true; }
    return false;
  };
  const guardNavigation = useCallback(() => {
    if (navigationGuardPromiseRef.current) return navigationGuardPromiseRef.current;
    const pending = (viewLeaveGuardRef.current?.() ?? beforeViewSwitch())
      .finally(() => { navigationGuardPromiseRef.current = null; });
    navigationGuardPromiseRef.current = pending;
    return pending;
  }, [businessDraftDirty, draft, editingRecord, save]);
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

  const beginCreate = () => {
    save.reset();
    setEditingRecord(null);
    setDraft(blankDraft());
    setDialogOpen(true);
  };

  const beginEdit = (record: WorkRecord) => {
    save.reset();
    setEditingRecord(record);
    setDraft(draftFromRecord(record));
    setDialogOpen(true);
  };

  const selectRecord = async (record: WorkRecord) => {
    if (record.id === editingRecord?.id) return;
    if (!(await beforeViewSwitch())) return;
    beginEdit(record);
  };

  const beginCoverage = (record: WorkRecord) => {
    saveCoverage.reset();
    setCoverageRecord(record);
    setCoverageIds(record.qaCoverageRecordIds);
  };

  const selectableRecords = allRecords.filter((record) => record.id !== editingRecord?.id);
  const parentRecords = selectableRecords.filter((record) => record.kind === "plan");

  return (
    <section className="space-y-3" data-testid="work-records-main" data-kind={kind} data-view-mode={viewMode}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{kindLabel}</h2>
          <p className="text-sm text-muted-foreground">
            {kind === "plan"
              ? l10n("local.work_record_saving_editing_and_assigning_an_owne")
              : l10n("local.work_record_defects_use_the_same_statuses_and_de")}
          </p>
        </div>
        <Button disabled={capabilities.data?.editRecords.allowed === false} onClick={beginCreate}>
          <Plus className="size-4" />
          {l10n("local.work_record_new_kind", { kind: kindLabel })}
        </Button>
      </div>

      {reopen.error ? <p role="alert" className="text-sm text-destructive">{l10n("local.work_record_failed_to_reopen_defect")}{reopen.error.message}</p> : null}

      {viewMode === "gantt" ? <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">甘特视图沿用同一版本、迭代和计划数据；日期字段为空的记录仍保留在下方表格中。</p> : null}

      <div className="grid items-start gap-3 lg:grid-cols-3">
      <WorkRecordContainerTree companyId={companyId} projectId={projectId} writable={capabilities.data?.manageContainers.allowed !== false} />
      <div className="min-w-0 lg:col-span-2">
      <WorkPackageConsole
        companyId={companyId}
        projectId={projectId}
        records={allRecords}
        visibleKind={kind}
        agentNames={Object.fromEntries((agents.data ?? []).map((agent) => [agent.id, agent.name]))}
        recordsLoading={records.isLoading}
        recordsError={records.error}
        onRetryRecords={() => records.refetch()}
        onEditRecord={(record) => { void selectRecord(record); }}
        onEditCoverage={kind === "plan" ? beginCoverage : undefined}
        onReopenRecord={kind === "defect" ? (record) => reopen.mutate(record) : undefined}
        reopeningRecordId={reopen.isPending ? reopen.variables?.id ?? null : null}
        beforeViewSwitch={beforeViewSwitch}
        onViewDraftDirtyChange={setViewDraftDirty}
        registerLeaveGuard={(guard) => { viewLeaveGuardRef.current = guard; }}
      />
      </div>
      </div>

      <Dialog modal={false} open={dialogOpen} onOpenChange={(open) => { if (open) setDialogOpen(true); else if (confirmedDialogCloseRef.current || !businessDraftDirty || window.confirm("放弃未保存的业务记录草稿？")) closeDialog(true); }}>
        <DialogContent className="sm:max-w-2xl" onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{editingRecord ? l10n("local.work_record_edit_kind", { kind: kindLabel }) : l10n("local.work_record_new_kind", { kind: kindLabel })}</DialogTitle>
            <DialogDescription>{l10n("local.work_record_this_saves_a_business_record_only_it")}</DialogDescription>
          </DialogHeader>

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

            <label className="space-y-1 text-sm font-medium">
              <span>{l10n("local.work_record_parent_plan")}</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.parentRecordId} onChange={(event) => setDraft((current) => ({ ...current, parentRecordId: event.target.value }))}>
                <option value="">{l10n("local.work_record_no_parent_plan")}</option>
                {parentRecords.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>迭代</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.iterationId} onChange={(event) => setDraft((current) => ({ ...current, iterationId: event.target.value }))}>
                <option value="">未归属迭代</option>
                {(iterations.data ?? []).filter((iteration) => !iteration.archivedAt).map((iteration) => <option key={iteration.id} value={iteration.id}>{iteration.name}</option>)}
              </select>
            </label>

            {kind === "defect" ? <label className="space-y-1 text-sm font-medium">
              <span>严重程度</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.defectSeverity} onChange={(event) => setDraft((current) => ({ ...current, defectSeverity: event.target.value as WorkRecordDefectSeverity | "" }))}>
                <option value="">未指定</option><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
              </select>
            </label> : null}

            <label className="space-y-1 text-sm font-medium"><span>计划开始</span><Input type="date" value={draft.plannedStartDate} onChange={(event) => setDraft((current) => ({ ...current, plannedStartDate: event.target.value }))} /></label>
            <label className="space-y-1 text-sm font-medium"><span>计划完成</span><Input type="date" value={draft.plannedCompletionDate} onChange={(event) => setDraft((current) => ({ ...current, plannedCompletionDate: event.target.value }))} /></label>

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
              <span>QA</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.qaAssigneeAgentId} onChange={(event) => setDraft((current) => ({ ...current, qaAssigneeAgentId: event.target.value }))}>
                <option value="">{l10n("local.work_record_defer_assignment")}</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>

            <fieldset className="space-y-1 text-sm font-medium">
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
            </fieldset>

            <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>{l10n("local.work_record_description")}</span>
              <Textarea maxLength={100_000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder={l10n("local.work_record_describe_scope_constraints_and_accep")} />
            </label>
          </div>

          {save.error ? <p role="alert" className="text-sm text-destructive">{l10n("local.work_record_kind_save_failed", { kind: kindLabel })}{save.error.message}</p> : null}

          <DialogFooter className="items-center justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => { if (!businessDraftDirty || window.confirm("放弃未保存的业务记录草稿？")) closeDialog(true); }}>{l10n("local.work_record_cancel")}</Button>
            <Button disabled={!draft.title.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? l10n("local.work_record_saving") : l10n("local.work_record_save_kind", { kind: kindLabel })}
            </Button>
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
