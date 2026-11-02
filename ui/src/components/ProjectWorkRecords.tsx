import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkRecord, WorkRecordBusinessStatus, WorkRecordKind } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WorkPackageConsole } from "@/components/WorkPackageConsole";

const BUSINESS_STATUS_OPTIONS: Array<{ value: WorkRecordBusinessStatus; label: string }> = [
  { value: "backlog", label: "待整理" },
  { value: "todo", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "in_review", label: "审核中" },
  { value: "blocked", label: "受阻" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

interface RecordDraft {
  title: string;
  description: string;
  businessStatus: WorkRecordBusinessStatus;
  assigneeAgentId: string;
  qaAssigneeAgentId: string;
  parentRecordId: string;
  predecessorRecordId: string;
}

function blankDraft(): RecordDraft {
  return {
    title: "",
    description: "",
    businessStatus: "backlog",
    assigneeAgentId: "",
    qaAssigneeAgentId: "",
    parentRecordId: "",
    predecessorRecordId: "",
  };
}

function draftFromRecord(record: WorkRecord): RecordDraft {
  return {
    title: record.title,
    description: record.description ?? "",
    businessStatus: record.businessStatus,
    assigneeAgentId: record.assigneeAgentId ?? "",
    qaAssigneeAgentId: record.qaAssigneeAgentId ?? "",
    parentRecordId: record.parentRecordId ?? "",
    predecessorRecordId: record.dependencies[0]?.predecessorRecordId ?? "",
  };
}

export function ProjectWorkRecords({ companyId, projectId, kind }: {
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
}) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WorkRecord | null>(null);
  const [draft, setDraft] = useState<RecordDraft>(blankDraft);
  const recordsKey = queryKeys.workRecords.list(companyId, projectId);
  const records = useQuery({
    queryKey: recordsKey,
    queryFn: () => workRecordsApi.list(companyId, projectId),
    refetchInterval: 15_000,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const allRecords = records.data ?? [];
  const visibleRecords = useMemo(
    () => allRecords.filter((record) => record.kind === kind),
    [allRecords, kind],
  );
  const kindLabel = kind === "plan" ? "计划" : "缺陷";

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingRecord(null);
    setDraft(blankDraft());
  };

  const save = useMutation({
    mutationFn: async () => {
      const shared = {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        parentRecordId: draft.parentRecordId || null,
        assigneeAgentId: draft.assigneeAgentId || null,
        qaAssigneeAgentId: draft.qaAssigneeAgentId || null,
        predecessorRecordIds: draft.predecessorRecordId ? [draft.predecessorRecordId] : [],
      };
      if (editingRecord) {
        return workRecordsApi.update(companyId, projectId, editingRecord.id, {
          expectedRevision: editingRecord.revision,
          ...shared,
          businessStatus: draft.businessStatus,
        });
      }
      return workRecordsApi.create(companyId, { projectId, kind, ...shared });
    },
    onSuccess: async () => {
      closeDialog();
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  const reopen = useMutation({
    mutationFn: (record: WorkRecord) => workRecordsApi.update(companyId, projectId, record.id, {
      expectedRevision: record.revision,
      businessStatus: "todo",
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    },
  });

  const beginCreate = () => {
    save.reset();
    setEditingRecord(null);
    setDraft(blankDraft());
    setDialogOpen(true);
  };

  const beginEdit = (record: WorkRecord) => {
    save.reset();
    setEditingRecord(record);
    setDraft(draftFromRecord(record));
    setDialogOpen(true);
  };

  const selectableRecords = allRecords.filter((record) => record.id !== editingRecord?.id);
  const parentRecords = selectableRecords.filter((record) => record.kind === "plan");

  return (
    <section className="space-y-3" data-testid="work-records-main" data-kind={kind}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{kindLabel}</h2>
          <p className="text-sm text-muted-foreground">
            {kind === "plan"
              ? "保存、编辑和预分配不会启动执行；确认派发后才进入工作包执行链。"
              : "缺陷沿用同一状态和描述，可关联质量证据并在原记录上重新打开。"}
          </p>
        </div>
        <Button onClick={beginCreate}>
          <Plus className="size-4" />
          新建{kindLabel}
        </Button>
      </div>

      {reopen.error ? <p role="alert" className="text-sm text-destructive">缺陷重新打开失败：{reopen.error.message}</p> : null}

      <WorkPackageConsole
        companyId={companyId}
        projectId={projectId}
        records={allRecords}
        visibleKind={kind}
        agentNames={Object.fromEntries((agents.data ?? []).map((agent) => [agent.id, agent.name]))}
        recordsLoading={records.isLoading}
        recordsError={records.error}
        onRetryRecords={() => records.refetch()}
        onEditRecord={beginEdit}
        onReopenRecord={kind === "defect" ? (record) => reopen.mutate(record) : undefined}
        reopeningRecordId={reopen.isPending ? reopen.variables?.id ?? null : null}
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingRecord ? `编辑${kindLabel}` : `新建${kindLabel}`}</DialogTitle>
            <DialogDescription>此处只保存业务记录；不会创建原生任务、唤醒智能体或启动运行。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>标题</span>
              <Input
                maxLength={500}
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder={kind === "plan" ? "例如：完成发布说明" : "例如：窄屏下操作栏遮挡内容"}
                autoFocus
              />
            </label>

            {editingRecord ? (
              <label className="space-y-1 text-sm font-medium">
                <span>业务状态</span>
                <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.businessStatus} onChange={(event) => setDraft((current) => ({ ...current, businessStatus: event.target.value as WorkRecordBusinessStatus }))}>
                  {BUSINESS_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ) : null}

            <label className="space-y-1 text-sm font-medium">
              <span>上级计划</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.parentRecordId} onChange={(event) => setDraft((current) => ({ ...current, parentRecordId: event.target.value }))}>
                <option value="">无上级计划</option>
                {parentRecords.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>执行人</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.assigneeAgentId} onChange={(event) => setDraft((current) => ({ ...current, assigneeAgentId: event.target.value }))}>
                <option value="">暂不分配</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>QA</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.qaAssigneeAgentId} onChange={(event) => setDraft((current) => ({ ...current, qaAssigneeAgentId: event.target.value }))}>
                <option value="">暂不分配</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium">
              <span>前置记录</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.predecessorRecordId} onChange={(event) => setDraft((current) => ({ ...current, predecessorRecordId: event.target.value }))}>
                <option value="">无前置记录</option>
                {selectableRecords.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
              </select>
            </label>

            <label className="space-y-1 text-sm font-medium md:col-span-2">
              <span>描述</span>
              <Textarea maxLength={100_000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="写明范围、约束和验收标准" />
            </label>
          </div>

          {save.error ? <p role="alert" className="text-sm text-destructive">{kindLabel}保存失败：{save.error.message}</p> : null}

          <DialogFooter className="items-center justify-between sm:justify-between">
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button disabled={!draft.title.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "保存中…" : `保存${kindLabel}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <span className="sr-only" aria-live="polite">当前显示 {visibleRecords.length} 条{kindLabel}</span>
    </section>
  );
}
