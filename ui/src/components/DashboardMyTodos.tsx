import { useDeferredValue, useEffect, useState, type CSSProperties } from "react";
import { Bug, ChevronDown, List } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "@/api/projects";
import { workRecordsApi } from "@/api/work-records";
import { ApiError } from "@/api/client";
import { l10n } from "@/i18n";
import { DEFAULT_MY_TODO_VIEW_CONFIG, type MyTodoOptionalField, type MyTodoViewConfig, type WorkRecordBusinessStatus, type WorkRecordKind, type WorkRecordMyTodo, type WorkRecordUserRole } from "@paperclipai/shared";

const STATUSES: Array<{ value: WorkRecordBusinessStatus; labelKey: string }> = [
  { value: "backlog", labelKey: "local.backlog_bf986e9a" }, { value: "todo", labelKey: "local.todo_4ff402d7" },
  { value: "in_progress", labelKey: "local.in_progress_c1f88e9d" }, { value: "in_review", labelKey: "local.in_review_c3905914" },
  { value: "blocked", labelKey: "local.blocked_18f2a094" }, { value: "done", labelKey: "local.done_11a6767d" },
  { value: "cancelled", labelKey: "local.cancelled_d353a99e" },
];
const FIELD_LABEL_KEYS: Record<MyTodoOptionalField, string> = { project: "local.my_todo_field_project", roles: "local.my_todo_field_roles", status: "local.my_todo_field_status", due: "local.my_todo_field_due" };
const FIELD_WIDTHS: Record<MyTodoOptionalField, string> = { project: "minmax(5rem,10rem)", roles: "minmax(4rem,7rem)", status: "100px", due: "140px" };
const NARROW_FIELD_WIDTHS: Record<MyTodoOptionalField, string> = { project: "100px", roles: "80px", status: "90px", due: "125px" };
const ROLE_LABEL_KEYS: Record<WorkRecordUserRole, string> = { execution: "local.my_todo_role_execution", qa: "local.my_todo_role_qa", po: "local.my_todo_role_po" };
const PRIORITY_LABELS: Record<WorkRecordMyTodo["priority"], string> = { critical: "最高", high: "高", medium: "中", low: "低" };
const statusLabel = (status: WorkRecordBusinessStatus) => l10n(STATUSES.find((item) => item.value === status)?.labelKey ?? status);

function fieldValue(item: WorkRecordMyTodo, field: MyTodoOptionalField) {
  if (field === "project") return item.projectName;
  if (field === "roles") return item.roles.map((role) => l10n(ROLE_LABEL_KEYS[role])).join("/");
  if (item.executionState === "active") return <span className="inline-flex items-center gap-1 text-primary"><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />{l10n("local.my_todo_active")}</span>;
  return item.executionState === "unknown" ? l10n("local.my_todo_unknown") : statusLabel(item.businessStatus);
}

function dueValue(item: WorkRecordMyTodo) {
  const date = item.plannedCompletionDate;
  if (!date) return <span className="my-todo-due">{l10n("local.my_todo_unscheduled")}</span>;
  const overdue = !["done", "cancelled"].includes(item.businessStatus) && date < new Date().toISOString().slice(0, 10);
  return <span className={`my-todo-due${overdue ? " is-overdue" : ""}`}>{date}{overdue ? <small>逾期</small> : null}</span>;
}

function statusValue(item: WorkRecordMyTodo) {
  if (item.executionState === "active") return fieldValue(item, "status");
  return <span className="my-todo-status" data-business-status={item.businessStatus}>
    <span>{item.executionState === "unknown" ? l10n("local.my_todo_unknown") : statusLabel(item.businessStatus)}</span>
    <ChevronDown className="size-3" aria-hidden="true" />
  </span>;
}

