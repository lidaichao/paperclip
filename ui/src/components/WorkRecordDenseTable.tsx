import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkRecord, WorkRecordViewConfig, WorkRecordViewField, WorkRecordViewKind, WorkRecordViewPreference } from "@paperclipai/shared";
import { defaultWorkRecordViewConfig } from "@paperclipai/shared";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { buildWorkRecordTreeRows, type WorkRecordTreeRow } from "@/lib/work-record-tree";

const LABELS: Record<WorkRecordViewField, string> = {
  id: "ID", title: "标题", description: "描述", iteration: "迭代", plannedStartDate: "开始日期",
  plannedCompletionDate: "完成日期", assignee: "负责人", qaAssignee: "QA", businessStatus: "业务状态",
  dispatchState: "派发状态", dependencies: "前置", defectSeverity: "严重度",
};

function cloneConfig(config: WorkRecordViewConfig): WorkRecordViewConfig {
  return structuredClone(config);
}

function fieldLabel(kind: WorkRecordViewKind, field: WorkRecordViewField) {
  if (field === "title") return kind === "plan" ? "任务" : kind === "defect" ? "缺陷" : "标题";
  if (field === "iteration") return "版本 / 迭代";
  return LABELS[field];
}

function value(record: WorkRecord, field: WorkRecordViewField, agentNames: Record<string, string>, iterationLabels: Record<string, string>) {
  switch (field) {
    case "id": return record.id;
    case "title": return record.title;
    case "description": return record.description ?? "";
    case "iteration": return record.iterationId ? iterationLabels[record.iterationId] ?? "未知迭代" : "未分配";
    case "plannedStartDate": return record.plannedStartDate ?? "—";
    case "plannedCompletionDate": return record.plannedCompletionDate ?? "—";
    case "assignee": return record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? "未知" : "未分配";
    case "qaAssignee": return record.qaAssigneeAgentId ? agentNames[record.qaAssigneeAgentId] ?? "未知" : "未分配";
    case "businessStatus": return record.businessStatus;
    case "dispatchState": return record.dispatchState;
    case "dependencies": return String(record.dependencies.length);
    case "defectSeverity": return record.defectSeverity ?? "—";
  }
}

