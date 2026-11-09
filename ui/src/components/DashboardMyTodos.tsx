import { useDeferredValue, useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "@/api/projects";
import { workRecordsApi } from "@/api/work-records";
import { DEFAULT_MY_TODO_VIEW_CONFIG, MY_TODO_OPTIONAL_FIELDS, type MyTodoOptionalField, type MyTodoViewConfig, type WorkRecordBusinessStatus, type WorkRecordKind, type WorkRecordMyTodo, type WorkRecordUserRole } from "@paperclipai/shared";

const STATUSES: Array<{ value: WorkRecordBusinessStatus; label: string }> = [
  { value: "backlog", label: "待规划" }, { value: "todo", label: "待办" }, { value: "in_progress", label: "进行中" },
  { value: "in_review", label: "审查中" }, { value: "blocked", label: "受阻" }, { value: "done", label: "已完成" }, { value: "cancelled", label: "已取消" },
];
const FIELD_LABELS: Record<MyTodoOptionalField, string> = { project: "项目", roles: "责任", status: "状态", due: "计划完成" };
const FIELD_WIDTHS: Record<MyTodoOptionalField, string> = { project: "minmax(5rem,10rem)", roles: "minmax(4rem,7rem)", status: "6rem", due: "6.5rem" };
const ROLE_LABELS: Record<WorkRecordUserRole, string> = { execution: "执行", qa: "QA", po: "验收" };
const statusLabel = (status: WorkRecordBusinessStatus) => STATUSES.find((item) => item.value === status)?.label ?? status;

function fieldValue(item: WorkRecordMyTodo, field: MyTodoOptionalField) {
  if (field === "project") return item.projectName;
  if (field === "roles") return item.roles.map((role) => ROLE_LABELS[role]).join("/");
  if (field === "due") return item.plannedCompletionDate ?? "未排期";
  if (item.executionState === "active") return <span className="inline-flex items-center gap-1 text-primary"><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />执行中</span>;
  return item.executionState === "unknown" ? "状态未知" : statusLabel(item.businessStatus);
}

function TodoGroup({ companyId, kind, projectId, q, dueBefore, sort, config }: {
  companyId: string; kind: WorkRecordKind; projectId: string; q: string; dueBefore: string; sort: "updated" | "due"; config: MyTodoViewConfig;
}) {
  const [status, setStatus] = useState<WorkRecordBusinessStatus | "all" | "">("");
  const query = useInfiniteQuery({
    queryKey: ["work-record-my-todos", companyId, kind, projectId, q, dueBefore, sort, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => workRecordsApi.myTodos(companyId, { kind, status: status || undefined, projectId: projectId || undefined, q: q || undefined, dueBefore: dueBefore || undefined, sort, cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const label = kind === "plan" ? "任务" : "缺陷";
  const fields = config.columnOrder.filter((field) => config.visibleFields.includes(field));
  const gridTemplateColumns = ["minmax(0,1fr)", ...fields.map((field) => FIELD_WIDTHS[field])].join(" ");
  return <section className="min-w-0 overflow-hidden rounded-lg border" data-testid={`my-todos-${kind}`}>
    <div className="flex min-h-11 items-center justify-between gap-3 border-b bg-muted/30 px-3">
      <h3 className="font-semibold">{label} <span className="ml-1 text-xs font-normal text-muted-foreground">{items.length}{query.hasNextPage ? "+" : ""}</span></h3>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">状态
        <select aria-label={`${label}状态`} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="">未完成</option><option value="all">全部</option>{STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
    </div>
    <div className="max-h-[min(62vh,760px)] overflow-auto">
      {query.isPending ? <p className="px-3 py-4 text-sm text-muted-foreground">正在读取{label}…</p>
        : query.isError ? <div role="alert" className="flex items-center gap-3 px-3 py-4 text-sm text-destructive">读取{label}失败，执行状态未知。<button className="underline" onClick={() => void query.refetch()}>重试</button></div>
          : items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">当前没有需要你处理的{label}。</p>
            : <ul className="divide-y">{items.map((item) => <li key={item.id}>
              <Link to={`/projects/${item.projectId}/${kind === "plan" ? "plans" : "defects"}?record=${encodeURIComponent(item.id)}`}
                className={`flex flex-col justify-center gap-0.5 px-3 text-sm text-foreground no-underline hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:grid sm:gap-x-3 ${config.density === "compact" ? "min-h-10 py-1" : "min-h-14 py-2"}`}
                style={{ gridTemplateColumns }} aria-label={`查看${label} ${item.title}`}>
                <span className="min-w-0 truncate font-medium" title={item.title}>{item.title}</span>
                {fields.map((field) => <span key={field} className="hidden truncate text-xs text-muted-foreground sm:block">{fieldValue(item, field)}</span>)}
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground sm:hidden">{fields.map((field) => <span key={field}>{FIELD_LABELS[field]}：{fieldValue(item, field)}</span>)}</span>
              </Link>
            </li>)}</ul>}
    </div>
    {query.hasNextPage && <div className="border-t px-3 py-2"><button className="text-sm text-primary underline disabled:opacity-50" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "加载中…" : "加载更多"}</button></div>}
  </section>;
}

export function DashboardMyTodos({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [dueBefore, setDueBefore] = useState("");
  const [sort, setSort] = useState<"updated" | "due">("due");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<MyTodoViewConfig | null>(null);
  const q = useDeferredValue(search.trim());
  const preferenceKey = ["my-todo-preference", companyId];
  const preference = useQuery({ queryKey: preferenceKey, queryFn: () => workRecordsApi.myTodoPreference(companyId) });
  const projects = useQuery({ queryKey: ["my-todos-projects", companyId], queryFn: () => projectsApi.list(companyId, { includeArchived: true }) });
  const config = preference.data?.config ?? DEFAULT_MY_TODO_VIEW_CONFIG;
  useEffect(() => {
    setProjectId(preference.data?.config.defaultProjectId ?? "");
    setSort(preference.data?.config.sort ?? "due");
    setSettingsOpen(false);
    setSettingsDraft(null);
  }, [companyId, preference.data?.revision]);
  const savePreference = useMutation({
    mutationFn: (next: MyTodoViewConfig) => workRecordsApi.putMyTodoPreference(companyId, { expectedRevision: preference.data?.revision ?? 0, config: next }),
    onSuccess: (saved) => {
      queryClient.setQueryData(preferenceKey, saved);
      setProjectId(saved.config.defaultProjectId ?? "");
      setSort(saved.config.sort);
      setSettingsOpen(false);
      setSettingsDraft(null);
    },
  });
  const updateDraft = (patch: Partial<MyTodoViewConfig>) => setSettingsDraft((current) => ({ ...(current ?? config), ...patch }));
  const moveField = (field: MyTodoOptionalField, direction: -1 | 1) => {
    const order = [...(settingsDraft ?? config).columnOrder];
    const current = order.indexOf(field);
    const target = current + direction;
    if (target < 0 || target >= order.length) return;
    [order[current], order[target]] = [order[target], order[current]];
    updateDraft({ columnOrder: order });
  };
  return <div className="min-w-0 space-y-3" data-testid="dashboard-my-todos">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-lg font-semibold">我的待办</h2><p className="text-sm text-muted-foreground">只显示明确交给你处理的任务和缺陷；保存记录不会自动派发 Agent。</p></div>
      <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent" aria-expanded={settingsOpen} onClick={() => { setSettingsDraft({ ...config, visibleFields: [...config.visibleFields], columnOrder: [...config.columnOrder] }); setSettingsOpen((open) => !open); savePreference.reset(); }}>编辑视图</button>
    </div>
    {preference.isError ? <p role="alert" className="text-sm text-destructive">个人视图读取失败，当前使用默认显示。刷新后再编辑。</p> : null}
    {settingsOpen && settingsDraft ? <section className="space-y-3 rounded-lg border p-3" data-testid="my-todo-settings">
      <h3 className="font-semibold">个人待办视图</h3>
      <p className="text-xs text-muted-foreground">只保存给当前登录用户；标题始终显示。上下移动可调整字段顺序。</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">行密度 <select aria-label="行密度" className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.density} onChange={(event) => updateDraft({ density: event.target.value as MyTodoViewConfig["density"] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></label>
        <label className="text-sm">默认排序 <select aria-label="默认排序" className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.sort} onChange={(event) => updateDraft({ sort: event.target.value as MyTodoViewConfig["sort"] })}><option value="due">按截止日期</option><option value="updated">按最近更新</option></select></label>
        <label className="text-sm sm:col-span-2">默认项目 <select aria-label="默认项目" className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.defaultProjectId ?? ""} onChange={(event) => updateDraft({ defaultProjectId: event.target.value || null })}><option value="">全部项目</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      </div>
      <div role="group" aria-label="显示字段" className="space-y-1">{settingsDraft.columnOrder.map((field, index) => <div key={field} className="flex items-center gap-2 text-sm">
        <label className="flex min-w-28 items-center gap-2"><input type="checkbox" checked={settingsDraft.visibleFields.includes(field)} onChange={(event) => updateDraft({ visibleFields: event.target.checked ? [...settingsDraft.visibleFields, field] : settingsDraft.visibleFields.filter((item) => item !== field) })} />{FIELD_LABELS[field]}</label>
        <button aria-label={`${FIELD_LABELS[field]}上移`} className="rounded border px-2 disabled:opacity-40" disabled={index === 0} onClick={() => moveField(field, -1)}>↑</button>
        <button aria-label={`${FIELD_LABELS[field]}下移`} className="rounded border px-2 disabled:opacity-40" disabled={index === settingsDraft.columnOrder.length - 1} onClick={() => moveField(field, 1)}>↓</button>
      </div>)}</div>
      {savePreference.error ? <p role="alert" className="text-sm text-destructive">保存失败：{savePreference.error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={preference.isError || preference.isPending || savePreference.isPending} onClick={() => savePreference.mutate(settingsDraft)}>{savePreference.isPending ? "保存中…" : "保存视图"}</button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => setSettingsDraft({ ...DEFAULT_MY_TODO_VIEW_CONFIG, visibleFields: [...MY_TODO_OPTIONAL_FIELDS], columnOrder: [...MY_TODO_OPTIONAL_FIELDS] })}>恢复默认</button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => { setSettingsOpen(false); setSettingsDraft(null); }}>取消</button>
      </div>
    </section> : null}
    <div className="flex flex-wrap gap-2 rounded-lg border p-2">
      <input aria-label="搜索我的待办" className="h-9 min-w-40 flex-1 rounded-md border bg-background px-3 text-sm" value={search} maxLength={200} placeholder="搜索任务或缺陷" onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="待办项目" className="h-9 rounded-md border bg-background px-2 text-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">全部项目</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">截止至 <input aria-label="待办截止日期" type="date" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={dueBefore} onChange={(event) => setDueBefore(event.target.value)} /></label>
      <select aria-label="待办排序" className="h-9 rounded-md border bg-background px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="due">按截止日期</option><option value="updated">按最近更新</option></select>
    </div>
    <TodoGroup companyId={companyId} kind="plan" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
    <TodoGroup companyId={companyId} kind="defect" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
  </div>;
}
