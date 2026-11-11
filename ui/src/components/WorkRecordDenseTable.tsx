import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MutateWorkRecordDependency, UpdateWorkRecord, WorkRecord, WorkRecordViewConfig, WorkRecordViewField, WorkRecordViewKind, WorkRecordViewPreference } from "@paperclipai/shared";
import { defaultWorkRecordViewConfig, deriveWorkRecordDisplayState } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";
import { ArrowUpDown, ChevronDown, ChevronRight, ChevronsUpDown, Columns3, Filter, MoreHorizontal } from "lucide-react";
import { buildWorkRecordTreeRows, type WorkRecordTreeRow } from "@/lib/work-record-tree";

const LABELS: Record<WorkRecordViewField, string> = {
  id: "ID", title: "标题", description: "描述", version: "版本", iteration: "迭代", plannedStartDate: "开始日期",
  plannedCompletionDate: "完成日期", assignee: "负责人", qaAssignee: "QA", businessStatus: "业务状态",
  dispatchState: "派发状态", dependencies: "前置", priority: "优先级", defectSeverity: "严重度", foundInVersion: "发现版本",
};

const BUSINESS_STATUS_LABELS: Record<WorkRecord["businessStatus"], string> = {
  backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "审查中",
  blocked: "受阻", done: "已完成", cancelled: "已取消",
};
const PRIORITY_LABELS: Record<WorkRecord["priority"], string> = {
  critical: "最高", high: "高", medium: "中", low: "低",
};
const DEFECT_SEVERITY_LABELS: Record<NonNullable<WorkRecord["defectSeverity"]>, string> = {
  critical: "致命", high: "严重", medium: "一般", low: "轻微",
};
const DISPATCH_STATE_LABELS: Record<WorkRecord["dispatchState"], string> = {
  not_dispatched: "未派发", preparing: "准备中", queued: "已排队", linked: "已关联", blocked: "已阻塞", failed: "派发失败",
};
type DefectPreset = "all" | "backlog" | "in_progress" | "in_review" | "blocked" | "mine" | "custom";
const DEFECT_STATUS_TABS: Array<{ value: Exclude<DefectPreset, "custom">; label: string; status?: WorkRecord["businessStatus"] }> = [
  { value: "all", label: "全部缺陷" },
  { value: "backlog", label: "待规划", status: "backlog" },
  { value: "in_progress", label: "进行中", status: "in_progress" },
  { value: "in_review", label: "审查中", status: "in_review" },
  { value: "blocked", label: "受阻", status: "blocked" },
  { value: "mine", label: "我的缺陷" },
];
type PlanPreset = "all" | "backlog" | "in_progress" | "in_review" | "mine" | "custom";
const PLAN_PRESET_TABS: Array<{ value: Exclude<PlanPreset, "custom">; label: string; status?: WorkRecord["businessStatus"] }> = [
  { value: "all", label: "全部任务" },
  { value: "backlog", label: "待规划", status: "backlog" },
  { value: "in_progress", label: "进行中", status: "in_progress" },
  { value: "in_review", label: "待审查", status: "in_review" },
  { value: "mine", label: "我的任务" },
];

type InlineEditableField = "businessStatus" | "assignee" | "priority" | "plannedStartDate" | "plannedCompletionDate";
type InlineEditRequest = {
  record: WorkRecord;
  field: InlineEditableField;
  value: string;
  patch: Omit<UpdateWorkRecord, "expectedRevision">;
};
type InlineEditFailure = InlineEditRequest & {
  conflict: boolean;
  message: string;
};

const INLINE_FIELD_LABELS: Record<InlineEditableField, string> = {
  businessStatus: "状态",
  assignee: "负责人",
  priority: "优先级",
  plannedStartDate: "开始日期",
  plannedCompletionDate: "完成日期",
};

function inlineEditKey(recordId: string, field: InlineEditableField) {
  return `${recordId}:${field}`;
}

type WorkRecordBatchAction = {
  label: string;
  onInvoke?: () => void;
  disabled: boolean;
  reason: string | null;
  pending: boolean;
};

export type WorkRecordBatchActions = {
  dispatch: WorkRecordBatchAction;
  assignOwner: WorkRecordBatchAction;
};

function cloneConfig(config: WorkRecordViewConfig): WorkRecordViewConfig {
  return structuredClone(config);
}

function normalizeConfig(kind: WorkRecordViewKind, config: WorkRecordViewConfig): WorkRecordViewConfig {
  const next = cloneConfig(config);
  for (const field of defaultWorkRecordViewConfig(kind).columnOrder) {
    if (!next.columnOrder.includes(field)) next.columnOrder.push(field);
  }
  return next;
}

function fieldLabel(kind: WorkRecordViewKind, field: WorkRecordViewField) {
  if (field === "title") return kind === "plan" ? "任务" : kind === "defect" ? "缺陷" : "标题";
  if (field === "qaAssignee" && kind === "defect") return "验收者";
  return LABELS[field];
}

function rawValue(record: WorkRecord, field: WorkRecordViewField, agentNames: Record<string, string>, iterationLabels: Record<string, string>, versionLabels: Record<string, string>, iterationVersionIds: Record<string, string>) {
  switch (field) {
    case "id": return record.recordIdentifier;
    case "title": return record.title;
    case "description": return record.description ?? "";
    case "iteration": {
      const label = record.iterationId ? iterationLabels[record.iterationId] ?? "未知迭代" : "未分配";
      return record.iterationAssignmentMode === "inherit_parent" ? `继承 · ${label}` : label;
    }
    case "version": {
      const versionId = record.iterationId ? iterationVersionIds[record.iterationId] : null;
      return versionId ? versionLabels[versionId] ?? "未知版本" : "未分配";
    }
    case "plannedStartDate": return record.plannedStartDate ?? "—";
    case "plannedCompletionDate": return record.plannedCompletionDate ?? "—";
    case "assignee": return record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? "未知" : "未分配";
    case "qaAssignee": return record.qaAssigneeAgentId ? agentNames[record.qaAssigneeAgentId] ?? "未知" : "未分配";
    case "businessStatus": return record.businessStatus;
    case "dispatchState": return record.dispatchState;
    case "dependencies": return String(record.dependencies.length);
    case "priority": return record.priority;
    case "defectSeverity": return record.defectSeverity ?? "—";
    case "foundInVersion": return record.foundInVersionId ? versionLabels[record.foundInVersionId] ?? "未知版本" : "—";
  }
}