export function WorkRecordDenseTable({ companyId, projectId, kind, records, agentNames, iterationLabels = {}, selectedId, checked, onSelect, onChecked, beforeViewSwitch, onViewDraftDirtyChange, registerLeaveGuard }: {
  companyId: string;
  projectId: string;
  kind: WorkRecordViewKind;
  records: WorkRecord[];
  agentNames: Record<string, string>;
  iterationLabels?: Record<string, string>;
  selectedId: string | null;
  checked: string[];
  onSelect: (id: string) => void;
  onChecked: (ids: string[]) => void;
  beforeViewSwitch: () => Promise<boolean>;
  onViewDraftDirtyChange?: (dirty: boolean) => void;
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const queryClient = useQueryClient();
  const key = queryKeys.workRecords.views(companyId, projectId, kind);
  const views = useQuery({ queryKey: key, queryFn: () => workRecordsApi.views(companyId, projectId, kind) });
  const [activeId, setActiveId] = useState(`builtin:${kind}`);
  const [baseline, setBaseline] = useState<WorkRecordViewConfig>(() => defaultWorkRecordViewConfig(kind));
  const [draft, setDraft] = useState<WorkRecordViewConfig>(() => defaultWorkRecordViewConfig(kind));
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const active = (views.data ?? []).find((view) => view.id === activeId) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    setActiveId(`builtin:${kind}`);
    const next = defaultWorkRecordViewConfig(kind);
    setBaseline(next); setDraft(cloneConfig(next));
    setCollapsedIds(new Set());
  }, [kind, projectId]);

  const refresh = async (next?: WorkRecordViewPreference) => {
    await queryClient.invalidateQueries({ queryKey: key });
    if (next) { setActiveId(next.id); setBaseline(cloneConfig(next.config)); setDraft(cloneConfig(next.config)); }
  };
  const create = useMutation({ mutationFn: (input: { name: string; config: WorkRecordViewConfig }) => workRecordsApi.createView(companyId, projectId, kind, input), onSuccess: refresh });
  const update = useMutation({ mutationFn: (input: { view: WorkRecordViewPreference; name?: string; config?: WorkRecordViewConfig }) => workRecordsApi.updateView(companyId, projectId, kind, input.view.id, { expectedRevision: input.view.revision, name: input.name, config: input.config }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (view: WorkRecordViewPreference) => workRecordsApi.deleteView(companyId, projectId, kind, view.id, view.revision), onSuccess: async () => { const next = defaultWorkRecordViewConfig(kind); setActiveId(`builtin:${kind}`); setBaseline(next); setDraft(cloneConfig(next)); await queryClient.invalidateQueries({ queryKey: key }); } });
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
    setActiveId(id); setBaseline(cloneConfig(next.config)); setDraft(cloneConfig(next.config));
  };
  const save = () => { void persistDraft(); };
  const saveAs = () => { const name = askName(active?.isBuiltin ? "" : `${active?.name ?? ""} 副本`); if (name) create.mutate({ name, config: draft }); };
  const rename = () => { if (!active || active.isBuiltin) return; const name = askName(active.name); if (name && name !== active.name) update.mutate({ view: active, name }); };
  const deleteView = () => { if (active && !active.isBuiltin && window.confirm(`确认删除个人视图“${active.name}”？业务记录不会删除。`)) remove.mutate(active); };
  const mutate = (fn: (next: WorkRecordViewConfig) => void) => setDraft((current) => { const next = cloneConfig(current); fn(next); return next; });
  const move = (field: WorkRecordViewField, delta: number) => mutate((next) => { const from = next.columnOrder.indexOf(field); const to = Math.max(0, Math.min(next.columnOrder.length - 1, from + delta)); next.columnOrder.splice(from, 1); next.columnOrder.splice(to, 0, field); });

  const directMatches = useMemo(() => {
    const query = draft.search.trim().toLocaleLowerCase();
    let result = records.filter((record) => !query || `${record.id} ${record.title} ${record.description ?? ""}`.toLocaleLowerCase().includes(query));
    for (const filter of draft.filters) result = result.filter((record) => {
      const current = value(record, filter.field, agentNames, iterationLabels).toLocaleLowerCase(); const expected = filter.value.toLocaleLowerCase();
      if (filter.operator === "is") return current === expected;
      if (filter.operator === "is_not") return current !== expected;
      if (filter.operator === "contains") return current.includes(expected);
      if (filter.operator === "before") return current < expected;
      return current > expected;
    });
    return result;
  }, [agentNames, draft.filters, draft.search, iterationLabels, records]);
  const compareRecords = useCallback((left: WorkRecord, right: WorkRecord) => {
    for (const item of draft.sort) {
      const compared = value(left, item.field, agentNames, iterationLabels).localeCompare(value(right, item.field, agentNames, iterationLabels), undefined, { numeric: true });
      if (compared) return item.direction === "asc" ? compared : -compared;
    }
    return 0;
  }, [agentNames, draft.sort, iterationLabels]);
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
    for (const row of treeRows) { const group = draft.groupBy ? value(row.record, draft.groupBy, agentNames, iterationLabels) : ""; map.set(group, [...(map.get(group) ?? []), row]); }
    return [...map.entries()];
  }, [agentNames, draft.groupBy, iterationLabels, treeRows]);
  const rowClass = draft.density === "compact" ? "h-8" : draft.density === "comfortable" ? "h-10" : "h-12";
  const toggleCollapsed = (recordId: string) => setCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(recordId)) next.delete(recordId);
    else next.add(recordId);
    return next;
  });

  return <div className="space-y-3" data-testid="work-record-dense-table" data-density={draft.density}>
    <div className="flex min-h-11 flex-wrap items-center gap-2">
      <label className="text-sm font-medium">视图 <select className="h-9 rounded-md border border-input bg-background px-3" value={activeId} onChange={(event) => void switchView(event.target.value)}>{(views.data ?? []).map((view) => <option key={view.id} value={view.id}>{view.isBuiltin ? "内置 · " : "个人 · "}{view.name}</option>)}</select></label>
      <Button size="sm" onClick={save} disabled={!dirty || create.isPending || update.isPending}>{active?.isBuiltin ? "另存为" : "保存修改"}</Button>
      <Button size="sm" variant="outline" onClick={saveAs}>另存为</Button>
      <Button size="sm" variant="outline" disabled={!active || active.isBuiltin} onClick={rename}>重命名</Button>
      <Button size="sm" variant="outline" disabled={!active || active.isBuiltin} onClick={deleteView}>删除</Button>
      {dirty ? <span className="text-sm text-muted-foreground" role="status">未保存配置</span> : null}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Input className="max-w-xs" aria-label="搜索记录" placeholder="搜索 ID、标题或描述" value={draft.search} onChange={(event) => mutate((next) => { next.search = event.target.value; })} />
      <select aria-label="密度" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.density} onChange={(event) => mutate((next) => { next.density = event.target.value as WorkRecordViewConfig["density"]; })}><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="spacious">宽松</option></select>
      <select aria-label="排序字段" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.sort[0]?.field ?? ""} onChange={(event) => mutate((next) => { next.sort = event.target.value ? [{ field: event.target.value as WorkRecordViewField, direction: next.sort[0]?.direction ?? "asc" }] : []; })}><option value="">不排序</option>{columns.map((field) => <option key={field} value={field}>按{fieldLabel(kind, field)}</option>)}</select>
      <Button size="sm" variant="outline" disabled={!draft.sort[0]} onClick={() => mutate((next) => { if (next.sort[0]) next.sort[0].direction = next.sort[0].direction === "asc" ? "desc" : "asc"; })}>{draft.sort[0]?.direction === "desc" ? "降序" : "升序"}</Button>
      <select aria-label="分组字段" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.groupBy ?? ""} onChange={(event) => mutate((next) => { next.groupBy = event.target.value as WorkRecordViewField || null; })}><option value="">不分组</option>{columns.map((field) => <option key={field} value={field}>按{fieldLabel(kind, field)}分组</option>)}</select>
      <select aria-label="业务状态筛选" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.filters.find((item) => item.field === "businessStatus")?.value ?? ""} onChange={(event) => mutate((next) => { next.filters = next.filters.filter((item) => item.field !== "businessStatus"); if (event.target.value) next.filters.push({ field: "businessStatus", operator: "is", value: event.target.value }); })}><option value="">全部状态</option>{["backlog","todo","in_progress","in_review","blocked","done","cancelled"].map((status) => <option key={status}>{status}</option>)}</select>
    </div>
    <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">列设置</summary><div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{draft.columnOrder.map((field) => { const locked = field === "id" || field === "title"; const label = fieldLabel(kind, field); return <div key={field} className="flex min-h-10 items-center gap-1 rounded-md border px-2" onKeyDown={(event) => { if (!event.altKey) return; if (event.key === "ArrowUp") move(field, -1); if (event.key === "ArrowDown") move(field, 1); if (event.key === "ArrowLeft") mutate((next) => { next.columnWidths[field] = Math.max(64, (next.columnWidths[field] ?? 160) - 16); }); if (event.key === "ArrowRight") mutate((next) => { next.columnWidths[field] = Math.min(1200, (next.columnWidths[field] ?? 160) + 16); }); }}><label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" checked={draft.visibleFields.includes(field)} disabled={locked} onChange={(event) => mutate((next) => { next.visibleFields = event.target.checked ? [...next.visibleFields, field] : next.visibleFields.filter((item) => item !== field); })} />{label}</label><Button size="sm" variant="ghost" aria-label={`${label}上移`} onClick={() => move(field, -1)}>↑</Button><Button size="sm" variant="ghost" aria-label={`${label}下移`} onClick={() => move(field, 1)}>↓</Button><Button size="sm" variant="ghost" aria-label={`${label}缩窄`} onClick={() => mutate((next) => { next.columnWidths[field] = Math.max(64, (next.columnWidths[field] ?? 160) - 16); })}>−</Button><Button size="sm" variant="ghost" aria-label={`${label}加宽`} onClick={() => mutate((next) => { next.columnWidths[field] = Math.min(1200, (next.columnWidths[field] ?? 160) + 16); })}>＋</Button><label className="text-xs"><input type="checkbox" aria-label={`${label}冻结`} checked={draft.frozenFields.includes(field)} disabled={locked} onChange={(event) => mutate((next) => { next.frozenFields = event.target.checked ? [...next.frozenFields, field] : next.frozenFields.filter((item) => item !== field); })} />冻结</label></div>; })}</div></details>
    {error ? <p role="alert" className="text-sm text-destructive">视图操作失败：{error.message}</p> : null}
    <div className="overflow-x-auto rounded-md border" tabIndex={0} aria-label={`${kind === "plan" ? "计划" : "缺陷"}密集表格`}>
      <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth: tableWidth }}><thead className="bg-muted/70"><tr><th className="w-10"><span className="sr-only">选择</span></th>{columns.map((field) => <th key={field} scope="col" className={cn("border-b px-2 text-left", draft.frozenFields.includes(field) && "sticky z-10 bg-muted")} style={{ width: draft.columnWidths[field] ?? (field === "title" ? 280 : 160), left: stickyLeft[field] }}>{fieldLabel(kind, field)}</th>)}</tr></thead>
      <tbody>{groups.map(([group, rows]) => <FragmentGroup key={group} label={draft.groupBy ? group || "未分组" : null} columnCount={columns.length + 1}>{rows.map((row) => {
        const record = row.record;
        return <tr key={record.id} className={cn(rowClass, row.hasChildren && "bg-muted/25 font-medium", row.contextOnly && "bg-muted/40 text-muted-foreground", record.id === selectedId && "bg-muted/50")} data-testid="work-record-table-row" data-record-id={record.id} data-tree-depth={row.depth} data-context-only={row.contextOnly ? "true" : "false"}><td className="px-2 text-center"><input type="checkbox" aria-label={`选择 ${record.title}`} checked={checked.includes(record.id)} disabled={row.contextOnly} onChange={(event) => onChecked(event.target.checked ? [...new Set([...checked, record.id])] : checked.filter((id) => id !== record.id))} /></td>{columns.map((field) => <td key={field} className={cn("truncate border-b px-2", draft.frozenFields.includes(field) && "sticky bg-background")} style={{ left: stickyLeft[field] }} title={value(record, field, agentNames, iterationLabels)}>{field === "title" ? <div className="work-record-tree-cell flex min-w-0 items-center" style={{ "--work-record-tree-depth": Math.min(row.depth, 12) } as React.CSSProperties}>{row.hasChildren ? <button type="button" className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${row.expanded ? "收起" : "展开"} ${record.title}`} aria-expanded={row.expanded} onClick={() => toggleCollapsed(record.id)}>{row.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : <span className="mr-1 size-5 shrink-0" aria-hidden="true" />}<button className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(record.id)}>{value(record, field, agentNames, iterationLabels)}</button>{row.contextOnly ? <span className="ml-1 shrink-0 rounded-sm bg-muted px-1 text-xs font-normal">上下文</span> : null}{row.relationWarning ? <span className="ml-1 shrink-0 text-xs font-normal text-destructive" title={row.relationWarning === "cycle" ? "父子关系存在循环" : "父任务不存在"}>关系异常</span> : null}</div> : <button className="w-full truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(record.id)}>{field === "id" ? record.execution.issueIdentifier ?? record.id.slice(0, 8) : value(record, field, agentNames, iterationLabels)}</button>}</td>)}</tr>;
      })}</FragmentGroup>)}</tbody></table>
    </div>
    <p className="text-xs text-muted-foreground" aria-live="polite">显示 {directMatches.length} 条{treeRows.length > directMatches.length ? `，另含 ${treeRows.length - directMatches.length} 条父级上下文` : ""}；保存视图只保存配置，不保存勾选、详情、滚动位置或业务草稿。</p>
  </div>;
}

function FragmentGroup({ label, columnCount, children }: { label: string | null; columnCount: number; children: React.ReactNode }) {
  return <>{label ? <tr><th colSpan={columnCount} className="bg-muted px-2 py-1 text-left text-xs font-medium">{label}</th></tr> : null}{children}</>;
}
