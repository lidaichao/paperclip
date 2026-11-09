import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "@/api/projects";
import { workRecordsApi } from "@/api/work-records";
import type { WorkRecordBusinessStatus, WorkRecordKind, WorkRecordMyTodo, WorkRecordUserRole } from "@paperclipai/shared";

const STATUSES: Array<{ value: WorkRecordBusinessStatus; label: string }> = [
  { value: "backlog", label: "待规划" }, { value: "todo", label: "待办" },
  { value: "in_progress", label: "进行中" }, { value: "in_review", label: "审查中" },
  { value: "blocked", label: "受阻" }, { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];
const ROLE_LABELS: Record<WorkRecordUserRole, string> = { execution: "执行", qa: "QA", po: "验收" };
const statusLabel = (status: WorkRecordBusinessStatus) => STATUSES.find((item) => item.value === status)?.label ?? status;

function TodoGroup({ companyId, kind, projectId, q, dueBefore, sort }: {
  companyId: string;
  kind: WorkRecordKind;
  projectId: string;
  q: string;
  dueBefore: string;
  sort: "updated" | "due";
}) {
  const [status, setStatus] = useState<WorkRecordBusinessStatus | "all" | "">("");
  const query = useInfiniteQuery({
    queryKey: ["work-record-my-todos", companyId, kind, projectId, q, dueBefore, sort, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => workRecordsApi.myTodos(companyId, {
      kind,
      status: status || undefined,
      projectId: projectId || undefined,
      q: q || undefined,
      dueBefore: dueBefore || undefined,
      sort,
      cursor: pageParam,
      limit: 50,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const label = kind === "plan" ? "任务" : "缺陷";
  return <section className="min-w-0 overflow-hidden rounded-lg border" data-testid={`my-todos-${kind}`}>
    <div className="flex min-h-11 items-center justify-between gap-3 border-b bg-muted/30 px-3">
      <h3 className="font-semibold">{label} <span className="ml-1 text-xs font-normal text-muted-foreground">{items.length}{query.hasNextPage ? "+" : ""}</span></h3>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        状态
        <select aria-label={`${label}状态`} className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="">未完成</option><option value="all">全部</option>
          {STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
    </div>
    <div className="max-h-[min(62vh,760px)] overflow-auto">
      {query.isPending ? <p className="px-3 py-4 text-sm text-muted-foreground">正在读取{label}…</p>
        : query.isError ? <div role="alert" className="flex items-center gap-3 px-3 py-4 text-sm text-destructive">读取{label}失败，执行状态未知。<button className="underline" onClick={() => void query.refetch()}>重试</button></div>
          : items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">当前没有需要你处理的{label}。</p>
            : <ul className="divide-y">{items.map((item: WorkRecordMyTodo) => <li key={item.id}>
              <Link to={`/projects/${item.projectId}/${kind === "plan" ? "plans" : "defects"}?record=${encodeURIComponent(item.id)}`}
                className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-sm text-foreground no-underline hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:grid-cols-[minmax(0,1fr)_minmax(6rem,10rem)_5.5rem_6rem]"
                aria-label={`查看${label} ${item.title}`}>
                <span className="min-w-0 truncate font-medium" title={item.title}>{item.title}</span>
                <span className="hidden truncate text-xs text-muted-foreground sm:block" title={item.projectName}>{item.projectName} · {item.roles.map((role) => ROLE_LABELS[role]).join("/")}</span>
                <span className="hidden text-xs sm:block">{item.executionState === "active" ? <span className="inline-flex items-center gap-1 text-primary"><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />执行中</span> : item.executionState === "unknown" ? "状态未知" : statusLabel(item.businessStatus)}</span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">{item.plannedCompletionDate ?? "未排期"}</span>
                <span className="col-span-2 truncate text-xs text-muted-foreground sm:hidden">{item.projectName} · {item.roles.map((role) => ROLE_LABELS[role]).join("/")} · {statusLabel(item.businessStatus)}</span>
              </Link>
            </li>)}</ul>}
    </div>
    {query.hasNextPage && <div className="border-t px-3 py-2"><button className="text-sm text-primary underline disabled:opacity-50" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "加载中…" : "加载更多"}</button></div>}
  </section>;
}

export function DashboardMyTodos({ companyId }: { companyId: string }) {
  const [projectId, setProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [dueBefore, setDueBefore] = useState("");
  const [sort, setSort] = useState<"updated" | "due">("due");
  const q = useDeferredValue(search.trim());
  const projects = useQuery({
    queryKey: ["my-todos-projects", companyId],
    queryFn: () => projectsApi.list(companyId, { includeArchived: true }),
  });
  return <div className="min-w-0 space-y-3" data-testid="dashboard-my-todos">
    <div><h2 className="text-lg font-semibold">我的待办</h2><p className="text-sm text-muted-foreground">只显示明确交给你处理的任务和缺陷；保存记录不会自动派发 Agent。</p></div>
    <div className="flex flex-wrap gap-2 rounded-lg border p-2">
      <input aria-label="搜索我的待办" className="h-9 min-w-40 flex-1 rounded-md border bg-background px-3 text-sm" value={search} maxLength={200} placeholder="搜索任务或缺陷" onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="待办项目" className="h-9 rounded-md border bg-background px-2 text-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">全部项目</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">截止至 <input aria-label="待办截止日期" type="date" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={dueBefore} onChange={(event) => setDueBefore(event.target.value)} /></label>
      <select aria-label="待办排序" className="h-9 rounded-md border bg-background px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="due">按截止日期</option><option value="updated">按最近更新</option></select>
    </div>
    <TodoGroup companyId={companyId} kind="plan" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} />
    <TodoGroup companyId={companyId} kind="defect" projectId={projectId} q={q} dueBefore={dueBefore} sort={sort} />
  </div>;
}