function TodoGroup({ companyId, kind, projectId, q, dueBefore, sort, config }: {
  companyId: string; kind: WorkRecordKind; projectId: string; q: string; dueBefore: string; sort: "updated" | "due"; config: MyTodoViewConfig;
}) {
  const [status, setStatus] = useState<WorkRecordBusinessStatus | "all" | "">("");
  const [collapsed, setCollapsed] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["work-record-my-todos", companyId, kind, projectId, q, dueBefore, sort, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => workRecordsApi.myTodos(companyId, { kind, status: status || undefined, projectId: projectId || undefined, q: q || undefined, dueBefore: dueBefore || undefined, sort, cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const label = l10n(kind === "plan" ? "local.my_todo_task" : "local.my_todo_defect");
  const fields = config.columnOrder.filter((field) => config.visibleFields.includes(field));
  const gridTemplateColumns = ["66px", "minmax(140px,1fr)", "50px", ...fields.map((field) => FIELD_WIDTHS[field])].join(" ");
  const gridStyle = {
    "--my-todo-grid-template": gridTemplateColumns,
    "--my-todo-grid-template-narrow": ["60px", "minmax(140px,1fr)", ...fields.map((field) => NARROW_FIELD_WIDTHS[field])].join(" "),
  } as CSSProperties;
  const KindIcon = kind === "plan" ? List : Bug;
  return <section className="my-todo-group" data-testid={`my-todos-${kind}`}>
    <div className="my-todo-group-heading">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
        <KindIcon className="size-4" aria-hidden="true" />
        <span>{label}</span>
        <span className="my-todo-count">{items.length}{query.hasNextPage ? "+" : ""}</span>
        <span className="my-todo-fold-mark" aria-hidden="true">{collapsed ? "+" : "−"}</span>
      </button>
      <label>{label}{l10n("local.my_todo_status")}
        <select aria-label={l10n("local.my_todo_status_filter", { kind: kind === "plan" ? l10n("local.my_todo_task") : l10n("local.my_todo_defect") })} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="">{l10n("local.my_todo_unfinished")}</option><option value="all">{l10n("local.my_todo_all")}</option>{STATUSES.map((item) => <option key={item.value} value={item.value}>{l10n(item.labelKey)}</option>)}
        </select>
      </label>
    </div>
    {!collapsed ? <div className="my-todo-group-body">
      {query.isPending ? <p className="px-3 py-4 text-sm text-muted-foreground">{l10n("local.my_todo_loading", { kind: label })}</p>
        : query.isError ? <div role="alert" className="flex items-center gap-3 px-3 py-4 text-sm text-destructive">{l10n("local.my_todo_load_failed", { kind: label })}<button className="underline" onClick={() => void query.refetch()}>{l10n("local.my_todo_retry")}</button></div>
          : items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">{l10n("local.my_todo_empty", { kind: label })}</p>
            : <><div className="my-todo-grid my-todo-columns" style={gridStyle} aria-hidden="true">
              <span>ID</span><span>名称</span><span>优先级</span>{fields.map((field) => <span key={field}>{l10n(FIELD_LABEL_KEYS[field])}</span>)}
            </div><ul>{items.map((item) => <li key={item.id}>
              <Link to={`/projects/${item.projectId}/${kind === "plan" ? "plans" : "defects"}?record=${encodeURIComponent(item.id)}`}
                className={`my-todo-grid my-todo-row text-foreground no-underline hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${config.density === "comfortable" ? "my-todo-row-comfortable" : ""}`}
                style={gridStyle} aria-label={l10n("local.my_todo_open", { kind: label, title: item.title })}>
                <span className="my-todo-id">{item.recordIdentifier}</span>
                <span className="my-todo-title" title={item.title}>{item.title}</span>
                <span className="my-todo-priority">{PRIORITY_LABELS[item.priority]}</span>
                {fields.map((field) => <span key={field} className={`my-todo-field my-todo-field-${field}`}>{field === "due" ? dueValue(item) : field === "status" ? statusValue(item) : fieldValue(item, field)}</span>)}
              </Link>
            </li>)}</ul></>}
    </div> : null}
    {query.hasNextPage && <div className="border-t px-3 py-2"><button className="text-sm text-primary underline disabled:opacity-50" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{l10n(query.isFetchingNextPage ? "local.my_todo_loading_more" : "local.my_todo_load_more")}</button></div>}
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
  return <div className="dashboard-my-todo-workspace" data-testid="dashboard-my-todos">
    <aside className="dashboard-my-todo-rail" aria-label="个人待办导航">
      <h2>个人待办</h2>
      <p>按任务与缺陷分别查看、筛选和处理。</p>
      <strong>我的工作</strong>
      <span>仅显示需要我处理的记录</span>
    </aside>
    <div className="dashboard-my-todo-main">
    <div className="dashboard-my-todo-heading flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-lg font-semibold">{l10n("local.my_todo_title")}</h2><p className="text-sm text-muted-foreground">{l10n("local.my_todo_intro")}</p></div>
      <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent" aria-expanded={settingsOpen} onClick={() => { setSettingsDraft({ ...config, visibleFields: [...config.visibleFields], columnOrder: [...config.columnOrder] }); setSettingsOpen((open) => !open); savePreference.reset(); }}>{l10n("local.my_todo_edit_view")}</button>
    </div>
    {preference.isError ? <p role="alert" className="text-sm text-destructive">{l10n("local.my_todo_preference_load_failed")}</p> : null}
    {settingsOpen && settingsDraft ? <section className="space-y-3 rounded-lg border p-3" data-testid="my-todo-settings">
      <h3 className="font-semibold">{l10n("local.my_todo_view_title")}</h3>
      <p className="text-xs text-muted-foreground">{l10n("local.my_todo_view_help")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{l10n("local.my_todo_density")} <select aria-label={l10n("local.my_todo_density")} className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.density} onChange={(event) => updateDraft({ density: event.target.value as MyTodoViewConfig["density"] })}><option value="compact">{l10n("local.my_todo_density_compact")}</option><option value="comfortable">{l10n("local.my_todo_density_comfortable")}</option></select></label>
        <label className="text-sm">{l10n("local.my_todo_default_sort")} <select aria-label={l10n("local.my_todo_default_sort")} className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.sort} onChange={(event) => updateDraft({ sort: event.target.value as MyTodoViewConfig["sort"] })}><option value="due">{l10n("local.my_todo_sort_due")}</option><option value="updated">{l10n("local.my_todo_sort_updated")}</option></select></label>
        <label className="text-sm sm:col-span-2">{l10n("local.my_todo_default_project")} <select aria-label={l10n("local.my_todo_default_project")} className="ml-2 rounded-md border bg-background p-1" value={settingsDraft.defaultProjectId ?? ""} onChange={(event) => updateDraft({ defaultProjectId: event.target.value || null })}><option value="">{l10n("local.my_todo_all_projects")}</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      </div>
      <div role="group" aria-label={l10n("local.my_todo_visible_fields")} className="space-y-1">{settingsDraft.columnOrder.map((field, index) => <div key={field} className="flex items-center gap-2 text-sm">
        <label className="flex min-w-28 items-center gap-2"><input type="checkbox" checked={settingsDraft.visibleFields.includes(field)} onChange={(event) => updateDraft({ visibleFields: event.target.checked ? [...settingsDraft.visibleFields, field] : settingsDraft.visibleFields.filter((item) => item !== field) })} />{l10n(FIELD_LABEL_KEYS[field])}</label>
        <button aria-label={l10n("local.my_todo_move_up", { field: l10n(FIELD_LABEL_KEYS[field]) })} className="rounded border px-2 disabled:opacity-40" disabled={index === 0} onClick={() => moveField(field, -1)}>↑</button>
        <button aria-label={l10n("local.my_todo_move_down", { field: l10n(FIELD_LABEL_KEYS[field]) })} className="rounded border px-2 disabled:opacity-40" disabled={index === settingsDraft.columnOrder.length - 1} onClick={() => moveField(field, 1)}>↓</button>
      </div>)}</div>
      {savePreference.error ? <p role="alert" className="text-sm text-destructive">{l10n(savePreference.error instanceof ApiError && savePreference.error.status === 409 ? "local.my_todo_save_conflict" : "local.my_todo_save_failed")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={preference.isError || preference.isPending || savePreference.isPending} onClick={() => savePreference.mutate(settingsDraft)}>{l10n(savePreference.isPending ? "local.my_todo_saving" : "local.my_todo_save")}</button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => setSettingsDraft({ ...DEFAULT_MY_TODO_VIEW_CONFIG, visibleFields: [...DEFAULT_MY_TODO_VIEW_CONFIG.visibleFields], columnOrder: [...DEFAULT_MY_TODO_VIEW_CONFIG.columnOrder] })}>{l10n("local.my_todo_restore_defaults")}</button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => { setSettingsOpen(false); setSettingsDraft(null); }}>{l10n("local.my_todo_cancel")}</button>
      </div>
    </section> : null}
    <div className="dashboard-my-todo-filters flex flex-wrap gap-2">
      <input aria-label={l10n("local.my_todo_search")} className="h-9 min-w-40 flex-1 rounded-md border bg-background px-3 text-sm" value={search} maxLength={200} placeholder={l10n("local.my_todo_search_placeholder")} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={l10n("local.my_todo_project_filter")} className="h-9 rounded-md border bg-background px-2 text-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{l10n("local.my_todo_all_projects")}</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">{l10n("local.my_todo_due_before")} <input aria-label={l10n("local.my_todo_due_filter")} type="date" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={dueBefore} onChange={(event) => setDueBefore(event.target.value)} /></label>
      <select aria-label={l10n("local.my_todo_sort_filter")} className="h-9 rounded-md border bg-background px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="due">{l10n("local.my_todo_sort_due")}</option><option value="updated">{l10n("local.my_todo_sort_updated")}</option></select>
    </div>
    <div className="dashboard-my-todo-groups" data-testid="my-todo-groups">
      <TodoGroup companyId={companyId} kind="plan" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
      <TodoGroup companyId={companyId} kind="defect" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
    </div>
    </div>
  </div>;
}
