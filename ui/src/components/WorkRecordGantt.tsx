import { useMemo, useRef, useState } from "react";
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

type Undo = { record: WorkRecord; start: string | null; end: string | null; predecessors: string[] };
type Drag = { record: WorkRecord; mode: "create" | "move" | "start" | "end"; originX: number; start: string | null; end: string | null };

export function WorkRecordGantt({ companyId, projectId, records, writable, onOpen }: {
  companyId: string;
  projectId: string;
  records: WorkRecord[];
  writable: boolean;
  onOpen: (record: WorkRecord, source: HTMLElement) => void;
}) {
  const client = useQueryClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dependencyTarget, setDependencyTarget] = useState("");
  const dates = records.flatMap((record) => [record.plannedStartDate, record.plannedCompletionDate]).filter(Boolean) as string[];
  const today = new Date().toISOString().slice(0, 10);
  const minDay = dates.length ? Math.min(...dates.map(ganttToDay)) - 2 : ganttToDay(today) - 2;
  const maxDay = dates.length ? Math.max(...dates.map(ganttToDay)) + 2 : minDay + 13;
  const days = Math.max(14, maxDay - minDay + 1);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const predecessors = useMemo(() => new Set(selected?.dependencies.map((item) => item.predecessorRecordId) ?? []), [selected]);
  const mutation = useMutation({
    mutationFn: ({ record, start, end, predecessorRecordIds }: { record: WorkRecord; start?: string | null; end?: string | null; predecessorRecordIds?: string[] }) =>
      workRecordsApi.update(companyId, projectId, record.id, {
        expectedRevision: record.revision,
        ...(start !== undefined ? { plannedStartDate: start } : {}),
        ...(end !== undefined ? { plannedCompletionDate: end } : {}),
        ...(predecessorRecordIds !== undefined ? { predecessorRecordIds } : {}),
      }),
    onSuccess: async () => { setError(null); await client.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "保存失败；可重试或撤销。"),
  });
  const save = async (record: WorkRecord, next: { start?: string | null; end?: string | null; predecessors?: string[] }) => {
    setUndo({ record, start: record.plannedStartDate, end: record.plannedCompletionDate, predecessors: record.dependencies.map((item) => item.predecessorRecordId) });
    await mutation.mutateAsync({ record, start: next.start, end: next.end, predecessorRecordIds: next.predecessors });
  };
  const adjust = (record: WorkRecord, mode: "move" | "start" | "end", amount: number) => {
    if (!record.plannedStartDate || !record.plannedCompletionDate) return;
    const start = mode === "end" ? record.plannedStartDate : shiftGanttDate(record.plannedStartDate, amount);
    const end = mode === "start" ? record.plannedCompletionDate : shiftGanttDate(record.plannedCompletionDate, amount);
    if (start > end) return;
    void save(record, { start, end });
  };
  const pointerUp = (event: React.PointerEvent) => {
    if (!drag) return;
    const delta = Math.round((event.clientX - drag.originX) / Math.max(24, hostRef.current?.clientWidth ? hostRef.current.clientWidth / days : 48));
    setDrag(null);
    if (delta === 0 && drag.mode !== "create") return;
    if (drag.mode === "create") {
      const start = ganttFromDay(minDay + Math.min(0, delta));
      const end = ganttFromDay(minDay + Math.max(0, delta));
      void save(drag.record, { start, end });
      return;
    }
    if (!drag.start || !drag.end) return;
    const start = drag.mode === "end" ? drag.start : shiftGanttDate(drag.start, delta);
    const end = drag.mode === "start" ? drag.end : shiftGanttDate(drag.end, delta);
    if (start <= end) void save(drag.record, { start, end });
  };

  return <section className={focus ? "fixed inset-0 z-50 overflow-auto bg-background p-4" : "rounded-lg border bg-card"} data-testid="work-record-gantt">
    <div className="flex min-h-11 items-center justify-between gap-2 border-b px-3">
      <div><h3 className="font-semibold">计划甘特</h3><p className="text-xs text-muted-foreground">拖空轨建日期；拖条体移动，拖两端缩放。</p></div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={!undo || mutation.isPending} onClick={() => undo && void mutation.mutateAsync({ record: records.find((item) => item.id === undo.record.id) ?? undo.record, start: undo.start, end: undo.end, predecessorRecordIds: undo.predecessors }).then(() => setUndo(null))}><RotateCcw className="size-4" />撤销</Button>
        <Button size="sm" variant="outline" aria-pressed={focus} onClick={() => setFocus((value) => !value)}>{focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}{focus ? "退出专注" : "专注"}</Button>
      </div>
    </div>
    {error ? <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
    <div className="grid min-w-(--sz-720px)" style={{ gridTemplateColumns: "var(--sz-220px) 1fr" }} ref={hostRef} onPointerUp={pointerUp} onPointerCancel={() => setDrag(null)}>
      <div className="border-b border-r bg-muted/30 px-3 py-2 text-xs font-medium">标题</div>
      <div className="grid border-b bg-muted/30" style={{ gridTemplateColumns: `repeat(${days}, minmax(var(--sz-24px), 1fr))` }}>{Array.from({ length: days }, (_, i) => <span key={i} className="border-r px-1 py-2 text-center text-xs text-muted-foreground">{ganttFromDay(minDay + i).slice(5)}</span>)}</div>
      {records.map((record) => {
        const start = record.plannedStartDate ? ganttToDay(record.plannedStartDate) - minDay : 0;
        const end = record.plannedCompletionDate ? ganttToDay(record.plannedCompletionDate) - minDay : start;
        return <div key={record.id} className="contents">
          <button className="truncate border-b border-r px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={(event) => { setSelectedId(record.id); onOpen(record, event.currentTarget); }}>{record.title}</button>
          <div className="relative grid min-h-10 border-b" style={{ gridTemplateColumns: `repeat(${days}, minmax(var(--sz-24px), 1fr))` }}>
            {Array.from({ length: days }, (_, i) => <span key={i} className="border-r" />)}
            {record.plannedStartDate && record.plannedCompletionDate ? <div role="button" tabIndex={0} aria-label={`${record.title}，${record.plannedStartDate} 至 ${record.plannedCompletionDate}`} className="absolute top-2 flex h-6 items-center rounded bg-primary text-primary-foreground shadow-sm" style={{ left: `${start / days * 100}%`, width: `${Math.max(1, end - start + 1) / days * 100}%` }} onClick={(event) => { setSelectedId(record.id); onOpen(record, event.currentTarget); }} onKeyDown={(event) => { if (event.altKey && event.key === "ArrowLeft") adjust(record, "move", -1); if (event.altKey && event.key === "ArrowRight") adjust(record, "move", 1); }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ record, mode: "move", originX: event.clientX, start: record.plannedStartDate, end: record.plannedCompletionDate }); }}>
              <button aria-label="缩短或延长开始日期" className="h-full w-2 cursor-ew-resize border-r border-primary-foreground/40" onPointerDown={(event) => { event.stopPropagation(); setDrag({ record, mode: "start", originX: event.clientX, start: record.plannedStartDate, end: record.plannedCompletionDate }); }} />
              <span className="min-w-0 flex-1 truncate px-2 text-xs">{record.title}</span>
              <button aria-label="缩短或延长完成日期" className="h-full w-2 cursor-ew-resize border-l border-primary-foreground/40" onPointerDown={(event) => { event.stopPropagation(); setDrag({ record, mode: "end", originX: event.clientX, start: record.plannedStartDate, end: record.plannedCompletionDate }); }} />
            </div> : <button disabled={!writable} className="absolute inset-1 rounded border border-dashed text-xs text-muted-foreground hover:bg-muted/50" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ record, mode: "create", originX: event.clientX, start: null, end: null }); }} onKeyDown={(event) => { if (event.key === "Enter") void save(record, { start: today, end: today }); }}>拖动建立日期（Enter：今天）</button>}
          </div>
        </div>;
      })}
    </div>
    {selected ? <div className="flex flex-wrap items-end gap-2 border-t p-3" data-testid="gantt-dependency-editor">
      <label className="text-xs font-medium">为「{selected.title}」添加前置<select className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" value={dependencyTarget} onChange={(event) => setDependencyTarget(event.target.value)}><option value="">选择记录</option>{records.filter((item) => item.id !== selected.id && !predecessors.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <Button size="sm" disabled={!dependencyTarget || !writable} onClick={() => void save(selected, { predecessors: [...predecessors, dependencyTarget] }).then(() => setDependencyTarget(""))}>建立依赖</Button>
      {selected.dependencies.map((edge) => <Button key={edge.predecessorRecordId} size="sm" variant="outline" onClick={() => void save(selected, { predecessors: [...predecessors].filter((id) => id !== edge.predecessorRecordId) })}>删除：{records.find((item) => item.id === edge.predecessorRecordId)?.title ?? edge.predecessorRecordId}</Button>)}
    </div> : null}
  </section>;
}
