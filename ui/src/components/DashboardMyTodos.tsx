import { useDeferredValue, useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "@/api/projects";
import { workRecordsApi } from "@/api/work-records";
import { ApiError } from "@/api/client";
import { l10n } from "@/i18n";
import { DEFAULT_MY_TODO_VIEW_CONFIG, MY_TODO_OPTIONAL_FIELDS, type MyTodoOptionalField, type MyTodoViewConfig, type WorkRecordBusinessStatus, type WorkRecordKind, type WorkRecordMyTodo, type WorkRecordUserRole } from "@paperclipai/shared";

const STATUSES: Array<{ value: WorkRecordBusinessStatus; labelKey: string }> = [
  { value: "backlog", labelKey: "local.backlog_bf986e9a" }, { value: "todo", labelKey: "local.todo_4ff402d7" },
  { value: "in_progress", labelKey: "local.in_progress_c1f88e9d" }, { value: "in_review", labelKey: "local.in_review_c3905914" },
  { value: "blocked", labelKey: "local.blocked_18f2a094" }, { value: "done", labelKey: "local.done_11a6767d" },
  { value: "cancelled", labelKey: "local.cancelled_d353a99e" },
];
const FIELD_LABEL_KEYS: Record<MyTodoOptionalField, string> = { project: "local.my_todo_field_project", roles: "local.my_todo_field_roles", status: "local.my_todo_field_status", due: "local.my_todo_field_due" };
const FIELD_WIDTHS: Record<MyTodoOptionalField, string> = { project: "minmax(5rem,10rem)", roles: "minmax(4rem,7rem)", status: "6rem", due: "6.5rem" };
const ROLE_LABEL_KEYS: Record<WorkRecordUserRole, string> = { execution: "local.my_todo_role_execution", qa: "local.my_todo_role_qa", po: "local.my_todo_role_po" };
const statusLabel = (status: WorkRecordBusinessStatus) => l10n(STATUSES.find((item) => item.value === status)?.labelKey ?? status);

function fieldValue(item: WorkRecordMyTodo, field: MyTodoOptionalField) {
  if (field === "project") return item.projectName;
  if (field === "roles") return item.roles.map((role) => l10n(ROLE_LABEL_KEYS[role])).join("/");
  if (field === "due") return item.plannedCompletionDate ?? l10n("local.my_todo_unscheduled");
  if (item.executionState === "active") return <span className="inline-flex items-center gap-1 text-primary"><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />{l10n("local.my_todo_active")}</span>;
  return item.executionState === "unknown" ? l10n("local.my_todo_unknown") : statusLabel(item.businessStatus);
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
  const label = l10n(kind === "plan" ? "local.my_todo_task" : "local.my_todo_defect");
  const fields = config.columnOrder.filter((field) => config.visibleFields.includes(field));
  const gridTemplateColumns = ["minmax(0,1fr)", ...fields.map((field) => FIELD_WIDTHS[field])].join(" ");
  return <section className="min-w-0 overflow-hidden rounded-lg border" data-testid={`my-todos-${kind}`}>
    <div className="flex min-h-11 items-center justify-between gap-3 border-b bg-muted/30 px-3">
      <h3 className="font-semibold">{label} <span className="ml-1 text-xs font-normal text-muted-foreground">{items.length}{query.hasNextPage ? "+" : ""}</span></h3>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">{l10n("local.my_todo_status")}
        <select aria-label={l10n("local.my_todo_status_filter", { kind: kind === "plan" ? l10n("local.my_todo_task") : l10n("local.my_todo_defect") })} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="">{l10n("local.my_todo_unfinished")}</option><option value="all">{l10n("local.my_todo_all")}</option>{STATUSES.map((item) => <option key={item.value} value={item.value}>{l10n(item.labelKey)}</option>)}
        </select>
      </label>
    </div>
    <div className="max-h-[min(62vh,760px)] overflow-auto">
      {query.isPending ? <p className="px-3 py-4 text-sm text-muted-foreground">{l10n("local.my_todo_loading", { kind: label })}</p>
        : query.isError ? <div role="alert" className="flex items-center gap-3 px-3 py-4 text-sm text-destructive">{l10n("local.my_todo_load_failed", { kind: label })}<button className="underline" onClick={() => void query.refetch()}>{l10n("local.my_todo_retry")}</button></div>
          : items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">{l10n("local.my_todo_empty", { kind: label })}</p>
            : <ul className="divide-y">{items.map((item) => <li key={item.id}>
              <Link to={`/projects/${item.projectId}/${kind === "plan" ? "plans" : "defects"}?record=${encodeURIComponent(item.id)}`}
                className={`flex flex-col justify-center gap-0.5 px-3 text-sm text-foreground no-underline hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:grid sm:gap-x-3 ${config.density === "compact" ? "min-h-10 py-1" : "min-h-14 py-2"}`}
                style={{ gridTemplateColumns }} aria-label={l10n("local.my_todo_open", { kind: label, title: item.title })}>
                <span className="min-w-0 truncate font-medium" title={item.title}>{item.title}</span>
                {fields.map((field) => <span key={field} className="hidden truncate text-xs text-muted-foreground sm:block">{fieldValue(item, field)}</span>)}
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground sm:hidden">{fields.map((field) => <span key={field}>{l10n(FIELD_LABEL_KEYS[field])}：{fieldValue(item, field)}</span>)}</span>
              </Link>
            </li>)}</ul>}
    </div>
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
  return <div className="min-w-0 space-y-3" data-testid="dashboard-my-todos">
    <div className="flex flex-wrap items-start justify-between gap-2">
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
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => setSettingsDraft({ ...DEFAULT_MY_TODO_VIEW_CONFIG, visibleFields: [...MY_TODO_OPTIONAL_FIELDS], columnOrder: [...MY_TODO_OPTIONAL_FIELDS] })}>{l10n("local.my_todo_restore_defaults")}</button>
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => { setSettingsOpen(false); setSettingsDraft(null); }}>{l10n("local.my_todo_cancel")}</button>
      </div>
    </section> : null}
    <div className="flex flex-wrap gap-2 rounded-lg border p-2">
      <input aria-label={l10n("local.my_todo_search")} className="h-9 min-w-40 flex-1 rounded-md border bg-background px-3 text-sm" value={search} maxLength={200} placeholder={l10n("local.my_todo_search_placeholder")} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={l10n("local.my_todo_project_filter")} className="h-9 rounded-md border bg-background px-2 text-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">{l10n("local.my_todo_all_projects")}</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">{l10n("local.my_todo_due_before")} <input aria-label={l10n("local.my_todo_due_filter")} type="date" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={dueBefore} onChange={(event) => setDueBefore(event.target.value)} /></label>
      <select aria-label={l10n("local.my_todo_sort_filter")} className="h-9 rounded-md border bg-background px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="due">{l10n("local.my_todo_sort_due")}</option><option value="updated">{l10n("local.my_todo_sort_updated")}</option></select>
    </div>
    <TodoGroup companyId={companyId} kind="plan" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
    <TodoGroup companyId={companyId} kind="defect" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} config={config} />
  </div>;
}
