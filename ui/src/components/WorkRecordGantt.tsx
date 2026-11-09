import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultWorkRecordViewConfig, type MutateWorkRecordDependency, type WorkRecord, type WorkRecordViewConfig, type WorkRecordViewField } from "@paperclipai/shared";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";

const DAY = 86_400_000;
export const ganttToDay = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / DAY);
export const ganttFromDay = (value: number) => new Date(value * DAY).toISOString().slice(0, 10);
export const shiftGanttDate = (value: string, days: number) => ganttFromDay(ganttToDay(value) + days);
const GANTT_LABELS: Partial<Record<WorkRecordViewField, string>> = { title: "标题", assignee: "负责人", businessStatus: "状态", plannedStartDate: "开始", plannedCompletionDate: "完成", dependencies: "前置" };
function ganttValue(record: WorkRecord, field: WorkRecordViewField, agentNames: Record<string, string>) {
  if (field === "title") return record.title;
  if (field === "assignee") return record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? "未知" : "未分配";
  if (field === "businessStatus") return record.businessStatus;
  if (field === "plannedStartDate") return record.plannedStartDate ?? "—";
  if (field === "plannedCompletionDate") return record.plannedCompletionDate ?? "—";
  return field === "dependencies" ? String(record.dependencies.length) : "";
}

type Candidate = { record: WorkRecord; start?: string | null; end?: string | null; predecessors?: string[] };
type Undo = { kind: "dates"; record: WorkRecord; start: string | null; end: string | null; predecessors: string[] }
  | { kind: "dependency"; input: MutateWorkRecordDependency };
type Drag = Candidate & { mode: "create" | "move" | "start" | "end"; originX: number; currentX: number; anchorDay: number; pixelsPerDay: number };
type DependencyEdge = { predecessorId: string; successorId: string };
type DependencyDrag = DependencyEdge & { endpoint: "source" | "target" | "create" };

function dragDates(drag: Drag) {
  const delta = Math.round((drag.currentX - drag.originX) / drag.pixelsPerDay);
  if (drag.mode === "create") return { delta, start: ganttFromDay(drag.anchorDay + Math.min(0, delta)), end: ganttFromDay(drag.anchorDay + Math.max(0, delta)) };
  if (!drag.record.plannedStartDate || !drag.record.plannedCompletionDate) return null;
  return {
    delta,
    start: drag.mode === "end" ? drag.record.plannedStartDate : shiftGanttDate(drag.record.plannedStartDate, delta),
    end: drag.mode === "start" ? drag.record.plannedCompletionDate : shiftGanttDate(drag.record.plannedCompletionDate, delta),
  };
}

