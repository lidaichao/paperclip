import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WorkPackageConsole } from "@/components/WorkPackageConsole";

export function ProjectWorkRecords({ companyId, projectId }: { companyId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"plan" | "defect">("plan");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [qaAssigneeAgentId, setQaAssigneeAgentId] = useState("");
  const [parentRecordId, setParentRecordId] = useState("");
  const [predecessorRecordId, setPredecessorRecordId] = useState("");
  const recordsKey = queryKeys.workRecords.list(companyId, projectId);
  const records = useQuery({ queryKey: recordsKey, queryFn: () => workRecordsApi.list(companyId, projectId), refetchInterval: 15_000 });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });

  const create = useMutation({
    mutationFn: () => workRecordsApi.create(companyId, {
      projectId, kind, title: title.trim(), description: description.trim() || null,
      parentRecordId: parentRecordId || null,
      assigneeAgentId: assigneeAgentId || null,
      qaAssigneeAgentId: qaAssigneeAgentId || null,
      predecessorRecordIds: predecessorRecordId ? [predecessorRecordId] : [],
    }),
    onSuccess: async () => {
      setTitle(""); setDescription(""); setParentRecordId(""); setPredecessorRecordId("");
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>新建业务记录</CardTitle>
          <CardDescription>保存和预分配不会创建任务或运行；只有确认工作包范围后才会进入执行链。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="space-y-1 text-sm font-medium"><span>标题</span><Input maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成发布说明" /></label>
            <label className="space-y-1 text-sm font-medium"><span>类型</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(event) => setKind(event.target.value as "plan" | "defect")}><option value="plan">计划</option><option value="defect">缺陷</option></select></label>
            <label className="space-y-1 text-sm font-medium"><span>上级记录</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={parentRecordId} onChange={(event) => setParentRecordId(event.target.value)}><option value="">无上级记录</option>{(records.data ?? []).filter((record) => record.kind === "plan").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>
            <label className="space-y-1 text-sm font-medium"><span>执行人</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)}><option value="">暂不分配</option>{(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label className="space-y-1 text-sm font-medium"><span>QA</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={qaAssigneeAgentId} onChange={(event) => setQaAssigneeAgentId(event.target.value)}><option value="">暂不分配</option>{(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label className="space-y-1 text-sm font-medium"><span>前置记录</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={predecessorRecordId} onChange={(event) => setPredecessorRecordId(event.target.value)}><option value="">无前置记录</option>{(records.data ?? []).map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>
          </div>
          <label className="space-y-1 text-sm font-medium"><span>描述</span><Textarea maxLength={100_000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写明范围、约束和交付标准" /></label>
          {create.error ? <p aria-live="polite" className="text-sm text-destructive">记录保存失败：{create.error.message}</p> : null}
          <div className="flex justify-end"><Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>保存记录</Button></div>
        </CardContent>
      </Card>
      <WorkPackageConsole companyId={companyId} projectId={projectId} records={records.data ?? []} agentNames={Object.fromEntries((agents.data ?? []).map((agent) => [agent.id, agent.name]))} recordsLoading={records.isLoading} recordsError={records.error} onRetryRecords={() => records.refetch()} />
    </div>
  );
}