function displayValue(record: WorkRecord, field: WorkRecordViewField, agentNames: Record<string, string>, iterationLabels: Record<string, string>, versionLabels: Record<string, string>, iterationVersionIds: Record<string, string>) {
  if (field === "businessStatus") return BUSINESS_STATUS_LABELS[record.businessStatus];
  if (field === "dispatchState") return DISPATCH_STATE_LABELS[record.dispatchState];
  if (field === "priority") return PRIORITY_LABELS[record.priority];
  if (field === "defectSeverity" && record.defectSeverity) return DEFECT_SEVERITY_LABELS[record.defectSeverity];
  return rawValue(record, field, agentNames, iterationLabels, versionLabels, iterationVersionIds);
}

function filterCandidates(record: WorkRecord, field: WorkRecordViewField, agentNames: Record<string, string>, iterationLabels: Record<string, string>, versionLabels: Record<string, string>, iterationVersionIds: Record<string, string>) {
  const values = [
    rawValue(record, field, agentNames, iterationLabels, versionLabels, iterationVersionIds),
    displayValue(record, field, agentNames, iterationLabels, versionLabels, iterationVersionIds),
  ];
  if (field === "iteration" && record.iterationId) {
    const iteration = iterationLabels[record.iterationId] ?? "未知迭代";
    const versionId = iterationVersionIds[record.iterationId];
    const version = versionId ? versionLabels[versionId] ?? "未知版本" : null;
    const legacyCombined = [version, iteration].filter(Boolean).join(" / ");
    values.push(legacyCombined);
    if (record.iterationAssignmentMode === "inherit_parent") values.push(`继承 · ${legacyCombined}`);
  }
  return [...new Set(values)];
}

