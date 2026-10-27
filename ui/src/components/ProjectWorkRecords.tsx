import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveWorkRecordDisplayState, type WorkRecord } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { workRecordsApi } from "@/api/work-records";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const STATE_LABELS: Record<string, string> = {
  running: "运行中", unknown: "运行状态暂不可确认", preparing: "准备派发", failed: "派发失败",
  blocked: "等待前置", queued: "已排队", linked: "已派发，等待调度", not_dispatched: "未派发",
  conflict: "状态冲突", done: "已完成", cancelled: "已取消", ended: "运行已结束",
  stale: "投影已过期", error: "投影异常",
};
const BUSINESS_LABELS: Record<string, string> = {
  backlog: "待整理", todo: "待开始", in_progress: "进行中", in_review: "审核中",
  blocked: "受阻", done: "已完成", cancelled: "已取消",
};
const DISPATCH_LABELS: Record<string, string> = {
  not_dispatched: "未派发", preparing: "准备派发", blocked: "等待前置",
  linked: "已派发，等待调度", queued: "已进入调度队列", failed: "派发失败",
};
const HOLD_LABELS: Record<string, string> = {
  prerequisite_not_dispatched: "前置尚未派发", prerequisite_not_completed: "前置尚未完成",
  delivery_sync_pending: "等待交付同步", native_dependency_pending: "等待任务依赖",
  release_pending: "等待释放", release_failed: "释放失败",
};
const RUN_LABELS: Record<string, string> = {
  succeeded: "成功", failed: "失败", timed_out: "超时", interrupted: "已中断", cancelled: "已取消",
};
const RECOVERY_LABELS: Record<string, string> = {
  projection_stale: "执行投影已过期。重新读取现有任务和运行状态。",
  successful_run_missing_disposition: "运行已成功结束，但业务状态尚未确认。请重新核对状态。",
  release_delivery_missing_wake: "释放已记录，但未找到对应调度请求。请重新核对状态。",
  release_failed: "任务释放失败。请重新核对后安全重试。",
};

