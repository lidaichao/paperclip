import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkRecord } from "@paperclipai/shared";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";

const DAY = 86_400_000;
export const ganttToDay = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / DAY);
export const ganttFromDay = (value: number) => new Date(value * DAY).toISOString().slice(0, 10);
export const shiftGanttDate = (value: string, days: number) => ganttFromDay(ganttToDay(value) + days);

type Candidate = { record: WorkRecord; start?: string | null; end?: string | null; predecessors?: string[] };
type Undo = { record: WorkRecord; start: string | null; end: string | null; predecessors: string[] };
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

export function WorkRecordGantt({ companyId, projectId, records, writable, onOpen }: {
  companyId: string; projectId: string; records: WorkRecord[]; writable: boolean;
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
  const [dependencyTarget, setDependencyTarget] = useState("");
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [dependencyDrag, setDependencyDrag] = useState<DependencyDrag | null>(null);
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
    setUndo({ record: next.record, start: next.record.plannedStartDate, end: next.record.plannedCompletionDate, predecessors: next.record.dependencies.map((edge) => edge.predecessorRecordId) });
    await mutation.mutateAsync(next);
  };
  const predecessorIds = (record: WorkRecord) => record.dependencies.map((edge) => edge.predecessorRecordId);
  const finishDependencyDrag = async (targetId: string) => {
    const operation = dependencyDrag;
    setDependencyDrag(null);
    if (!operation || !writable) return;
    const predecessor = records.find((item) => item.id === operation.predecessorId);
    const successor = records.find((item) => item.id === operation.successorId);
    const target = records.find((item) => item.id === targetId);
    if (!predecessor || !successor || !target) return;
    try {
      if (operation.endpoint === "create") {
        if (target.id === predecessor.id || predecessorIds(target).includes(predecessor.id)) return;
        await save({ record: target, predecessors: [...predecessorIds(target), predecessor.id] });
      } else if (operation.endpoint === "source") {
        if (target.id === successor.id || target.id === predecessor.id) return;
        await save({ record: successor, predecessors: predecessorIds(successor).map((id) => id === predecessor.id ? target.id : id) });
      } else {
        if (target.id === predecessor.id || target.id === successor.id || predecessorIds(target).includes(predecessor.id)) return;
        const added = await workRecordsApi.update(companyId, projectId, target.id, {
          expectedRevision: target.revision,
          dependencySetRevision: target.dependencySetRevision,
          predecessorRecordIds: [...predecessorIds(target), predecessor.id],
        });
        try {
          await save({ record: successor, predecessors: predecessorIds(successor).filter((id) => id !== predecessor.id) });
        } catch (cause) {
          await workRecordsApi.update(companyId, projectId, added.id, {
            expectedRevision: added.revision,
            dependencySetRevision: added.dependencySetRevision,
            predecessorRecordIds: predecessorIds(target),
          });
          throw cause;
        }
        await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
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
    setDrag({ record, mode, originX: event.clientX, currentX: event.clientX, anchorDay, pixelsPerDay });
  };
  const finishDrag = () => {
    if (!drag) return;
    const next = dragDates(drag);
    setDrag(null);
    if (!next || next.delta === 0 || next.start > next.end) return;
    void save({ record: drag.record, start: next.start, end: next.end });
  };
  const toggleFocus = () => {
    if (!focus) scrollAnchorRef.current = scrollRef.current?.scrollTop ?? 0;
    setFocus((value) => !value);
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollAnchorRef.current; });
  };
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dependencyDrag) { event.preventDefault(); setDependencyDrag(null); }
      else if (drag) { event.preventDefault(); setDrag(null); }
      else if (focus) { event.preventDefault(); toggleFocus(); }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  });

  return <section className={focus ? "fixed inset-0 z-50 overflow-auto bg-background p-4" : "rounded-lg border bg-card"} data-testid="work-record-gantt">
    <div className="flex min-h-11 items-center justify-between gap-2 border-b px-3">
      <div><h3 className="font-semibold">计划甘特</h3><p className="text-xs text-muted-foreground">拖空轨建日期；拖条体移动，拖两端缩放。</p></div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={!undo || mutation.isPending || !writable} onClick={() => undo && void mutation.mutateAsync({ record: records.find((item) => item.id === undo.record.id) ?? undo.record, start: undo.start, end: undo.end, predecessors: undo.predecessors }).then(() => setUndo(null))}><RotateCcw className="size-4" />撤销</Button>
        <Button size="sm" variant="outline" aria-pressed={focus} onClick={toggleFocus}>{focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}{focus ? "退出专注" : "专注"}</Button>
      </div>
    </div>
    {error ? <div role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive"><span>{error}；候选修改已保留。</span><Button size="sm" variant="outline" disabled={!candidate || mutation.isPending} onClick={() => candidate && void save(candidate)}>重试</Button></div> : null}
    <div ref={scrollRef} className="overflow-auto">
      <div className="relative grid min-w-(--sz-720px)" style={{ gridTemplateColumns: "var(--sz-220px) 1fr" }} onPointerMove={(event) => drag && setDrag((value) => value ? { ...value, currentX: event.clientX } : null)} onPointerUp={() => drag && finishDrag()} onPointerCancel={() => { setDrag(null); setDependencyDrag(null); }}>
        <div className="border-b border-r bg-muted/30 px-3 py-2 text-xs font-medium">标题</div>
        <div className="grid border-b bg-muted/30" style={{ gridTemplateColumns: `repeat(${days}, minmax(var(--sz-24px), 1fr))` }}>{Array.from({ length: days }, (_, i) => <span key={i} className="border-r px-1 py-2 text-center text-xs text-muted-foreground">{ganttFromDay(minDay + i).slice(5)}</span>)}</div>
        {records.map((record) => {
          const shownStart = drag?.record.id === record.id && preview ? preview.start : record.plannedStartDate;
          const shownEnd = drag?.record.id === record.id && preview ? preview.end : record.plannedCompletionDate;
          const start = shownStart ? ganttToDay(shownStart) - minDay : 0;
          const end = shownEnd ? ganttToDay(shownEnd) - minDay : start;
          return <div key={record.id} className="contents">
            <button className="truncate border-b border-r px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={(event) => { setSelectedId(record.id); onOpen(record, event.currentTarget); }}>{record.title}</button>
            <div data-gantt-timeline={record.id} className="relative grid min-h-10 border-b" style={{ gridTemplateColumns: `repeat(${days}, minmax(var(--sz-24px), 1fr))` }} onPointerUp={() => dependencyDrag && void finishDependencyDrag(record.id)}>
              {Array.from({ length: days }, (_, i) => <span key={i} className="border-r" />)}
              {shownStart && shownEnd ? <div role="button" tabIndex={0} aria-disabled={!writable} aria-label={`${record.title}，${shownStart} 至 ${shownEnd}`} className="absolute top-2 flex h-6 items-center rounded bg-primary text-primary-foreground shadow-sm" style={{ left: `${start / days * 100}%`, width: `${Math.max(1, end - start + 1) / days * 100}%`, opacity: drag?.record.id === record.id ? 0.7 : 1 }} onClick={(event) => { if (!drag) { setSelectedId(record.id); onOpen(record, event.currentTarget); } }} onKeyDown={(event) => { const amount = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") { event.preventDefault(); adjust(record, "move", -amount); } if (event.key === "ArrowRight") { event.preventDefault(); adjust(record, "move", amount); } }} onPointerDown={(event) => beginDrag(event, record, "move")}>
                <button disabled={!writable} aria-label="调整开始日期" className="h-full w-2 cursor-ew-resize border-r border-primary-foreground/40" onKeyDown={(event) => { const n = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") adjust(record, "start", -n); if (event.key === "ArrowRight") adjust(record, "start", n); }} onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, record, "start"); }} />
                <span className="min-w-0 flex-1 truncate px-2 text-xs">{record.title}</span>
                <button disabled={!writable} aria-label="调整完成日期" className="h-full w-2 cursor-ew-resize border-l border-primary-foreground/40" onKeyDown={(event) => { const n = event.shiftKey ? 7 : 1; if (event.key === "ArrowLeft") adjust(record, "end", -n); if (event.key === "ArrowRight") adjust(record, "end", n); }} onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, record, "end"); }} />
                <button disabled={!writable} aria-label={`从 ${record.title} 建立依赖`} className="absolute -right-2 top-1 size-4 rounded-full border bg-background text-foreground" onPointerDown={(event) => { event.stopPropagation(); setDependencyDrag({ predecessorId: record.id, successorId: record.id, endpoint: "create" }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setDependencyDrag({ predecessorId: record.id, successorId: record.id, endpoint: "create" }); } }} />
              </div> : <button disabled={!writable} aria-label={`${record.title} 空日期轨道`} className="absolute inset-1 rounded border border-dashed text-xs text-muted-foreground hover:bg-muted/50" onClick={(event) => { if (!drag) { setSelectedId(record.id); onOpen(record, event.currentTarget); } }} onPointerDown={(event) => beginDrag(event, record, "create")} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setSelectedId(record.id); onOpen(record, event.currentTarget); } }}>拖动建立日期（Enter：精确编辑）</button>}
            </div>
          </div>;
        })}
        <svg aria-label="依赖连线层" className="pointer-events-none absolute left-(--sz-220px) right-0 top-9 z-10 overflow-visible" style={{ height: records.length * 40, width: "calc(100% - var(--sz-220px))" }} viewBox={`0 0 1000 ${Math.max(1, records.length * 40)}`} preserveAspectRatio="none">
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
              <path d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`} fill="none" markerEnd="url(#gantt-arrow)" className="pointer-events-auto cursor-pointer stroke-foreground" style={{ strokeWidth: active ? 3 : 2 }} vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={`${predecessor.title} 到 ${successor.title} 的依赖线`} onClick={() => { setSelectedEdge({ predecessorId: predecessor.id, successorId: successor.id }); setSelectedId(successor.id); }} onDoubleClick={(event) => onOpen(successor, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) onOpen(successor, event.currentTarget); else if (event.key === "Enter") { setSelectedEdge({ predecessorId: predecessor.id, successorId: successor.id }); setSelectedId(successor.id); } if (event.key === "Delete") void save({ record: successor, predecessors: predecessorIds(successor).filter((id) => id !== predecessor.id) }); }} />
              {active ? <><circle cx={x1} cy={y1} r="8" className="pointer-events-auto cursor-ew-resize fill-background stroke-foreground" tabIndex={0} role="button" aria-label="拖动依赖源端改连" onPointerDown={() => setDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "source" })} onKeyDown={(event) => { if (event.key === "Enter") setDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "source" }); }} /><circle cx={x2} cy={y2} r="8" className="pointer-events-auto cursor-ew-resize fill-background stroke-foreground" tabIndex={0} role="button" aria-label="拖动依赖目标端改连" onPointerDown={() => setDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "target" })} onKeyDown={(event) => { if (event.key === "Enter") setDependencyDrag({ predecessorId: predecessor.id, successorId: successor.id, endpoint: "target" }); }} /></> : null}
            </g>;
          }))}
        </svg>
      </div>
    </div>
    {selected ? <div className="flex flex-wrap items-end gap-2 border-t p-3" data-testid="gantt-dependency-editor">
      <label className="text-xs font-medium">为「{selected.title}」添加前置<select aria-label="选择新前置" disabled={!writable} className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" value={dependencyTarget} onChange={(event) => setDependencyTarget(event.target.value)}><option value="">选择记录</option>{records.filter((item) => item.id !== selected.id && !predecessors.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <Button size="sm" disabled={!dependencyTarget || !writable} onClick={() => void save({ record: selected, predecessors: [...predecessors, dependencyTarget] }).then(() => setDependencyTarget(""))}>建立依赖</Button>
      {selected.dependencies.map((edge) => <div key={edge.predecessorRecordId} className="flex items-end gap-1"><label className="text-xs">改连：{records.find((item) => item.id === edge.predecessorRecordId)?.title ?? edge.predecessorRecordId}<select aria-label={`改连 ${edge.predecessorRecordId}`} disabled={!writable} className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" defaultValue="" onChange={(event) => { const target = event.target.value; if (target) void save({ record: selected, predecessors: [...predecessors].map((id) => id === edge.predecessorRecordId ? target : id) }); }}><option value="">选择新前置</option>{records.filter((item) => item.id !== selected.id && !predecessors.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><Button disabled={!writable} size="sm" variant="outline" onClick={() => void save({ record: selected, predecessors: [...predecessors].filter((id) => id !== edge.predecessorRecordId) })}>删除依赖</Button></div>)}
    </div> : null}
  </section>;
}