export function WorkRecordDenseTable({ companyId, projectId, kind, records, agentNames, iterationLabels = {}, versionLabels = {}, iterationVersionIds = {}, liveRunStatusByIssue = new Map(), liveRunQueryFailed = false, selectedId, checked, onSelect, onChecked, writable = false, currentUserId = null, batchActions, beforeViewSwitch, onViewDraftDirtyChange, registerLeaveGuard, primaryAction }: {
  companyId: string;
  projectId: string;
  kind: WorkRecordViewKind;
  records: WorkRecord[];
  agentNames: Record<string, string>;
  iterationLabels?: Record<string, string>;
  versionLabels?: Record<string, string>;
  iterationVersionIds?: Record<string, string>;
  liveRunStatusByIssue?: ReadonlyMap<string, "queued" | "running">;
  liveRunQueryFailed?: boolean;
  selectedId: string | null;
  checked: string[];
  writable?: boolean;
  currentUserId?: string | null;
  onSelect: (id: string, source: HTMLElement) => void;
  onChecked: (ids: string[]) => void;
  batchActions?: WorkRecordBatchActions;
  beforeViewSwitch: () => Promise<boolean>;
  onViewDraftDirtyChange?: (dirty: boolean) => void;
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  primaryAction?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const key = queryKeys.workRecords.views(companyId, projectId, kind);
  const views = useQuery({ queryKey: key, queryFn: () => workRecordsApi.views(companyId, projectId, kind) });
  const [activeId, setActiveId] = useState(`builtin:${kind}`);
  const [baseline, setBaseline] = useState<WorkRecordViewConfig>(() => defaultWorkRecordViewConfig(kind));
  const [draft, setDraft] = useState<WorkRecordViewConfig>(() => defaultWorkRecordViewConfig(kind));
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [planPreset, setPlanPreset] = useState<PlanPreset>("all");
  const [defectPreset, setDefectPreset] = useState<DefectPreset>("all");
  const [inlineDrafts, setInlineDrafts] = useState<Record<string, string>>({});
  const [inlineFailures, setInlineFailures] = useState<Record<string, InlineEditFailure>>({});
  const active = (views.data ?? []).find((view) => view.id === activeId) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    setActiveId(`builtin:${kind}`);
    const next = defaultWorkRecordViewConfig(kind);
    setBaseline(next); setDraft(cloneConfig(next));
    setCollapsedIds(new Set());
    setPlanPreset("all");
    setDefectPreset("all");
    setInlineDrafts({});
    setInlineFailures({});
  }, [kind, projectId]);

  const refresh = async (next?: WorkRecordViewPreference) => {
    await queryClient.invalidateQueries({ queryKey: key });
    if (next) { const normalized = normalizeConfig(kind, next.config); setActiveId(next.id); setBaseline(normalized); setDraft(cloneConfig(normalized)); }
  };
  const create = useMutation({ mutationFn: (input: { name: string; config: WorkRecordViewConfig }) => workRecordsApi.createView(companyId, projectId, kind, input), onSuccess: refresh });
  const update = useMutation({ mutationFn: (input: { view: WorkRecordViewPreference; name?: string; config?: WorkRecordViewConfig }) => workRecordsApi.updateView(companyId, projectId, kind, input.view.id, { expectedRevision: input.view.revision, name: input.name, config: input.config }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (view: WorkRecordViewPreference) => workRecordsApi.deleteView(companyId, projectId, kind, view.id, view.revision), onSuccess: async () => { const next = defaultWorkRecordViewConfig(kind); setActiveId(`builtin:${kind}`); setBaseline(next); setDraft(cloneConfig(next)); await queryClient.invalidateQueries({ queryKey: key }); } });
  const inlineUpdate = useMutation({
    mutationFn: ({ record, patch }: InlineEditRequest) => workRecordsApi.update(companyId, projectId, record.id, { expectedRevision: record.revision, ...patch }),
    onSuccess: async (updated, request) => {
      const key = inlineEditKey(request.record.id, request.field);
      queryClient.setQueryData<WorkRecord[]>(queryKeys.workRecords.list(companyId, projectId), (current) => current?.map((record) => record.id === updated.id ? updated : record));
      setInlineDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
      setInlineFailures((current) => { const next = { ...current }; delete next[key]; return next; });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
    },
    onError: async (error, request) => {
      const key = inlineEditKey(request.record.id, request.field);
      setInlineFailures((current) => ({
        ...current,
        [key]: {
          ...request,
          conflict: error instanceof ApiError && error.status === 409,
          message: error instanceof Error ? error.message : "未知错误",
        },
      }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
    },
  });
  const error = create.error ?? update.error ?? remove.error ?? views.error;

  const askName = (initial = "") => window.prompt("个人视图名称（项目、记录类型与本人范围内唯一）", initial)?.trim() ?? "";
  const persistDraft = useCallback(async () => {
    try {
      if (!active || active.isBuiltin) {
        const name = askName();
        if (!name) return false;
        await create.mutateAsync({ name, config: draft });
      } else {
        await update.mutateAsync({ view: active, config: draft });
      }
      return true;
    } catch {
      return false;
    }
  }, [active, create, draft, update]);
  const prepareToLeave = useCallback(async () => {
    if (!(await beforeViewSwitch())) return false;
    if (!dirty) return true;
    if (window.confirm("视图配置尚未保存。是否先保存视图再继续？")) return persistDraft();
    if (window.confirm("确定放弃视图调整并继续吗？业务草稿不会被改动。")) return true;
    return false;
  }, [beforeViewSwitch, dirty, persistDraft]);
  useEffect(() => {
    onViewDraftDirtyChange?.(dirty);
    return () => onViewDraftDirtyChange?.(false);
  }, [dirty, onViewDraftDirtyChange]);
  useEffect(() => {
    registerLeaveGuard?.(prepareToLeave);
    return () => registerLeaveGuard?.(null);
  }, [prepareToLeave, registerLeaveGuard]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  const switchView = async (id: string) => {
    if (id === activeId || !(await prepareToLeave())) return;
    const next = (views.data ?? []).find((view) => view.id === id); if (!next) return;
    const normalized = normalizeConfig(kind, next.config);
    setActiveId(id); setBaseline(normalized); setDraft(cloneConfig(normalized));
    setPlanPreset("custom");
    setDefectPreset("custom");
    setCollapsedIds(new Set());
    onChecked([]);
  };
  const applyPlanPreset = async (preset: Exclude<PlanPreset, "custom">) => {
    if (planPreset === preset && !dirty) return;
    if (!(await prepareToLeave())) return;
    const next = defaultWorkRecordViewConfig("plan");
    const status = PLAN_PRESET_TABS.find((item) => item.value === preset)?.status;
    if (status) next.filters = [{ field: "businessStatus", operator: "is", value: status }];
    setActiveId("builtin:plan");
    setPlanPreset(preset);
    setBaseline(next);
    setDraft(cloneConfig(next));
    setCollapsedIds(new Set());
    onChecked([]);
  };
  const applyDefectPreset = async (preset: Exclude<DefectPreset, "custom">) => {
    if (defectPreset === preset && !dirty) return;
    if (!(await prepareToLeave())) return;
    const next = defaultWorkRecordViewConfig("defect");
    const status = DEFECT_STATUS_TABS.find((item) => item.value === preset)?.status;
    if (status) next.filters = [{ field: "businessStatus", operator: "is", value: status }];
    setActiveId("builtin:defect");
    setDefectPreset(preset);
    setBaseline(next);
    setDraft(cloneConfig(next));
    setCollapsedIds(new Set());
    onChecked([]);
  };
  const save = () => { void persistDraft(); };
  const saveAs = () => { const name = askName(active?.isBuiltin ? "" : `${active?.name ?? ""} 副本`); if (name) create.mutate({ name, config: draft }); };
  const rename = () => { if (!active || active.isBuiltin) return; const name = askName(active.name); if (name && name !== active.name) update.mutate({ view: active, name }); };
  const deleteView = () => { if (active && !active.isBuiltin && window.confirm(`确认删除个人视图“${active.name}”？业务记录不会删除。`)) remove.mutate(active); };
  const mutate = (fn: (next: WorkRecordViewConfig) => void) => setDraft((current) => { const next = cloneConfig(current); fn(next); return next; });
  const move = (field: WorkRecordViewField, delta: number) => mutate((next) => { const from = next.columnOrder.indexOf(field); const to = Math.max(0, Math.min(next.columnOrder.length - 1, from + delta)); next.columnOrder.splice(from, 1); next.columnOrder.splice(to, 0, field); });
  const moveBefore = (field: WorkRecordViewField, target: WorkRecordViewField) => mutate((next) => {
    const from = next.columnOrder.indexOf(field);
    const targetIndex = next.columnOrder.indexOf(target);
    if (from < 0 || targetIndex < 0 || from === targetIndex) return;
    next.columnOrder.splice(from, 1);
    next.columnOrder.splice(from < targetIndex ? targetIndex - 1 : targetIndex, 0, field);
  });
  const resizeColumn = (field: WorkRecordViewField, delta: number) => mutate((next) => {
    next.columnWidths[field] = Math.max(64, Math.min(1200, (next.columnWidths[field] ?? (field === "title" ? 280 : 160)) + delta));
  });
  const startColumnResize = (field: WorkRecordViewField, event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = draft.columnWidths[field] ?? (field === "title" ? 280 : 160);
    const movePointer = (nextEvent: PointerEvent) => mutate((next) => {
      next.columnWidths[field] = Math.max(64, Math.min(1200, startWidth + nextEvent.clientX - startX));
    });
    const stopPointer = () => {
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerup", stopPointer);
    };
    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerup", stopPointer, { once: true });
  };

  const directMatches = useMemo(() => {
    const query = draft.search.trim().toLocaleLowerCase();
    let result = (kind === "plan" && planPreset === "mine") || (kind === "defect" && defectPreset === "mine")
      ? records.filter((record) => currentUserId !== null && record.userResponsibilities.some((item) => item.userId === currentUserId))
      : records;
    result = result.filter((record) => !query || `${record.recordIdentifier} ${record.title} ${record.description ?? ""}`.toLocaleLowerCase().includes(query));
    for (const filter of draft.filters) result = result.filter((record) => {
      const candidates = filterCandidates(record, filter.field, agentNames, iterationLabels, versionLabels, iterationVersionIds).map((value) => value.toLocaleLowerCase());
      const raw = candidates[0];
      const expected = filter.value.toLocaleLowerCase();
      if (filter.operator === "is") return candidates.some((value) => value === expected);
      if (filter.operator === "is_not") return candidates.every((value) => value !== expected);
      if (filter.operator === "contains") return candidates.some((value) => value.includes(expected));
      if (filter.operator === "before") return raw < expected;
      return raw > expected;
    });
    return result;
  }, [agentNames, currentUserId, defectPreset, draft.filters, draft.search, iterationLabels, iterationVersionIds, kind, planPreset, records, versionLabels]);
  const compareRecords = useCallback((left: WorkRecord, right: WorkRecord) => {
    for (const item of draft.sort) {
      const compared = displayValue(left, item.field, agentNames, iterationLabels, versionLabels, iterationVersionIds).localeCompare(displayValue(right, item.field, agentNames, iterationLabels, versionLabels, iterationVersionIds), undefined, { numeric: true });
      if (compared) return item.direction === "asc" ? compared : -compared;
    }
    return 0;
  }, [agentNames, draft.sort, iterationLabels, iterationVersionIds, versionLabels]);
  const treeRows = useMemo(() => {
    if (kind !== "plan" || draft.groupBy) {
      return [...directMatches].sort(compareRecords).map((record) => ({
        record,
        depth: 0,
        hasChildren: false,
        expanded: true,
        contextOnly: false,
        relationWarning: null,
      }));
    }
    return buildWorkRecordTreeRows({
      records,
      directMatchIds: new Set(directMatches.map((record) => record.id)),
      collapsedIds,
      compare: compareRecords,
    });
  }, [collapsedIds, compareRecords, directMatches, draft.groupBy, kind, records]);
  const columns = draft.columnOrder.filter((field) => draft.visibleFields.includes(field));
  const stickyLeft = useMemo(() => {
    const result: Partial<Record<WorkRecordViewField, number>> = {};
    let left = 40;
    for (const field of columns) {
      if (!draft.frozenFields.includes(field)) continue;
      result[field] = left;
      left += draft.columnWidths[field] ?? (field === "title" ? 280 : 160);
    }
    return result;
  }, [columns, draft.columnWidths, draft.frozenFields]);
  const tableWidth = 40 + columns.reduce((total, field) => total + (draft.columnWidths[field] ?? (field === "title" ? 280 : 160)), 0);
  const groups = useMemo(() => {
    const map = new Map<string, WorkRecordTreeRow<WorkRecord>[]>();
    for (const row of treeRows) { const group = draft.groupBy ? displayValue(row.record, draft.groupBy, agentNames, iterationLabels, versionLabels, iterationVersionIds) : ""; map.set(group, [...(map.get(group) ?? []), row]); }
    return [...map.entries()];
  }, [agentNames, draft.groupBy, iterationLabels, iterationVersionIds, treeRows, versionLabels]);
  const selectableIds = treeRows.filter((row) => !row.contextOnly).map((row) => row.record.id);
  const selectedSelectableCount = selectableIds.filter((id) => checked.includes(id)).length;
  const rowClass = draft.density === "compact" ? "h-9" : draft.density === "comfortable" ? "h-10" : "h-12";
  const toggleCollapsed = (recordId: string) => setCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(recordId)) next.delete(recordId);
    else next.add(recordId);
    return next;
  });
  const collapsibleIds = useMemo(() => new Set(records.map((record) => record.parentRecordId).filter((id): id is string => Boolean(id))), [records]);
  const businessStatusFilters = draft.filters.filter((item) => item.field === "businessStatus");
  const simpleBusinessStatus = businessStatusFilters.length === 1 && businessStatusFilters[0].operator === "is"
    ? businessStatusFilters[0].value
    : null;
  const hasComplexBusinessStatusFilter = businessStatusFilters.length > 0 && simpleBusinessStatus === null;
  const submitInlineEdit = (request: InlineEditRequest) => {
    if (!writable) return;
    const key = inlineEditKey(request.record.id, request.field);
    setInlineDrafts((current) => ({ ...current, [key]: request.value }));
    setInlineFailures((current) => { const next = { ...current }; delete next[key]; return next; });
    inlineUpdate.mutate(request);
  };
  const retryInlineEdit = (key: string) => {
    const failure = inlineFailures[key];
    const currentRecord = failure ? records.find((record) => record.id === failure.record.id) : null;
    if (!failure || !currentRecord || !writable) return;
    inlineUpdate.mutate({ ...failure, record: currentRecord });
  };
  const discardInlineEdit = (key: string) => {
    setInlineDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    setInlineFailures((current) => { const next = { ...current }; delete next[key]; return next; });
  };
  const inlineValue = (record: WorkRecord, field: InlineEditableField, serverValue: string) => inlineDrafts[inlineEditKey(record.id, field)] ?? serverValue;

  return <div className="space-y-0" data-testid="work-record-dense-table" data-density={draft.density}>
    <div className="flex min-h-10 items-center gap-2 overflow-x-auto border-b" data-testid="work-record-view-toolbar">
      {kind === "plan" ? <div className="flex min-w-0 items-center gap-0" role="tablist" aria-label="计划状态">
        {PLAN_PRESET_TABS.map((tab) => <Button key={tab.value} role="tab" aria-selected={planPreset === tab.value} size="sm" variant="ghost" className={cn("shrink-0 rounded-none border-b-2 border-transparent", planPreset === tab.value && "border-primary text-primary")} onClick={() => void applyPlanPreset(tab.value)}>{tab.label}</Button>)}
        {(views.data ?? []).filter((view) => !view.isBuiltin).map((view) => <Button key={view.id} size="sm" variant="ghost" className={cn("shrink-0 rounded-none border-b-2 border-transparent", activeId === view.id && "border-primary text-primary")} onClick={() => void switchView(view.id)}>{view.name}</Button>)}
      </div> : <div className="flex min-w-0 items-center gap-0" role="tablist" aria-label="缺陷状态">
        {DEFECT_STATUS_TABS.map((tab) => <Button key={tab.value} role="tab" aria-selected={defectPreset === tab.value} size="sm" variant="ghost" className={cn("shrink-0 rounded-none border-b-2 border-transparent", defectPreset === tab.value && "border-primary text-primary")} onClick={() => void applyDefectPreset(tab.value)}>{tab.label}</Button>)}
        {(views.data ?? []).filter((view) => !view.isBuiltin).map((view) => <Button key={view.id} size="sm" variant="ghost" className={cn("shrink-0 rounded-none border-b-2 border-transparent", activeId === view.id && "border-primary text-primary")} onClick={() => void switchView(view.id)}>{view.name}</Button>)}
      </div>}
      {dirty ? <Button className="shrink-0" size="sm" onClick={save} disabled={create.isPending || update.isPending}>{active?.isBuiltin ? "另存为" : "保存修改"}</Button> : null}
      {dirty ? <span className="shrink-0 text-sm text-muted-foreground" role="status">未保存配置</span> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button className="ml-auto shrink-0" size="icon-sm" variant="outline" aria-label="视图操作"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={saveAs}>另存为</DropdownMenuItem>
          <DropdownMenuItem disabled={!active || active.isBuiltin} onSelect={rename}>重命名</DropdownMenuItem>
          <DropdownMenuItem disabled={!active || active.isBuiltin} onSelect={deleteView}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {primaryAction ? <div className="shrink-0">{primaryAction}</div> : null}
    </div>
    <div className="flex min-h-10 items-center gap-2 overflow-x-auto border-b" data-testid="work-record-filter-toolbar" data-batch-active={checked.length > 0 ? "true" : "false"}>
      {checked.length > 0 ? <>
        <strong className="shrink-0 text-sm">已选 {checked.length} 项</strong>
        <span className="shrink-0" title={batchActions?.dispatch.reason ?? undefined}><Button size="sm" aria-label={batchActions?.dispatch.label ?? "派发"} title={batchActions?.dispatch.reason ?? undefined} disabled={!batchActions || batchActions.dispatch.disabled || batchActions.dispatch.pending} onClick={batchActions?.dispatch.onInvoke}>{batchActions?.dispatch.pending ? "校验中…" : batchActions?.dispatch.label ?? "派发"}</Button></span>
        <span className="shrink-0" title={batchActions?.assignOwner.reason ?? undefined}><Button size="sm" variant="outline" aria-label={batchActions?.assignOwner.label ?? "设置负责人"} title={batchActions?.assignOwner.reason ?? undefined} disabled={!batchActions || batchActions.assignOwner.disabled || batchActions.assignOwner.pending} onClick={batchActions?.assignOwner.onInvoke}>{batchActions?.assignOwner.pending ? "处理中…" : batchActions?.assignOwner.label ?? "设置负责人"}</Button></span>
        <Button className="shrink-0" size="sm" variant="ghost" aria-label="取消选择" onClick={() => onChecked([])}>取消选择</Button>
      </> : <>
        <select aria-label="分组字段" className="h-8 rounded border border-input bg-background px-2 text-xs" value={draft.groupBy ?? ""} onChange={(event) => { onChecked([]); mutate((next) => { next.groupBy = event.target.value as WorkRecordViewField || null; }); }}><option value="">{kind === "plan" ? "任务层级" : "不分组"}</option>{columns.map((field) => <option key={field} value={field}>按{fieldLabel(kind, field)}分组</option>)}</select>
        {kind === "plan" ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="展开或收起任务层级"><ChevronsUpDown className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => setCollapsedIds(new Set())}>全部展开</DropdownMenuItem><DropdownMenuItem onSelect={() => setCollapsedIds(new Set(collapsibleIds))}>全部收起</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
        <Popover>
          <PopoverTrigger asChild><Button className="h-8 shrink-0 px-2 text-xs" size="sm" variant="ghost"><Columns3 className="size-3.5" />列</Button></PopoverTrigger>
          <PopoverContent align="end" className="w-[min(48rem,calc(100vw-2rem))] p-3">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{draft.columnOrder.map((field) => { const locked = field === "id" || field === "title"; const label = fieldLabel(kind, field); return <div key={field} draggable aria-label={`${label}列配置`} className="flex min-h-10 items-center gap-1 rounded-md border px-2" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/work-record-field", field); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const dragged = event.dataTransfer.getData("text/work-record-field") as WorkRecordViewField; if (draft.columnOrder.includes(dragged)) moveBefore(dragged, field); }} onKeyDown={(event) => { if (!event.altKey) return; if (event.key === "ArrowUp") move(field, -1); if (event.key === "ArrowDown") move(field, 1); if (event.key === "ArrowLeft") resizeColumn(field, -16); if (event.key === "ArrowRight") resizeColumn(field, 16); }}><label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" checked={draft.visibleFields.includes(field)} disabled={locked} onChange={(event) => mutate((next) => { next.visibleFields = event.target.checked ? [...next.visibleFields, field] : next.visibleFields.filter((item) => item !== field); })} />{label}</label><Button size="sm" variant="ghost" aria-label={`${label}上移`} onClick={() => move(field, -1)}>↑</Button><Button size="sm" variant="ghost" aria-label={`${label}下移`} onClick={() => move(field, 1)}>↓</Button><Button size="sm" variant="ghost" aria-label={`${label}缩窄`} onClick={() => resizeColumn(field, -16)}>−</Button><Button size="sm" variant="ghost" aria-label={`${label}加宽`} onClick={() => resizeColumn(field, 16)}>＋</Button><label className="text-xs"><input type="checkbox" aria-label={`${label}冻结`} checked={draft.frozenFields.includes(field)} disabled={locked} onChange={(event) => mutate((next) => { next.frozenFields = event.target.checked ? [...next.frozenFields, field] : next.frozenFields.filter((item) => item !== field); })} />冻结</label></div>; })}</div>
          </PopoverContent>
        </Popover>
        <select aria-label="密度" className="h-8 rounded border border-input bg-background px-2 text-xs" value={draft.density} onChange={(event) => mutate((next) => { next.density = event.target.value as WorkRecordViewConfig["density"]; })}><option value="compact">紧凑</option><option value="comfortable">舒适</option>{draft.density === "spacious" ? <option value="spacious">宽松（旧视图）</option> : null}</select>
        {hasComplexBusinessStatusFilter ? <span className="shrink-0 text-xs text-muted-foreground" role="status">已应用复杂状态筛选</span> : null}
        <span className="min-w-4 flex-1" />
        <Input className="h-8 w-64 shrink-0 text-xs" aria-label="搜索记录" placeholder="搜索名称或编号" value={draft.search} onChange={(event) => { onChecked([]); mutate((next) => { next.search = event.target.value; }); }} />
      </>}
    </div>
    {error ? <p role="alert" className="py-2 text-sm text-destructive">视图操作失败：{error.message}</p> : null}
    {Object.entries(inlineFailures).map(([key, failure]) => <div key={key} role="alert" className="flex min-h-10 flex-wrap items-center gap-2 border-x border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
      <span className="min-w-0 flex-1"><strong>{failure.record.title} · {INLINE_FIELD_LABELS[failure.field]}</strong>：{failure.conflict ? "记录已被其他人修改。你的修改已保留，可重试或使用服务器值。" : `修改失败，已保留输入：${failure.message}`}</span>
      <Button size="sm" variant="outline" disabled={!writable || inlineUpdate.isPending} onClick={() => retryInlineEdit(key)}>重试</Button>
      <Button size="sm" variant="ghost" onClick={() => discardInlineEdit(key)}>使用服务器值</Button>
    </div>)}
    <div className="overflow-x-auto border-x border-b" tabIndex={0} aria-label={`${kind === "plan" ? "计划" : "缺陷"}密集表格`} data-testid="work-record-table-scroller">
      <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth: tableWidth }}><thead className="h-9 bg-muted/70"><tr><th className="w-10"><SelectAllCheckbox checked={selectableIds.length > 0 && selectedSelectableCount === selectableIds.length} indeterminate={selectedSelectableCount > 0 && selectedSelectableCount < selectableIds.length} disabled={selectableIds.length === 0} onChange={(nextChecked) => onChecked(nextChecked ? [...new Set([...checked, ...selectableIds])] : checked.filter((id) => !selectableIds.includes(id)))} /></th>{columns.map((field) => { const label = fieldLabel(kind, field); const sort = draft.sort.find((item) => item.field === field); const filter = draft.filters.find((item) => item.field === field); const locked = field === "id" || field === "title"; const headerActionClass = "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/column:opacity-100 group-focus-within/column:opacity-100"; return <th key={field} scope="col" aria-sort={sort?.direction === "asc" ? "ascending" : sort?.direction === "desc" ? "descending" : "none"} className={cn("group/column relative border-b px-1 text-left", draft.frozenFields.includes(field) && "sticky z-10 bg-muted")} style={{ width: draft.columnWidths[field] ?? (field === "title" ? 280 : 160), left: stickyLeft[field] }}><div className="flex min-w-0 items-center gap-1"><span className="min-w-0 flex-1 truncate px-1">{label}</span><button type="button" className={headerActionClass} aria-label={`按${label}排序`} title={sort ? `${sort.direction === "asc" ? "升序" : "降序"}；再次切换` : "排序"} onClick={() => mutate((next) => { const current = next.sort.find((item) => item.field === field); next.sort = !current ? [{ field, direction: "asc" }] : current.direction === "asc" ? [{ field, direction: "desc" }] : []; })}><ArrowUpDown className="size-3.5" /></button><Popover><PopoverTrigger asChild><button type="button" className={cn(headerActionClass, filter && "text-foreground opacity-100")} aria-label={`筛选${label}`} title={filter ? `已筛选：${filter.value}` : "筛选"}><Filter className="size-3.5" /></button></PopoverTrigger><PopoverContent align="start" className="w-72 space-y-2 p-3"><p className="text-sm font-medium">筛选{label}</p><select aria-label={`${label}筛选条件`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={filter?.operator ?? "contains"} onChange={(event) => mutate((next) => { const current = next.filters.find((item) => item.field === field); if (current) current.operator = event.target.value as WorkRecordViewConfig["filters"][number]["operator"]; else next.filters.push({ field, operator: event.target.value as WorkRecordViewConfig["filters"][number]["operator"], value: "" }); })}><option value="contains">包含</option><option value="is">等于</option><option value="is_not">不等于</option><option value="before">早于</option><option value="after">晚于</option></select><Input aria-label={`${label}筛选值`} value={filter?.value ?? ""} onChange={(event) => mutate((next) => { next.filters = next.filters.filter((item) => item.field !== field); if (event.target.value) next.filters.push({ field, operator: filter?.operator ?? "contains", value: event.target.value }); })} /><Button size="sm" variant="ghost" disabled={!filter} onClick={() => mutate((next) => { next.filters = next.filters.filter((item) => item.field !== field); })}>清除筛选</Button></PopoverContent></Popover><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={headerActionClass} aria-label={`${label}列菜单`} title="列菜单"><MoreHorizontal className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={locked} onClick={() => mutate((next) => { next.visibleFields = next.visibleFields.filter((item) => item !== field); })}>隐藏{label}列</DropdownMenuItem><DropdownMenuItem onClick={() => mutate((next) => { next.frozenFields = next.frozenFields.includes(field) ? next.frozenFields.filter((item) => item !== field) : [...next.frozenFields, field]; })}>{draft.frozenFields.includes(field) ? "取消冻结" : "冻结此列"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><span role="separator" aria-orientation="vertical" aria-label={`${label}调整列宽`} tabIndex={0} className="absolute inset-y-0 right-0 w-1 cursor-col-resize touch-none focus-visible:bg-ring" onPointerDown={(event) => startColumnResize(field, event)} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); resizeColumn(field, -16); } if (event.key === "ArrowRight") { event.preventDefault(); resizeColumn(field, 16); } }} /></th>; })}</tr></thead>
      <tbody>{groups.map(([group, rows]) => <FragmentGroup key={group} label={draft.groupBy ? group || "未分组" : null} columnCount={columns.length + 1}>{rows.map((row) => {
        const record = row.record;
        const editing = inlineUpdate.isPending && inlineUpdate.variables?.record.id === record.id;
        return <tr key={record.id} className={cn(rowClass, row.hasChildren && "bg-primary/10 font-semibold text-primary", row.contextOnly && "bg-muted/40 text-muted-foreground", checked.includes(record.id) && "bg-primary/5", record.id === selectedId && "bg-muted/50")} data-testid="work-record-table-row" data-record-id={record.id} data-tree-depth={row.depth} data-context-only={row.contextOnly ? "true" : "false"} aria-current={record.id === selectedId ? "true" : undefined}>
          <td className="border-b px-2 text-center"><input type="checkbox" aria-label={`选择 ${record.title}`} checked={checked.includes(record.id)} disabled={row.contextOnly} onChange={(event) => onChecked(event.target.checked ? [...new Set([...checked, record.id])] : checked.filter((id) => id !== record.id))} /></td>
          {columns.map((field) => {
            const cellValue = displayValue(record, field, agentNames, iterationLabels, versionLabels, iterationVersionIds);
            const frozen = draft.frozenFields.includes(field);
            const businessStatusValue = inlineValue(record, "businessStatus", record.businessStatus) as WorkRecord["businessStatus"];
            const assigneeValue = inlineValue(record, "assignee", record.assigneeAgentId ?? "");
            const priorityValue = inlineValue(record, "priority", record.priority) as WorkRecord["priority"];
            return <td key={field} className={cn("truncate border-b px-2", frozen && (row.hasChildren ? "sticky bg-primary/10" : "sticky bg-background"))} style={{ left: stickyLeft[field] }} title={cellValue}>
              {field === "title" ? <div className="work-record-tree-cell flex min-w-0 items-center" style={{ "--work-record-tree-depth": Math.min(row.depth, 12) } as React.CSSProperties}>
                {row.hasChildren ? <button type="button" className="mr-1 inline-flex size-[22px] shrink-0 items-center justify-center rounded border bg-background/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${row.expanded ? "收起" : "展开"} ${record.title}`} aria-expanded={row.expanded} onClick={() => toggleCollapsed(record.id)}>{row.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : <span className="mr-1 size-[22px] shrink-0" aria-hidden="true" />}
                <button className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => onSelect(record.id, event.currentTarget)}>{cellValue}</button>
                <WorkRecordLiveIndicator record={record} liveRunStatus={record.execution.issueId ? liveRunStatusByIssue.get(record.execution.issueId) : undefined} liveRunQueryFailed={liveRunQueryFailed} />
                {row.contextOnly ? <span className="ml-1 shrink-0 rounded-sm bg-muted px-1 text-xs font-normal">上下文</span> : null}
                {row.relationWarning ? <span className="ml-1 shrink-0 text-xs font-normal text-destructive" title={row.relationWarning === "cycle" ? "父子关系存在循环" : "父任务不存在"}>关系异常</span> : null}
              </div> : field === "dependencies" && kind === "plan" ? <DependencyCellEditor companyId={companyId} projectId={projectId} record={record} records={records} writable={writable && !row.contextOnly} /> : field === "businessStatus" ? <select aria-label={`${record.title} 状态`} className={cn("h-7 w-full rounded border-0 px-1 text-xs font-normal", statusBadge[businessStatusValue] ?? statusBadgeDefault)} value={businessStatusValue} disabled={!writable || row.contextOnly || editing} onClick={(event) => event.stopPropagation()} onChange={(event) => { const value = event.target.value as WorkRecord["businessStatus"]; submitInlineEdit({ record, field: "businessStatus", value, patch: { businessStatus: value } }); }}>{Object.entries(BUSINESS_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field === "assignee" ? <select aria-label={`${record.title} 负责人`} className="h-7 w-full rounded border-0 bg-transparent px-1 text-xs font-normal" value={assigneeValue} disabled={!writable || row.contextOnly || editing} onClick={(event) => event.stopPropagation()} onChange={(event) => { const value = event.target.value; submitInlineEdit({ record, field: "assignee", value, patch: { assigneeAgentId: value || null } }); }}><option value="">未分配</option>{Object.entries(agentNames).sort((left, right) => left[1].localeCompare(right[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : field === "priority" ? <select aria-label={`${record.title} 优先级`} className="h-7 w-full rounded border-0 bg-transparent px-1 text-xs font-normal" value={priorityValue} disabled={!writable || row.contextOnly || editing} onClick={(event) => event.stopPropagation()} onChange={(event) => { const value = event.target.value as WorkRecord["priority"]; submitInlineEdit({ record, field: "priority", value, patch: { priority: value } }); }}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field === "plannedStartDate" || field === "plannedCompletionDate" ? <input aria-label={`${record.title} ${fieldLabel(kind, field)}`} type="date" className="h-7 w-full bg-transparent px-1 text-xs font-normal" value={inlineValue(record, field, field === "plannedStartDate" ? record.plannedStartDate ?? "" : record.plannedCompletionDate ?? "")} disabled={!writable || row.contextOnly || editing} onClick={(event) => event.stopPropagation()} onChange={(event) => { const value = event.target.value; submitInlineEdit({ record, field, value, patch: field === "plannedStartDate" ? { plannedStartDate: value || null } : { plannedCompletionDate: value || null } }); }} /> : <button className="w-full truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => onSelect(record.id, event.currentTarget)}>{field === "id" ? record.recordIdentifier : cellValue}</button>}
            </td>;
          })}
        </tr>;
      })}</FragmentGroup>)}</tbody></table>
    </div>
    <div className="flex min-h-8 items-center justify-between border-x border-b px-2 text-xs text-muted-foreground" aria-live="polite"><span>显示 {directMatches.length} / {records.length} 项{treeRows.length > directMatches.length ? ` · ${treeRows.length - directMatches.length} 条父级上下文` : ""}</span><span>列 · {draft.density === "compact" ? "紧凑" : draft.density === "comfortable" ? "舒适" : "宽松"}</span></div>
  </div>;
}

function WorkRecordLiveIndicator({ record, liveRunStatus, liveRunQueryFailed }: {
  record: WorkRecord;
  liveRunStatus?: "queued" | "running";
  liveRunQueryFailed: boolean;
}) {
  const lastMayStillBeActive = record.execution.lastRunStatus === "queued" || record.execution.lastRunStatus === "running";
  if (!record.execution.issueId || (!liveRunStatus && !(liveRunQueryFailed && lastMayStillBeActive))) return null;
  const state = deriveWorkRecordDisplayState({
    businessStatus: record.businessStatus,
    dispatchState: record.dispatchState,
    liveRunStatus,
    liveRunQueryFailed,
    projectionState: record.execution.projectionState,
    lastRunStatus: record.execution.lastRunStatus,
  });
  const label = state.state === "running" ? "处理中" : state.state === "queued" ? "排队中" : state.state === "conflict" ? "状态冲突" : state.state === "unknown" ? "运行状态未知" : null;
  if (!label) return null;
  return <span className={cn("ml-2 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-normal", state.state === "conflict" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")} data-testid="work-record-live-state" data-state={state.state} data-animated={state.animated ? "true" : "false"} aria-label={`${record.title}：${label}`} title={label}>
    <span className="relative flex size-2" aria-hidden="true">{state.animated ? <span className="absolute inline-flex size-full rounded-full bg-current opacity-75 motion-safe:animate-ping" /> : null}<span className="relative inline-flex size-2 rounded-full bg-current" /></span>
    {label}
  </span>;
}

type DependencyMutationRequest = {
  input: MutateWorkRecordDependency;
  inverse: (updatedSuccessor: WorkRecord) => MutateWorkRecordDependency | null;
};

function expectedDependencyRecord(record: WorkRecord) {
  return { recordId: record.id, expectedRevision: record.revision, expectedDependencySetRevision: record.dependencySetRevision };
}

function DependencyCellEditor({ companyId, projectId, record, records, writable }: {
  companyId: string;
  projectId: string;
  record: WorkRecord;
  records: WorkRecord[];
  writable: boolean;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [undo, setUndo] = useState<MutateWorkRecordDependency | null>(null);
  const [error, setError] = useState<string | null>(null);
  const predecessorIds = new Set(record.dependencies.map((dependency) => dependency.predecessorRecordId));
  const predecessors = records.filter((candidate) => predecessorIds.has(candidate.id));
  const successors = records.filter((candidate) => candidate.dependencies.some((dependency) => dependency.predecessorRecordId === record.id));
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const candidates = records.filter((candidate) => candidate.id !== record.id
    && !predecessorIds.has(candidate.id)
    && (!normalizedSearch || `${candidate.recordIdentifier} ${candidate.title}`.toLocaleLowerCase().includes(normalizedSearch)));
  const mutation = useMutation({
    mutationFn: async ({ input, inverse }: DependencyMutationRequest) => {
      const updated = await workRecordsApi.mutateDependency(companyId, projectId, input);
      const updatedSuccessor = updated.find((candidate) => candidate.id === record.id);
      if (!updatedSuccessor) throw new Error("服务未返回更新后的后置记录");
      return { updated, inverse: inverse(updatedSuccessor) };
    },
    onSuccess: ({ updated, inverse }) => {
      queryClient.setQueryData<WorkRecord[] | undefined>(queryKeys.workRecords.list(companyId, projectId), (current) => current?.map((candidate) => updated.find((next) => next.id === candidate.id) ?? candidate));
      setUndo(inverse);
      setReplaceId(null);
      setSearch("");
      setError(null);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "依赖修改失败"),
  });
  const run = (request: DependencyMutationRequest) => {
    if (!writable || mutation.isPending) return;
    mutation.mutate(request);
  };
  const addOrReplace = (candidate: WorkRecord) => {
    if (replaceId) {
      const previous = predecessors.find((item) => item.id === replaceId);
      if (!previous) return;
      run({
        input: { operation: "replace_source", predecessorRecordId: previous.id, successorRecordId: record.id, replacementPredecessorRecordId: candidate.id, expectedRecords: [expectedDependencyRecord(record)] },
        inverse: (updated) => ({ operation: "replace_source", predecessorRecordId: candidate.id, successorRecordId: record.id, replacementPredecessorRecordId: previous.id, expectedRecords: [expectedDependencyRecord(updated)] }),
      });
      return;
    }
    run({
      input: { operation: "add", predecessorRecordId: candidate.id, successorRecordId: record.id, expectedRecords: [expectedDependencyRecord(record)] },
      inverse: (updated) => ({ operation: "remove", predecessorRecordId: candidate.id, successorRecordId: record.id, expectedRecords: [expectedDependencyRecord(updated)] }),
    });
  };
  const remove = (predecessor: WorkRecord) => run({
    input: { operation: "remove", predecessorRecordId: predecessor.id, successorRecordId: record.id, expectedRecords: [expectedDependencyRecord(record)] },
    inverse: (updated) => ({ operation: "add", predecessorRecordId: predecessor.id, successorRecordId: record.id, expectedRecords: [expectedDependencyRecord(updated)] }),
  });

  return <Popover onOpenChange={(open) => { if (!open) { setSearch(""); setReplaceId(null); setError(null); } }}>
    <PopoverTrigger asChild><button type="button" className="w-full truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`编辑 ${record.title} 的前置记录`}>{record.dependencies.length ? `${record.dependencies.length} 个前置` : "无前置"}</button></PopoverTrigger>
    <PopoverContent align="start" className="w-[min(30rem,calc(100vw-2rem))] space-y-3 p-3" data-testid="dependency-cell-editor">
      <div className="flex items-center justify-between gap-2"><div><p className="text-sm font-medium">{record.recordIdentifier} · 前置关系</p><p className="text-xs text-muted-foreground">搜索后添加；“替换”会原子改连，不会先断开旧关系。</p></div>{undo ? <Button size="sm" variant="outline" disabled={!writable || mutation.isPending} onClick={() => run({ input: undo, inverse: () => null })}>撤销</Button> : null}</div>
      {predecessors.length ? <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">当前前置</p>{predecessors.map((predecessor) => <div key={predecessor.id} data-dependency-predecessor-id={predecessor.id} className="flex min-h-8 items-center gap-2 rounded-md border px-2 text-sm"><span className="min-w-0 flex-1 truncate" title={`${predecessor.recordIdentifier} ${predecessor.title}`}>{predecessor.recordIdentifier} · {predecessor.title}</span><Button size="sm" variant={replaceId === predecessor.id ? "secondary" : "ghost"} disabled={!writable || mutation.isPending} onClick={() => setReplaceId((current) => current === predecessor.id ? null : predecessor.id)}>{replaceId === predecessor.id ? "取消替换" : "替换"}</Button><Button size="sm" variant="ghost" disabled={!writable || mutation.isPending} onClick={() => remove(predecessor)}>删除</Button></div>)}</div> : <p className="text-xs text-muted-foreground">当前没有前置记录。</p>}
      <Input aria-label={`搜索 ${record.title} 的前置记录`} placeholder="输入记录编号或名称" value={search} disabled={!writable || mutation.isPending} onChange={(event) => setSearch(event.target.value)} />
      {search ? <div className="max-h-36 space-y-1 overflow-y-auto" role="listbox" aria-label="可选前置记录">{candidates.length ? candidates.map((candidate) => <button key={candidate.id} type="button" role="option" className="flex min-h-8 w-full items-center rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={!writable || mutation.isPending} onClick={() => addOrReplace(candidate)}>{replaceId ? "替换为" : "添加"}：{candidate.recordIdentifier} · {candidate.title}</button>) : <p className="px-2 text-xs text-muted-foreground">没有可用记录。</p>}</div> : null}
      <div className="space-y-1 border-t pt-2"><p className="text-xs font-medium text-muted-foreground">后置记录（只读反查）</p><p className="text-xs text-muted-foreground">{successors.length ? successors.map((successor) => `${successor.recordIdentifier} · ${successor.title}`).join("；") : "无"}</p></div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}；原关系保持不变。</p> : null}
    </PopoverContent>
  </Popover>;
}

function FragmentGroup({ label, columnCount, children }: { label: string | null; columnCount: number; children: React.ReactNode }) {
  return <>{label ? <tr><th colSpan={columnCount} className="bg-muted px-2 py-1 text-left text-xs font-medium">{label}</th></tr> : null}{children}</>;
}

function SelectAllCheckbox({ checked, indeterminate, disabled, onChange }: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={inputRef} type="checkbox" aria-label="选择当前可操作记录" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}