function formatConfirmedAt(value: Date | string | number | null | undefined) {
  if (!value) return "尚未确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

function requestStorageKey(companyId: string, projectId: string, recordId: string) {
  return `work-record-dispatch:${companyId}:${projectId}:${recordId}`;
}

export function ProjectWorkRecords({ companyId, projectId }: { companyId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"plan" | "defect">("plan");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [predecessorRecordId, setPredecessorRecordId] = useState("");
  const recordsKey = queryKeys.workRecords.list(companyId, projectId);
  const records = useQuery({ queryKey: recordsKey, queryFn: () => workRecordsApi.list(companyId, projectId), refetchInterval: 2_000 });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const liveRuns = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: 2_000,
  });
  const liveRunByIssue = useMemo(() => new Map(
    (liveRuns.data ?? []).filter((run) => (run.status === "queued" || run.status === "running") && run.issueId).map((run) => [run.issueId!, run]),
  ), [liveRuns.data]);

  const create = useMutation({
    mutationFn: () => workRecordsApi.create(companyId, {
      projectId, kind, title: title.trim(), description: description.trim() || null,
      assigneeAgentId: assigneeAgentId || null,
      predecessorRecordIds: predecessorRecordId ? [predecessorRecordId] : [],
    }),
    onSuccess: async () => {
      setTitle(""); setDescription(""); setPredecessorRecordId("");
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });
  const dispatch = useMutation({
    mutationFn: (record: WorkRecord) => {
      const storageKey = requestStorageKey(companyId, projectId, record.id);
      let clientRequestId = sessionStorage.getItem(storageKey);
      if (!clientRequestId) {
        clientRequestId = crypto.randomUUID();
        sessionStorage.setItem(storageKey, clientRequestId);
      }
      return workRecordsApi.dispatch(companyId, projectId, record.id, { clientRequestId, expectedRevision: record.revision });
    },
    onSuccess: async (_, record) => {
      sessionStorage.removeItem(requestStorageKey(companyId, projectId, record.id));
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });
  const inspectDispatch = useMutation({
    mutationFn: ({ record, clientRequestId }: { record: WorkRecord; clientRequestId: string }) =>
      workRecordsApi.dispatchRequest(companyId, projectId, record.id, clientRequestId),
    onSuccess: async (result, { record }) => {
      if (result.issueLinkId) sessionStorage.removeItem(requestStorageKey(companyId, projectId, record.id));
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });
  const reconcile = useMutation({
    mutationFn: (record: WorkRecord) => workRecordsApi.reconcile(companyId, projectId, record.id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: recordsKey }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>新建业务记录</CardTitle>
          <CardDescription>保存和预分配不会创建任务或运行；只有“明确派发”会进入执行链。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              <span>标题</span>
              <Input maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成发布说明" />
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span>类型</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(event) => setKind(event.target.value as "plan" | "defect")}>
                <option value="plan">计划</option><option value="defect">缺陷</option>
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span>执行人</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)}>
                <option value="">暂不分配</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              <span>前置记录</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={predecessorRecordId} onChange={(event) => setPredecessorRecordId(event.target.value)}>
                <option value="">无前置记录</option>
                {(records.data ?? []).map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
              </select>
            </label>
          </div>
          <label className="space-y-1 text-sm font-medium">
            <span>描述</span>
            <Textarea maxLength={100_000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写明范围、约束和交付标准" />
          </label>
          {create.error ? <p aria-live="polite" className="text-sm text-destructive">记录保存失败：{create.error.message}</p> : null}
          <div className="flex justify-end"><Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>保存记录</Button></div>
        </CardContent>
      </Card>

      {records.isLoading ? <p className="text-sm text-muted-foreground">正在加载记录…</p> : null}
      {records.error ? (
        <div className="flex items-center justify-between gap-3 text-sm text-destructive">
          <p>记录加载失败：{records.error.message}</p>
          <Button variant="outline" onClick={() => records.refetch()}>重试</Button>
        </div>
      ) : null}
      {!records.isLoading && !records.error && records.data?.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">还没有业务记录。先保存一条记录；确认前置与执行人后再明确派发。</p>
      ) : null}
      {(records.data ?? []).map((record) => {
        const liveRun = record.execution.issueId ? liveRunByIssue.get(record.execution.issueId) : null;
        const display = deriveWorkRecordDisplayState({
          businessStatus: record.businessStatus, dispatchState: record.dispatchState,
          liveRunStatus: liveRun?.status, liveRunQueryFailed: liveRuns.isError,
          projectionState: record.execution.projectionState, lastRunStatus: record.execution.lastRunStatus,
        });
        const clientRequestId = sessionStorage.getItem(requestStorageKey(companyId, projectId, record.id));
        const dispatchOwnsRecord = dispatch.variables?.id === record.id;
        const inspectOwnsRecord = inspectDispatch.variables?.record.id === record.id;
        const reconcileOwnsRecord = reconcile.variables?.id === record.id;
        const canRetryDispatch = record.dispatchState === "failed" && !record.execution.issueId && Boolean(clientRequestId);
        const canReconcileState = record.recovery.canReconcile || display.state === "conflict";
        const reconcileMessage = display.state === "conflict"
          ? "业务终态与实时运行冲突。重新核对现有任务和运行状态。"
          : RECOVERY_LABELS[record.recovery.message ?? ""] ?? record.recovery.message ?? "状态需要重新核对";
        const lastConfirmedAt = liveRun ? liveRuns.dataUpdatedAt : record.recovery.lastConfirmedAt ?? record.execution.projectedAt;
        const projectionLabel = record.execution.projectionState === "none" ? "尚未建立"
          : record.execution.projectionState === "current" ? `${record.execution.issueStatus ?? "状态未知"} · 已同步`
            : record.execution.projectionState === "stale" ? "同步已过期"
              : `异常 · ${RECOVERY_LABELS[record.execution.projectionError ?? ""] ?? record.execution.projectionError ?? "原因未知"}`;
        const runLabel = liveRun ? liveRun.status === "running" ? "真实运行中" : "真实队列中"
          : record.execution.lastRunStatus ? `已结束 · ${RUN_LABELS[record.execution.lastRunStatus] ?? record.execution.lastRunStatus}`
            : liveRuns.isError ? "实时状态未知" : "无实时运行";
        return (
          <Card key={record.id}>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <CardTitle className="break-words">{record.title}</CardTitle>
                <CardDescription>{record.kind === "defect" ? "缺陷" : "计划"} · 最后确认 {formatConfirmedAt(lastConfirmedAt)}</CardDescription>
              </div>
              <span className="inline-flex min-h-7 shrink-0 items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium">
                {display.animated ? (
                  <span className="relative flex size-2 shrink-0" aria-hidden="true">
                    <span className="absolute inline-flex size-full rounded-full bg-primary opacity-75 motion-safe:animate-ping" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                ) : null}
                {STATE_LABELS[display.state]}
              </span>
            </CardHeader>
            <CardContent className="space-y-4">
              {record.description ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{record.description}</p> : null}
              <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="min-h-20 rounded-md bg-muted/50 p-3"><dt className="text-xs font-medium text-muted-foreground">业务状态</dt><dd className="mt-1 text-sm font-medium">{BUSINESS_LABELS[record.businessStatus] ?? record.businessStatus}</dd></div>
                <div className="min-h-20 rounded-md bg-muted/50 p-3"><dt className="text-xs font-medium text-muted-foreground">派发状态</dt><dd className="mt-1 text-sm font-medium">{DISPATCH_LABELS[record.dispatchState] ?? record.dispatchState}</dd></div>
                <div className="min-h-20 rounded-md bg-muted/50 p-3"><dt className="text-xs font-medium text-muted-foreground">执行投影</dt><dd className="mt-1 break-words text-sm font-medium">{projectionLabel}</dd></div>
                <div className="min-h-20 rounded-md bg-muted/50 p-3"><dt className="text-xs font-medium text-muted-foreground">实时运行</dt><dd className="mt-1 text-sm font-medium">{runLabel}</dd></div>
              </dl>
              {record.dependencies.length ? <p className="text-sm text-muted-foreground">前置：{record.dependencies.map((dependency) => `${dependency.title}${dependency.holdReason ? `（${HOLD_LABELS[dependency.holdReason] ?? dependency.holdReason}）` : ""}`).join("、")}</p> : null}
              {canReconcileState ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p className="text-destructive">{reconcileMessage}</p>
                  <Button variant="outline" size="sm" disabled={reconcileOwnsRecord && reconcile.isPending} onClick={() => reconcile.mutate(record)}>重新核对状态</Button>
                </div>
              ) : null}
              {dispatchOwnsRecord && dispatch.error ? <p aria-live="polite" className="text-sm text-destructive">派发结果未确认：{dispatch.error.message}。请核对同一请求；确认未建立任务后再安全重试。</p> : null}
              {inspectOwnsRecord && inspectDispatch.error ? <p aria-live="polite" className="text-sm text-destructive">同一请求查询失败：{inspectDispatch.error.message}</p> : null}
              {reconcileOwnsRecord && reconcile.error ? <p aria-live="polite" className="text-sm text-destructive">状态核对失败：{reconcile.error.message}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">记录详情</summary>
                  <div className="mt-2 space-y-1">
                    <p>派发轮次 {record.dispatchRound} · 记录修订 {record.revision}</p>
                    {record.execution.issueId ? <Link className="block font-medium text-primary underline-offset-4 hover:underline" to={`/issues/${record.execution.issueIdentifier ?? record.execution.issueId}`}>打开原生任务 {record.execution.issueIdentifier ?? ""}</Link> : <p>尚未创建主任务</p>}
                    {record.execution.lastRunId && record.execution.lastRunAgentId ? <Link className="block font-medium text-primary underline-offset-4 hover:underline" to={`/agents/${record.execution.lastRunAgentId}/runs/${record.execution.lastRunId}`}>打开最近一次运行</Link> : null}
                  </div>
                </details>
                <div className="flex flex-wrap justify-end gap-2">
                  {clientRequestId ? <Button variant="outline" size="sm" disabled={inspectOwnsRecord && inspectDispatch.isPending} onClick={() => inspectDispatch.mutate({ record, clientRequestId })}>核对同一请求</Button> : null}
                  <Button variant="outline" disabled={!record.assigneeAgentId || (!canRetryDispatch && record.dispatchState !== "not_dispatched") || (dispatchOwnsRecord && dispatch.isPending)} onClick={() => dispatch.mutate(record)}>{canRetryDispatch ? "使用同一请求安全重试" : "明确派发"}</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
