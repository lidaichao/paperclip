import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveWorkRecordDisplayState, type WorkRecord } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const STATE_LABELS: Record<string, string> = {
  running: "运行中",
  unknown: "运行状态暂不可确认",
  preparing: "准备派发",
  failed: "派发失败",
  blocked: "等待前置",
  queued: "已排队",
  linked: "已关联",
  not_dispatched: "未派发",
  conflict: "状态冲突",
};

const HOLD_LABELS: Record<string, string> = {
  prerequisite_not_dispatched: "前置尚未派发",
  prerequisite_not_completed: "前置尚未完成",
  delivery_sync_pending: "等待交付同步",
  native_dependency_pending: "等待任务依赖",
  release_pending: "等待释放",
  release_failed: "释放失败",
};

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
  const liveStatusByIssue = useMemo(() => new Map(
    (liveRuns.data ?? []).filter((run) => (run.status === "queued" || run.status === "running") && run.issueId).map((run) => [run.issueId!, run.status]),
  ), [liveRuns.data]);

  const create = useMutation({
    mutationFn: () => workRecordsApi.create(companyId, {
      projectId,
      kind,
      title: title.trim(),
      description: description.trim() || null,
      assigneeAgentId: assigneeAgentId || null,
      predecessorRecordIds: predecessorRecordId ? [predecessorRecordId] : [],
    }),
    onSuccess: async () => {
      setTitle("");
      setDescription("");
      setPredecessorRecordId("");
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });
  const dispatch = useMutation({
    mutationFn: (record: WorkRecord) => {
      const storageKey = `work-record-dispatch:${companyId}:${projectId}:${record.id}`;
      let clientRequestId = sessionStorage.getItem(storageKey);
      if (!clientRequestId) {
        clientRequestId = crypto.randomUUID();
        sessionStorage.setItem(storageKey, clientRequestId);
      }
      return workRecordsApi.dispatch(companyId, projectId, record.id, {
        clientRequestId,
        expectedRevision: record.revision,
      });
    },
    onSuccess: async (_, record) => {
      sessionStorage.removeItem(`work-record-dispatch:${companyId}:${projectId}:${record.id}`);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
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
                <option value="plan">计划</option>
                <option value="defect">缺陷</option>
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
          {(create.error || dispatch.error) ? <p aria-live="polite" className="text-sm text-destructive">操作失败：{(create.error ?? dispatch.error)?.message}。请检查内容后重试。</p> : null}
          <div className="flex justify-end">
            <Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>保存记录</Button>
          </div>
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
        const display = deriveWorkRecordDisplayState({
          businessStatus: record.businessStatus,
          dispatchState: record.dispatchState,
          liveRunStatus: record.execution.issueId ? liveStatusByIssue.get(record.execution.issueId) : null,
          liveRunQueryFailed: liveRuns.isError,
        });
        const displayLabel = display.state === "unknown" && liveRuns.dataUpdatedAt
          ? `${STATE_LABELS.unknown} · 最后确认 ${new Date(liveRuns.dataUpdatedAt).toLocaleTimeString()}`
          : STATE_LABELS[display.state];
        return (
          <Card key={record.id}>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <CardTitle className="break-words">{record.title}</CardTitle>
                <CardDescription>{record.kind === "defect" ? "缺陷" : "计划"} · 业务状态 {record.businessStatus}</CardDescription>
              </div>
              <span className={cn("rounded-full bg-muted px-3 py-1 text-xs font-medium", display.animated && "animate-pulse bg-primary/15 text-primary")}>{displayLabel}</span>
            </CardHeader>
            <CardContent className="space-y-3">
              {record.description ? <p className="text-sm text-muted-foreground whitespace-pre-wrap">{record.description}</p> : null}
              {record.dependencies.length ? (
                <div className="text-sm text-muted-foreground">
                  前置：{record.dependencies.map((dependency) => `${dependency.title}${dependency.holdReason ? `（${HOLD_LABELS[dependency.holdReason] ?? dependency.holdReason}）` : ""}`).join("、")}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{record.execution.issueIdentifier ? `主任务 ${record.execution.issueIdentifier}` : "尚未创建主任务"}</p>
                <Button
                  variant="outline"
                  disabled={!record.assigneeAgentId || record.dispatchState !== "not_dispatched" || dispatch.isPending}
                  onClick={() => dispatch.mutate(record)}
                >明确派发</Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