export function WorkRecordGantt({ companyId, projectId, records, agentNames = {}, writable, onOpen }: {
  companyId: string; projectId: string; records: WorkRecord[]; writable: boolean;
  agentNames?: Record<string, string>;
  onOpen: (record: WorkRecord, source: HTMLElement | SVGElement) => void;
}) {
  const client = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef(0);
  const [focus, setFocus] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressDragClickRef = useRef(false);
  const [dependencyTarget, setDependencyTarget] = useState("");
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [dependencyDrag, setDependencyDrag] = useState<DependencyDrag | null>(null);
  const dependencyDragRef = useRef<DependencyDrag | null>(null);
  const [dependencyCandidate, setDependencyCandidate] = useState<MutateWorkRecordDependency | null>(null);
  const viewsKey = queryKeys.workRecords.views(companyId, projectId, "gantt");
  const views = useQuery({ queryKey: viewsKey, queryFn: () => workRecordsApi.views(companyId, projectId, "gantt") });
  const [viewId, setViewId] = useState("builtin:gantt");
  const [viewConfig, setViewConfig] = useState<WorkRecordViewConfig>(() => defaultWorkRecordViewConfig("gantt"));
  const activeView = (views.data ?? []).find((view) => view.id === viewId) ?? null;
  const columns = viewConfig.columnOrder.filter((field) => viewConfig.visibleFields.includes(field));
  const labelWidth = columns.reduce((sum, field) => sum + (viewConfig.columnWidths[field] ?? (field === "title" ? 220 : 104)), 0);
  const changeView = (fn: (next: WorkRecordViewConfig) => void) => setViewConfig((current) => { const next = structuredClone(current); fn(next); return next; });
  const saveView = useMutation({ mutationFn: async () => {
    if (activeView && !activeView.isBuiltin) return workRecordsApi.updateView(companyId, projectId, "gantt", activeView.id, { expectedRevision: activeView.revision, config: viewConfig });
    const name = window.prompt("甘特视图名称", "我的甘特")?.trim();
    return name ? workRecordsApi.createView(companyId, projectId, "gantt", { name, config: viewConfig }) : null;
  }, onSuccess: async (saved) => { await client.invalidateQueries({ queryKey: viewsKey }); if (saved) setViewId(saved.id); } });
  const dates = records.flatMap((record) => [record.plannedStartDate, record.plannedCompletionDate]).filter(Boolean) as string[];
  const today = new Date().toISOString().slice(0, 10);
  const minDay = dates.length ? Math.min(...dates.map(ganttToDay)) - 2 : ganttToDay(today) - 2;
  const maxDay = dates.length ? Math.max(...dates.map(ganttToDay)) + 2 : minDay + 13;
  const days = Math.max(14, maxDay - minDay + 1);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const predecessors = useMemo(() => new Set(selected?.dependencies.map((item) => item.predecessorRecordId) ?? []), [selected]);
  const preview = drag ? dragDates(drag) : null;

  const mutation = useMutation({
    mutationFn: ({ record, start, end, predecessors: predecessorRecordIds }: Candidate) => workRecordsApi.update(companyId, projectId, record.id, {
      expectedRevision: record.revision,
      ...(start !== undefined ? { plannedStartDate: start } : {}),
      ...(end !== undefined ? { plannedCompletionDate: end } : {}),
      ...(predecessorRecordIds !== undefined ? { predecessorRecordIds } : {}),
      ...(predecessorRecordIds !== undefined ? { dependencySetRevision: record.dependencySetRevision } : {}),
    }),
    onSuccess: async () => { setError(null); setCandidate(null); await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "保存失败"),
  });
  const save = async (next: Candidate) => {
    if (!writable) return;
    setCandidate(next);
    setUndo({ kind: "dates", record: next.record, start: next.record.plannedStartDate, end: next.record.plannedCompletionDate, predecessors: next.record.dependencies.map((edge) => edge.predecessorRecordId) });
    await mutation.mutateAsync(next);
  };
  const predecessorIds = (record: WorkRecord) => record.dependencies.map((edge) => edge.predecessorRecordId);
  const beginDependencyDrag = (next: DependencyDrag) => {
    dependencyDragRef.current = next;
    setDependencyDrag(next);
  };
  const expected = (record: WorkRecord) => ({ recordId: record.id, expectedRevision: record.revision, expectedDependencySetRevision: record.dependencySetRevision });
  const mutateDependency = async (input: MutateWorkRecordDependency, inverse: (updated: WorkRecord[]) => MutateWorkRecordDependency) => {
    if (!writable) return;
    setDependencyCandidate(input);
    try {
      const updated = await workRecordsApi.mutateDependency(companyId, projectId, input);
      setUndo({ kind: "dependency", input: inverse(updated) });
      setDependencyCandidate(null); setError(null); setSelectedEdge(null);
      await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "依赖修改失败；原连线已恢复");
      throw cause;
    }
  };
  const addDependency = (predecessor: WorkRecord, successor: WorkRecord) => mutateDependency({
    operation: "add", predecessorRecordId: predecessor.id, successorRecordId: successor.id, expectedRecords: [expected(successor)],
  }, (updated) => ({ operation: "remove", predecessorRecordId: predecessor.id, successorRecordId: successor.id, expectedRecords: [expected(updated[0])] }));
  const removeDependency = (predecessor: WorkRecord, successor: WorkRecord) => mutateDependency({
    operation: "remove", predecessorRecordId: predecessor.id, successorRecordId: successor.id, expectedRecords: [expected(successor)],
  }, (updated) => ({ operation: "add", predecessorRecordId: predecessor.id, successorRecordId: successor.id, expectedRecords: [expected(updated[0])] }));
  const finishDependencyDrag = async (targetId: string) => {
    const operation = dependencyDragRef.current;
    dependencyDragRef.current = null;
    setDependencyDrag(null);
    if (!operation || !writable) return;
    const predecessor = records.find((item) => item.id === operation.predecessorId);
    const successor = records.find((item) => item.id === operation.successorId);
    const target = records.find((item) => item.id === targetId);
    if (!predecessor || !successor || !target) return;
    try {
      if (operation.endpoint === "create") {
        if (target.id === predecessor.id || predecessorIds(target).includes(predecessor.id)) return;
        await addDependency(predecessor, target);
      } else if (operation.endpoint === "source") {
        if (target.id === successor.id || target.id === predecessor.id) return;
        await mutateDependency({ operation: "replace_source", predecessorRecordId: predecessor.id, successorRecordId: successor.id,
          replacementPredecessorRecordId: target.id, expectedRecords: [expected(successor)] },
        (updated) => ({ operation: "replace_source", predecessorRecordId: target.id, successorRecordId: successor.id,
          replacementPredecessorRecordId: predecessor.id, expectedRecords: [expected(updated[0])] }));
      } else {
        if (target.id === predecessor.id || target.id === successor.id || predecessorIds(target).includes(predecessor.id)) return;
        await mutateDependency({ operation: "replace_target", predecessorRecordId: predecessor.id, successorRecordId: successor.id,
          replacementSuccessorRecordId: target.id, expectedRecords: [expected(successor), expected(target)] },
        (updated) => ({ operation: "replace_target", predecessorRecordId: predecessor.id, successorRecordId: target.id,
          replacementSuccessorRecordId: successor.id, expectedRecords: updated.map(expected) }));
      }
      setSelectedEdge(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "依赖改连失败；原连线已恢复");
    }
  };
  const adjust = (record: WorkRecord, mode: "move" | "start" | "end", amount: number) => {
    if (!writable || !record.plannedStartDate || !record.plannedCompletionDate) return;
    const start = mode === "end" ? record.plannedStartDate : shiftGanttDate(record.plannedStartDate, amount);
    const end = mode === "start" ? record.plannedCompletionDate : shiftGanttDate(record.plannedCompletionDate, amount);
    if (start <= end) void save({ record, start, end });
  };
  const beginDrag = (event: React.PointerEvent<HTMLElement>, record: WorkRecord, mode: Drag["mode"]) => {
    if (!writable) return;
    const timeline = event.currentTarget.closest<HTMLElement>("[data-gantt-timeline]");
    const rect = timeline?.getBoundingClientRect();
    const pixelsPerDay = Math.max(1, (rect?.width ?? days * 24) / days);
    const anchorDay = minDay + Math.max(0, Math.min(days - 1, Math.floor((event.clientX - (rect?.left ?? 0)) / pixelsPerDay)));
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = { record, mode, originX: event.clientX, currentX: event.clientX, anchorDay, pixelsPerDay };
    suppressDragClickRef.current = false;
    dragRef.current = next;
    setDrag(next);
  };
  const finishDrag = () => {
    const activeDrag = dragRef.current;
    if (!activeDrag) return;
    const next = dragDates(activeDrag);
    dragRef.current = null;
    setDrag(null);
    window.setTimeout(() => { suppressDragClickRef.current = false; }, 0);
    if (!next || next.delta === 0 || next.start > next.end) return;
    void save({ record: activeDrag.record, start: next.start, end: next.end });
  };
  const toggleFocus = () => {
    if (!focus) scrollAnchorRef.current = scrollRef.current?.scrollTop ?? 0;
    setFocus((value) => !value);
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollAnchorRef.current; });
  };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dependencyDrag) { event.preventDefault(); dependencyDragRef.current = null; setDependencyDrag(null); }
      else if (drag) { event.preventDefault(); dragRef.current = null; suppressDragClickRef.current = true; setDrag(null); }
      else if (focus) { event.preventDefault(); toggleFocus(); }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  });

  return <section className={focus ? "fixed inset-0 z-50 overflow-auto bg-background p-4" : "rounded-lg border bg-card"} data-testid="work-record-gantt">
    <div className="flex min-h-11 items-center justify-between gap-2 border-b px-3">
      <div><h3 className="font-semibold">计划甘特</h3><p className="text-xs text-muted-foreground">拖空轨建日期；拖条体移动，拖两端缩放。</p></div>
      <div className="flex gap-1">
        <details className="relative"><summary className="flex h-8 cursor-pointer list-none items-center rounded-md border px-2 text-sm">字段</summary><div className="absolute right-0 z-30 mt-1 w-80 space-y-2 rounded-md border bg-popover p-3 shadow-lg"><select aria-label="甘特字段视图" className="h-8 w-full rounded border bg-background px-2" value={viewId} onChange={(event) => { const next = (views.data ?? []).find((item) => item.id === event.target.value); if (next) { setViewId(next.id); setViewConfig(structuredClone(next.config)); } }}>{(views.data ?? [{ id: "builtin:gantt", name: "甘特默认" }]).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="甘特行密度" className="h-8 w-full rounded border bg-background px-2" value={viewConfig.density} onChange={(event) => changeView((next) => { next.density = event.target.value as WorkRecordViewConfig["density"]; })}><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="spacious">宽松</option></select>{viewConfig.columnOrder.map((field) => <div key={field} className="flex items-center gap-1 text-sm"><label className="flex flex-1 items-center gap-2"><input type="checkbox" checked={viewConfig.visibleFields.includes(field)} disabled={field === "title"} onChange={(event) => changeView((next) => { next.visibleFields = event.target.checked ? [...next.visibleFields, field] : next.visibleFields.filter((item) => item !== field); })} />{GANTT_LABELS[field]}</label><Button size="icon-sm" variant="ghost" aria-label={`${GANTT_LABELS[field]}左移`} onClick={() => changeView((next) => { const i = next.columnOrder.indexOf(field); if (i > 0) [next.columnOrder[i - 1], next.columnOrder[i]] = [next.columnOrder[i], next.columnOrder[i - 1]]; })}>←</Button><Button size="icon-sm" variant="ghost" aria-label={`${GANTT_LABELS[field]}右移`} onClick={() => changeView((next) => { const i = next.columnOrder.indexOf(field); if (i < next.columnOrder.length - 1) [next.columnOrder[i + 1], next.columnOrder[i]] = [next.columnOrder[i], next.columnOrder[i + 1]]; })}>→</Button><input aria-label={`${GANTT_LABELS[field]}列宽`} type="number" min="64" max="1200" className="h-8 w-16 rounded border bg-background px-1" value={viewConfig.columnWidths[field] ?? (field === "title" ? 220 : 104)} onChange={(event) => changeView((next) => { next.columnWidths[field] = Number(event.target.value); })} /></div>)}<Button size="sm" className="w-full" disabled={saveView.isPending} onClick={() => saveView.mutate()}>{activeView?.isBuiltin === false ? "保存字段配置" : "另存字段配置"}</Button>{saveView.error ? <p role="alert" className="text-xs text-destructive">字段配置保存失败：{saveView.error.message}</p> : null}</div></details>
        <Button size="sm" variant="outline" disabled={!undo || mutation.isPending || !writable} onClick={() => { if (!undo) return; if (undo.kind === "dates") void mutation.mutateAsync({ record: records.find((item) => item.id === undo.record.id) ?? undo.record, start: undo.start, end: undo.end, predecessors: undo.predecessors }).then(() => setUndo(null)); else void workRecordsApi.mutateDependency(companyId, projectId, undo.input).then(async () => { setUndo(null); setError(null); await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); }).catch((cause) => setError(cause instanceof Error ? cause.message : "撤销失败；请打开详情对比")); }}><RotateCcw className="size-4" />撤销</Button>
        <Button size="sm" variant="outline" aria-pressed={focus} onClick={toggleFocus}>{focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}{focus ? "退出专注" : "专注"}</Button>
      </div>
    </div>
    {error ? <div role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive"><span>{error}；候选修改已保留。</span><Button size="sm" variant="outline" disabled={(!candidate && !dependencyCandidate) || mutation.isPending} onClick={() => { if (candidate) void save(candidate); else if (dependencyCandidate) void workRecordsApi.mutateDependency(companyId, projectId, dependencyCandidate).then(async () => { setDependencyCandidate(null); setError(null); await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); }); }}>重试</Button></div> : null}
    <div ref={scrollRef} className="overflow-auto">
      <div className="relative grid" style={{ gridTemplateColumns: `${labelWidth}px minmax(${days * 32}px, 1fr)`, minWidth: labelWidth + days * 32 }} onPointerMove={(event) => { if (!dragRef.current) return; const next = { ...dragRef.current, currentX: event.clientX }; suppressDragClickRef.current ||= Math.abs(next.currentX - next.originX) > 2; dragRef.current = next; setDrag(next); }} onPointerUp={finishDrag} onPointerCancel={() => { dragRef.current = null; dependencyDragRef.current = null; suppressDragClickRef.current = false; setDrag(null); setDependencyDrag(null); }}>
        <div className="flex border-b border-r bg-muted/30 text-xs font-medium">{columns.map((field) => <span key={field} className="truncate border-r px-2 py-2" style={{ width: viewConfig.columnWidths[field] ?? (field === "title" ? 220 : 104) }}>{GANTT_LABELS[field]}</span>)}</div>
        <div className="grid border-b bg-muted/30" style={{ gridTemplateColumns: `repeat(${days}, minmax(32px, 1fr))` }}>{Array.from({ length: days }, (_, i) => <span key={i} className="border-r px-1 py-2 text-center text-xs text-muted-foreground">{ganttFromDay(minDay + i).slice(5)}</span>)}</div>
        {records.map((record) => {
          const shownStart = drag?.record.id === record.id && preview ? preview.start : record.plannedStartDate;
          const shownEnd = drag?.record.id === record.id && preview ? preview.end : record.plannedCompletionDate;
          const start = shownStart ? ganttToDay(shownStart) - minDay : 0;
          const end = shownEnd ? ganttToDay(shownEnd) - minDay : start;
          return <div key={record.id} className="contents">
            <button className="flex truncate border-b border-r text-left text-sm hover:bg-muted/50" onClick={(event) => { setSelectedId(record.id); onOpen(record, event.currentTarget); }}>{columns.map((field) => <span key={field} className="truncate border-r px-2 py-2" style={{ width: viewConfig.columnWidths[field] ?? (field === "title" ? 220 : 104) }} title={ganttValue(record, field, agentNames)}>{ganttValue(record, field, agentNames)}</span>)}</button>
            <div data-gantt-timeline={record.id} className="relative grid min-h-10 border-b" style={{ gridTemplateColumns: `repeat(${days}, minmax(32px, 1fr))` }} onPointerUp={() => void finishDependencyDrag(record.id)}>
              {Array.from({ length: days }, (_, i) => <span key={i} className="border-r" />)}
              {shownStart && shownEnd ? <div role="button" tabIndex={0} aria-disabled={!writable} aria-label={`${record.title}，${shownStart} 至 ${shownEnd}`} className="absolute top-2 z-20 flex h-6 items-center rounded bg-primary text-primary-foreground shadow-sm" style={{ left: `${start / days * 100}%`, width: `${Math.max(1, end - start + 1) / days * 100}%`, opacity: drag?.record.id === record.id ? 0.7 : 1 }} onClick={(event) => { if (suppressDragClickRef.current) { suppressDragClickRef.current = false; return; } if (!drag) { setSelectedId(record.id); onOpen(record, event.currentTarget); } }} onKeyDown={(event) => { const amount = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") { event.preventDefault(); adjust(record, "move", -amount); } if (event.key === "ArrowRight") { event.preventDefault(); adjust(record, "move", amount); } }} onPointerDown={(event) => beginDrag(event, record, "move")}>
                <span role="button" tabIndex={writable ? 0 : -1} aria-disabled={!writable} aria-label="调整开始日期" className="h-full w-2 cursor-ew-resize border-r border-primary-foreground/40" onKeyDown={(event) => { const n = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") adjust(record, "start", -n); if (event.key === "ArrowRight") adjust(record, "start", n); }} onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, record, "start"); }} />
                <span className="min-w-0 flex-1 truncate px-2 text-xs">{record.title}</span>
                <span role="button" tabIndex={writable ? 0 : -1} aria-disabled={!writable} aria-label="调整完成日期" className="h-full w-2 cursor-ew-resize border-l border-primary-foreground/40" onKeyDown={(event) => { const n = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") adjust(record, "end", -n); if (event.key === "ArrowRight") adjust(record, "end", n); }} onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, record, "end"); }} />
                <span role="button" tabIndex={writable ? 0 : -1} aria-disabled={!writable} aria-label={`从 ${record.title} 建立依赖`} className="absolute -right-4 top-1 size-4 rounded-full border bg-background text-foreground" onPointerDown={(event) => { event.stopPropagation(); beginDependencyDrag({ predecessorId: record.id, successorId: record.id, endpoint: "create" }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); beginDependencyDrag({ predecessorId: record.id, successorId: record.id, endpoint: "create" }); } }} />
              </div> : <button disabled={!writable} aria-label={`${record.title} 空日期轨道`} className="absolute inset-1 rounded border border-dashed text-xs text-muted-foreground hover:bg-muted/50" onClick={(event) => { if (suppressDragClickRef.current) { suppressDragClickRef.current = false; return; } if (!drag) { setSelectedId(record.id); onOpen(record, event.currentTarget); } }} onPointerDown={(event) => beginDrag(event, record, "create")} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setSelectedId(record.id); onOpen(record, event.currentTarget); } }}>拖动建立日期（Enter：精确编辑）</button>}
            </div>
          </div>;
        })}
        <svg aria-label="依赖连线层" className="pointer-events-none absolute right-0 top-9 z-10 overflow-visible" style={{ left: labelWidth, height: records.length * 40, width: `calc(100% - ${labelWidth}px)` }} viewBox={`0 0 1000 ${Math.max(1, records.length * 40)}`} preserveAspectRatio="none">
          <defs><marker id="gantt-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="fill-foreground" /></marker></defs>
          {records.flatMap((successor, successorIndex) => successor.dependencies.map((edge) => {
            const predecessorIndex = records.findIndex((item) => item.id === edge.predecessorRecordId);
            const predecessor = records[predecessorIndex];
            if (!predecessor) return null;
            const x1 = predecessor.plannedCompletionDate ? Math.max(0, Math.min(1000, ((ganttToDay(predecessor.plannedCompletionDate) - minDay + 1) / days) * 1000)) : 940;
            const x2 = successor.plannedStartDate ? Math.max(0, Math.min(1000, ((ganttToDay(successor.plannedStartDate) - minDay) / days) * 1000)) : 60;
            const y1 = predecessorIndex * 40 + 20; const y2 = successorIndex * 40 + 20; const bend = x1 + Math.max(20, (x2 - x1) / 2);
            const active = selectedEdge?.predecessorId === predecessor.id && selectedEdge.successorId === successor.id;
            return <g key={`${predecessor.id}:${successor.id}`}>
              <path d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`} fill="none" markerEnd="url(#gantt-arrow)" className="pointer-events-auto cursor-pointer stroke-foreground" style={{ strokeWidth: active ? 3 : 2 }} vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={`${predecessor.title} 到 ${successor.title} 的依赖线`} onClick={() => { setSelectedEdge({ predecessorId: predecessor.id, successorId: successor.id }); setSelectedId(successor.id); }} onDoubleClick={(event) => onOpen(successor, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) onOpen(successor, event.currentTarget); else if (event.key === "Enter") { setSelectedEdge({ predecessorId: predecessor.id, successorId: successor.id }); setSelectedId(successor.id); } if (event.key === "Delete") void removeDependency(predecessor, successor); }} />
              {active ? <><circle cx={x1} cy={y1} r="8" className="pointer-events-auto cursor-ew-resize fill-background stroke-foreground" tabIndex={0} role="button" aria-label="拖动依赖源端改连" onPointerDown={() => beginDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "source" })} onKeyDown={(event) => { if (event.key === "Enter") beginDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "source" }); }} /><circle cx={x2} cy={y2} r="8" className="pointer-events-auto cursor-ew-resize fill-background stroke-foreground" tabIndex={0} role="button" aria-label="拖动依赖目标端改连" onPointerDown={() => beginDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "target" })} onKeyDown={(event) => { if (event.key === "Enter") beginDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "target" }); }} /></> : null}
            </g>;
          }))}
        </svg>
      </div>
    </div>
    {selected ? <div className="flex flex-wrap items-end gap-2 border-t p-3" data-testid="gantt-dependency-editor">
      <label className="text-xs font-medium">为「{selected.title}」添加前置<select aria-label="选择新前置" disabled={!writable} className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" value={dependencyTarget} onChange={(event) => setDependencyTarget(event.target.value)}><option value="">选择记录</option>{records.filter((item) => item.id !== selected.id && !predecessors.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <Button size="sm" disabled={!dependencyTarget || !writable} onClick={() => { const predecessor = records.find((item) => item.id === dependencyTarget); if (predecessor) void addDependency(predecessor, selected).then(() => setDependencyTarget("")); }}>建立依赖</Button>
      {selected.dependencies.map((edge) => { const predecessor = records.find((item) => item.id === edge.predecessorRecordId); return <div key={edge.predecessorRecordId} className="flex items-end gap-1"><label className="text-xs">改连：{predecessor?.title ?? edge.predecessorRecordId}<select aria-label={`改连 ${edge.predecessorRecordId}`} disabled={!writable} className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" defaultValue="" onChange={(event) => { const target = records.find((item) => item.id === event.target.value); if (target && predecessor) void mutateDependency({ operation: "replace_source", predecessorRecordId: predecessor.id, successorRecordId: selected.id, replacementPredecessorRecordId: target.id, expectedRecords: [expected(selected)] }, (updated) => ({ operation: "replace_source", predecessorRecordId: target.id, successorRecordId: selected.id, replacementPredecessorRecordId: predecessor.id, expectedRecords: [expected(updated[0])] })); }}><option value="">选择新前置</option>{records.filter((item) => item.id !== selected.id && !predecessors.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><Button disabled={!writable || !predecessor} size="sm" variant="outline" onClick={() => predecessor && void removeDependency(predecessor, selected)}>删除依赖</Button></div>; })}
    </div> : null}
  </section>;
}
