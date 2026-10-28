import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveWorkRecordDisplayState, type WorkPackageAssignmentEscalationReceipt, type WorkPackageDispatchPreview, type WorkRecord, type WorkRecordQualityView } from "@paperclipai/shared";
import { CheckCircle2, ChevronRight, PackageCheck, RefreshCw, WifiOff } from "lucide-react";
import { heartbeatsApi } from "@/api/heartbeats";
import { workRecordsApi } from "@/api/work-records";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const BUSINESS: Record<string, string> = { backlog: "待整理", todo: "待开始", in_progress: "进行中", in_review: "审核中", blocked: "受阻", done: "已完成", cancelled: "已取消" };
const DISPATCH: Record<string, string> = { not_dispatched: "未派发", preparing: "准备中", blocked: "等待前置", linked: "已关联", queued: "已排队", failed: "失败" };
const QUALITY: Record<string, string> = { not_started: "未开始", waiting_children: "等待子项", qa_initial: "QA 初验", waiting_fix: "等待修复", qa_retest: "QA 复验", po_acceptance: "PO 验收", impact_review: "影响评审", approval_wait: "等待审批", accepted: "已验收", attention_required: "需关注" };
const DISPLAY: Record<string, string> = { running: "运行中", queued: "真实排队", unknown: "运行未知", preparing: "准备派发", failed: "派发失败", blocked: "等待前置", linked: "等待调度", not_dispatched: "未派发", conflict: "状态冲突", done: "已完成", cancelled: "已取消", ended: "运行结束", stale: "投影过期", error: "投影异常" };
const ITEM_STATE: Record<string, string> = { waiting: "等待", blocked: "受阻", ready: "就绪", active: "处理中", submitted: "待判定", accepted: "已通过", rejected: "已退回", superseded: "已替代", cancelled: "已取消" };
const ROLE: Record<string, string> = { repair: "修复", qa: "QA", po: "PO" };
const HOLD: Record<string, string> = { prerequisite_not_dispatched: "前置尚未派发", prerequisite_not_completed: "前置尚未完成", prerequisite_cancelled_impact_pending: "前置已取消，待 PO 处理影响", delivery_sync_pending: "等待送达同步", native_dependency_pending: "等待原生任务依赖", release_pending: "等待释放", release_failed: "释放失败", quality_gate_pending: "等待质量门", approval_pending: "等待审批" };
const PROJECTION: Record<string, string> = { none: "尚无投影", current: "已核对", stale: "投影过期", error: "投影异常" };
const RUN: Record<string, string> = { succeeded: "成功结束", failed: "失败结束", cancelled: "已取消", timed_out: "已超时", running: "运行中", queued: "排队中" };
const CYCLE_KIND: Record<string, string> = { package_acceptance: "工作包验收", package_rework: "工作包返工", defect_rework: "缺陷返工", standalone_defect: "独立缺陷" };
const CYCLE_STATE: Record<string, string> = { open: "进行中", accepted: "已验收", superseded: "已进入下一轮", cancelled: "已取消" };
const VERDICT: Record<string, string> = { approve: "通过", pass: "通过", return: "退回" };
const BATCH: Record<string, string> = { preparing: "准备中", prepared: "已准备", blocked: "受阻", failed: "失败", completed: "已完成" };
const MATERIALIZATION: Record<string, string> = { pending: "等待处理", created: "已新建", reused: "已复用", completed: "保持完成", blocked: "安全受阻", failed: "失败" };
const DISPLAY_TONE: Record<string, string> = { running: "running", queued: "queued", preparing: "pending", blocked: "blocked", failed: "failed", conflict: "error", error: "error", done: "done", cancelled: "cancelled", ended: "backlog", linked: "backlog", not_dispatched: "backlog", unknown: "warning", stale: "warning" };

function useConnectivity() {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync); window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  return online;
}

function time(value: Date | string | null | undefined) {
  if (!value) return "尚未确认";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间未知" : parsed.toLocaleString();
}

function sessionRequest(key: string) {
  const current = sessionStorage.getItem(key);
  if (current) return current;
  const next = crypto.randomUUID(); sessionStorage.setItem(key, next); return next;
}

function evidence(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function recordTitle(records: WorkRecord[], recordId: string | null | undefined) {
  if (!recordId) return "未指定";
  return records.find((record) => record.id === recordId)?.title ?? recordId;
}

type PreviewCategory = "create" | "reuse" | "completed" | "blocked";

function previewCategory(record: WorkRecord | undefined): PreviewCategory {
  if (record?.businessStatus === "done") return "completed";
  if (record?.dependencies.some((dependency) => dependency.holdReason)) return "blocked";
  if (record?.execution.issueId) return "reuse";
  return "create";
}

function previewDisposition(record: WorkRecord | undefined) {
  const category = previewCategory(record);
  if (category === "completed") return "保持完成";
  if (category === "blocked") return record?.execution.issueId ? "复用主任务并安全受阻" : "建立关联并安全受阻";
  if (category === "reuse") return "复用主任务";
  return "将新建";
}

function nextOwner(record: WorkRecord, quality: WorkRecordQualityView | undefined, agentNames: Record<string, string>) {
  const phase = record.quality.phase;
  if (phase === "po_acceptance" || phase === "impact_review") return record.assigneeAgentId ? `PO · ${agentNames[record.assigneeAgentId] ?? "未知"}` : "PO · 未分配";
  if (phase === "qa_initial" || phase === "qa_retest") return record.qaAssigneeAgentId ? `QA · ${agentNames[record.qaAssigneeAgentId] ?? "未知"}` : "QA · 未分配";
  if (phase === "approval_wait") return "Jack / Board";
  const active = quality?.items.find((item) => ["ready", "active", "submitted", "blocked"].includes(item.state));
  if (active?.role === "po") return record.assigneeAgentId ? `PO · ${agentNames[record.assigneeAgentId] ?? "未知"}` : "PO · 未分配";
  if (active?.role === "qa") return record.qaAssigneeAgentId ? `QA · ${agentNames[record.qaAssigneeAgentId] ?? "未知"}` : "QA · 未分配";
  return record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? "未知" : "待明确";
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rounded-md bg-muted/50 p-3"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{children}</dd></div>;
}

function StatusBadge({ record, liveStatus, liveUnknown }: { record: WorkRecord; liveStatus?: "queued" | "running"; liveUnknown: boolean }) {
  const state = deriveWorkRecordDisplayState({
    businessStatus: record.businessStatus,
    dispatchState: record.dispatchState,
    liveRunStatus: liveStatus,
    liveRunQueryFailed: liveUnknown,
    projectionState: record.execution.projectionState,
    lastRunStatus: record.execution.lastRunStatus,
  });
  const tone = DISPLAY_TONE[state.state] ?? "backlog";
  return (
    <Badge variant="ghost" className={cn("gap-2", statusBadge[tone] ?? statusBadgeDefault)} data-testid="work-record-status" data-state={state.state} data-animated={state.animated ? "true" : "false"}>
      {state.animated ? <span className="relative flex size-2" aria-hidden="true"><span className="absolute inline-flex size-full rounded-full bg-primary opacity-75 motion-safe:animate-ping" /><span className="relative inline-flex size-2 rounded-full bg-primary" /></span> : null}
      {DISPLAY[state.state] ?? state.state}
    </Badge>
  );
}

function deliveryLabel(record: WorkRecord) {
  const delivered = record.delivery.deliveryState === "delivered" ? `已送达 · ${time(record.delivery.deliveredAt)}` : record.delivery.deliveryState ? `送达：${record.delivery.deliveryState}` : "尚未送达";
  const acknowledged = record.delivery.acknowledgedAt ? `已确认 · ${time(record.delivery.acknowledgedAt)}` : record.delivery.wakeStatus ? `确认：${record.delivery.wakeStatus}` : "尚未确认接收";
  return { delivered, acknowledged };
}

function assignmentEscalationMessage(receipt: WorkPackageAssignmentEscalationReceipt) {
  if (receipt.state === "delivered") return "负责人缺口已上报 CEO，协调通知已送达";
  if (receipt.state === "ceo_unavailable") return "负责人缺口已记录，但当前没有可用 CEO";
  if (receipt.state === "delivery_failed") return "负责人缺口已记录，但 CEO 协调通知投递失败";
  return "负责人缺口已记录，CEO 协调通知正在投递";
}

export function WorkPackageConsole({ companyId, projectId, records, agentNames, recordsLoading, recordsError, onRetryRecords }: {
  companyId: string; projectId: string; records: WorkRecord[]; agentNames: Record<string, string>; recordsLoading: boolean; recordsError: Error | null; onRetryRecords: () => unknown;
}) {
  const queryClient = useQueryClient();
  const online = useConnectivity();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkPackageDispatchPreview | null>(null);
  const [previewMode, setPreviewMode] = useState<"whole_package" | "selected_records">("whole_package");
  const [reason, setReason] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [defectRecordId, setDefectRecordId] = useState("");
  const [repairRecordId, setRepairRecordId] = useState("");
  const batchStorageKey = `work-package-batch:${companyId}:${projectId}`;
  const [batchId, setBatchId] = useState(() => localStorage.getItem(batchStorageKey) ?? "");

  useEffect(() => {
    if (records.length > 0 && (!selectedId || !records.some((record) => record.id === selectedId))) {
      setSelectedId(records.find((record) => !record.parentRecordId)?.id ?? records[0].id);
    }
  }, [records, selectedId]);
  useEffect(() => {
    setBatchId(localStorage.getItem(batchStorageKey) ?? "");
  }, [batchStorageKey]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === batchStorageKey) setBatchId(event.newValue ?? ""); };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [batchStorageKey]);
  useEffect(() => {
    if (online) void queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
  }, [companyId, online, projectId, queryClient]);

  const selected = records.find((record) => record.id === selectedId) ?? null;
  const qualityDraftKey = selected ? `work-package-quality-draft:${companyId}:${projectId}:${selected.id}` : null;
  useEffect(() => {
    if (!qualityDraftKey) return;
    try {
      const draft = JSON.parse(sessionStorage.getItem(qualityDraftKey) ?? "{}") as Partial<{ reason: string; evidenceRefs: string; defectRecordId: string; repairRecordId: string }>;
      setReason(draft.reason ?? ""); setEvidenceRefs(draft.evidenceRefs ?? ""); setDefectRecordId(draft.defectRecordId ?? ""); setRepairRecordId(draft.repairRecordId ?? "");
    } catch {
      setReason(""); setEvidenceRefs(""); setDefectRecordId(""); setRepairRecordId("");
    }
  }, [qualityDraftKey]);
  const updateDraft = (next: Partial<{ reason: string; evidenceRefs: string; defectRecordId: string; repairRecordId: string }>) => {
    if (!qualityDraftKey) return;
    let current: Record<string, string> = {};
    try { current = JSON.parse(sessionStorage.getItem(qualityDraftKey) ?? "{}"); } catch { current = {}; }
    sessionStorage.setItem(qualityDraftKey, JSON.stringify({ ...current, ...next }));
  };
  const childrenByParent = useMemo(() => {
    const map = new Map<string, WorkRecord[]>();
    for (const record of records) { if (!record.parentRecordId) continue; const list = map.get(record.parentRecordId) ?? []; list.push(record); map.set(record.parentRecordId, list); }
    return map;
  }, [records]);
  const ordered = useMemo(() => {
    const result: Array<{ record: WorkRecord; depth: number }> = []; const seen = new Set<string>();
    const visit = (record: WorkRecord, depth: number) => { if (seen.has(record.id)) return; seen.add(record.id); result.push({ record, depth }); for (const child of childrenByParent.get(record.id) ?? []) visit(child, depth + 1); };
    for (const root of records.filter((record) => !record.parentRecordId)) visit(root, 0);
    for (const record of records) visit(record, 0);
    return result;
  }, [childrenByParent, records]);

  const selectedRoot = useMemo(() => {
    if (!selected) return null;
    const byId = new Map(records.map((record) => [record.id, record]));
    let current = selected; const seen = new Set<string>();
    while (current.parentRecordId && !seen.has(current.id)) {
      seen.add(current.id); const parent = byId.get(current.parentRecordId); if (!parent) break; current = parent;
    }
    return current;
  }, [records, selected]);

  const liveRuns = useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId), refetchInterval: online ? 15_000 : false });
  const liveByIssue = useMemo(() => new Map((liveRuns.data ?? []).filter((run) => (run.status === "queued" || run.status === "running") && run.issueId).map((run) => [run.issueId!, run.status as "queued" | "running"])), [liveRuns.data]);
  const liveAvailable = online && !liveRuns.isError && liveRuns.isFetchedAfterMount;
  const capabilities = useQuery({ queryKey: queryKeys.workRecords.capabilities(companyId, projectId), queryFn: () => workRecordsApi.capabilities(companyId, projectId) });
  const assignmentEscalation = useQuery({
    queryKey: queryKeys.workRecords.assignmentGapEscalation(companyId, projectId, selectedRoot?.id ?? "none"),
    queryFn: () => workRecordsApi.latestAssignmentGapEscalation(companyId, projectId, selectedRoot!.id),
    enabled: Boolean(selectedRoot),
    refetchInterval: online ? 15_000 : false,
  });
  const quality = useQuery({ queryKey: queryKeys.workRecords.quality(companyId, projectId, selected?.id ?? "none"), queryFn: () => workRecordsApi.quality(companyId, projectId, selected!.id), enabled: Boolean(selected), refetchInterval: online ? 15_000 : false });
  const batch = useQuery({ queryKey: queryKeys.workRecords.packageBatch(companyId, projectId, batchId || "none"), queryFn: () => workRecordsApi.packageBatch(companyId, projectId, batchId), enabled: Boolean(batchId), refetchInterval: online ? 15_000 : false });

  const previewDependencyKey = records.map((record) => `${record.id}:${record.revision}:${record.dependencySetRevision}`).join("|");
  const checkedKey = checked.join("|");
  useEffect(() => { setPreview(null); }, [selectedId, checkedKey, previewDependencyKey]);

  const scopeInput = (mode: "whole_package" | "selected_records") => ({ workflowVersion: 2 as const, projectId, rootRecordId: mode === "whole_package" ? selectedRoot!.id : null, scopeKind: mode, selectedRecordIds: mode === "selected_records" ? checked : [] });
  const previewScope = useMutation({
    mutationFn: (mode: "whole_package" | "selected_records") => workRecordsApi.previewPackage(companyId, projectId, scopeInput(mode)),
    onSuccess: (result, mode) => { setPreview(result); setPreviewMode(mode); },
  });
  const prepare = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("请先预览范围");
      const key = `work-package-prepare:${companyId}:${projectId}:${preview.scopeDigest}`;
      return workRecordsApi.preparePackage(companyId, projectId, {
        ...scopeInput(previewMode), clientRequestId: sessionRequest(key), requestPayloadDigest: preview.scopeDigest,
        expectedRootRevision: preview.rootRevision, expectedDependencySetRevision: preview.dependencySetRevision, expectedScopeDigest: preview.scopeDigest,
      });
    },
    onSuccess: async (result) => {
      setBatchId(result.batch.id); localStorage.setItem(batchStorageKey, result.batch.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) });
    },
  });
  const escalateAssignmentGaps = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("请先预览整个工作包");
      const key = `work-package-assignment-gap:${companyId}:${projectId}:${preview.scopeDigest}`;
      return workRecordsApi.escalateAssignmentGaps(companyId, projectId, {
        ...scopeInput(previewMode),
        clientRequestId: sessionRequest(key),
        requestPayloadDigest: preview.scopeDigest,
        expectedScopeDigest: preview.scopeDigest,
      });
    },
    onSuccess: (receipt) => {
      if (selectedRoot) queryClient.setQueryData(
        queryKeys.workRecords.assignmentGapEscalation(companyId, projectId, selectedRoot.id),
        receipt,
      );
      setPreview((current) => current && current.scopeDigest === receipt.scopeDigest
        ? { ...current, eligibility: { ...current.eligibility, escalation: receipt } }
        : current);
    },
  });
  const reconcile = useMutation({ mutationFn: () => workRecordsApi.reconcilePackage(companyId, projectId, batchId), onSuccess: async () => { await batch.refetch(); await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); } });
  const reconcileRecord = useMutation({ mutationFn: (recordId: string) => workRecordsApi.reconcile(companyId, projectId, recordId), onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }) });

  const activeCycle = quality.data?.cycle ?? null;
  const poItem = quality.data?.items.find((item) => item.role === "po") ?? null;
  const qaItem = quality.data?.items.find((item) => item.role === "qa") ?? null;
  const qaRecordId = qaItem?.recordId ?? "";
  const commandDone = async () => { setReason(""); setEvidenceRefs(""); setDefectRecordId(""); setRepairRecordId(""); if (qualityDraftKey) sessionStorage.removeItem(qualityDraftKey); await quality.refetch(); await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); };
  const poVerdict = useMutation({
    mutationFn: (outcome: "approve" | "return") => {
      if (!selected || !activeCycle || !poItem) throw new Error("当前没有可处理的 PO 验收项");
      const key = `quality:po:${activeCycle.id}:${poItem.id}:${outcome}`;
      return workRecordsApi.recordPoVerdict(companyId, projectId, selected.id, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, itemId: poItem.id, expectedCycleRevision: activeCycle.revision, outcome, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs), targetRecordIds: outcome === "return" ? checked : [] });
    }, onSuccess: commandDone,
  });
  const qaVerdict = useMutation({
    mutationFn: (outcome: "pass" | "return") => {
      if (!selected || !activeCycle || !qaItem || !defectRecordId) throw new Error("请选择缺陷并确认 QA 验收项");
      const key = `quality:qa:${activeCycle.id}:${qaItem.id}:${outcome}`;
      return workRecordsApi.recordQaVerdict(companyId, projectId, selected.id, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, itemId: qaItem.id, expectedCycleRevision: activeCycle.revision, outcome, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs), defectRecordId, repairRecordId: outcome === "return" ? repairRecordId || null : null });
    }, onSuccess: commandDone,
  });
  const linkDefect = useMutation({
    mutationFn: () => {
      if (!selected || !activeCycle || !defectRecordId || !qaRecordId) throw new Error("请选择缺陷并确认 QA 记录");
      const key = `quality:defect:${activeCycle.id}:${defectRecordId}`;
      return workRecordsApi.linkDefect(companyId, projectId, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, expectedCycleRevision: activeCycle.revision, defectRecordId, packageRecordId: selected.id, repairRecordId: repairRecordId || null, qaRecordId, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs) });
    }, onSuccess: commandDone,
  });
  const commandError = previewScope.error ?? prepare.error ?? escalateAssignmentGaps.error ?? reconcile.error ?? reconcileRecord.error ?? poVerdict.error ?? qaVerdict.error ?? linkDefect.error;
  const previewCounts = preview?.records.reduce<Record<PreviewCategory, number>>((counts, item) => {
    counts[previewCategory(records.find((record) => record.id === item.id))] += 1;
    return counts;
  }, { create: 0, reuse: 0, completed: 0, blocked: 0 }) ?? { create: 0, reuse: 0, completed: 0, blocked: 0 };
  const persistedEscalation = assignmentEscalation.data
    ?? preview?.eligibility.escalation
    ?? escalateAssignmentGaps.data
    ?? null;

  if (recordsLoading) return <div role="status" aria-label="正在加载工作包" className="space-y-3"><Skeleton className="h-11 w-2/5" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (recordsError) return <div className="flex items-center justify-between gap-3 text-sm text-destructive"><p>工作包加载失败：{recordsError.message}</p><Button className="min-h-11" variant="outline" onClick={onRetryRecords}>重试</Button></div>;
  if (records.length === 0) return <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">还没有业务记录。请添加子任务，或先为工作包设置 PO。</p>;

  const prepareCapability = capabilities.data?.preparePackage;
  const poCapability = capabilities.data?.recordPoVerdict;
  const qaCapability = capabilities.data?.recordQaVerdict;
  const linkCapability = capabilities.data?.linkDefect;
  const reconcileCapability = capabilities.data?.reconcile;
  const escalateCapability = capabilities.data?.escalateAssignmentGaps;
  const permissionExplanation = [prepareCapability, poCapability, qaCapability].find((item) => item?.allowed === false)?.reason ?? null;

  return (
    <section className="space-y-3" aria-labelledby="work-package-title">
      <div className="h-20 overflow-y-auto sm:h-11" aria-live="polite">
        {!online ? <div role="status" className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><WifiOff className="size-4" />当前离线：保留最近确认状态，写操作已暂停；恢复连接后会自动核对。</div> : commandError ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">操作未完成：{commandError.message}。请求键已保留，可先原位核对再安全重试。</p> : null}
      </div>
      {permissionExplanation ? <p role="note" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">当前为只读权限：事实和范围预览仍可查看；准备派发、PO/QA 判定及缺口上报已禁用。{permissionExplanation}</p> : null}
      {persistedEscalation ? <p role="status" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">{assignmentEscalationMessage(persistedEscalation)}；工作包保持阻断，且不会覆盖已有负责人。</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="work-package-title" className="text-lg font-semibold">工作包与质量证据</h2><p className="text-sm text-muted-foreground">列表宽度保持稳定；详情在固定区域原位核对。</p></div>
        <div className="flex flex-wrap gap-2"><Button className="min-h-11" variant="outline" disabled={!online || checked.length === 0 || previewScope.isPending} onClick={() => previewScope.mutate("selected_records")}>预览所选 {checked.length || ""}</Button><Button className="min-h-11" disabled={!online || !selected || previewScope.isPending} onClick={() => previewScope.mutate("whole_package")}>预览整个工作包</Button></div>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Card className="self-start xl:col-span-2">
          <CardHeader><CardTitle>工作包行</CardTitle><CardDescription>业务、派发、质量和真实运行是四套独立状态。</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {ordered.map(({ record, depth }) => {
              const childRecords = childrenByParent.get(record.id) ?? [];
              const completeChildren = childRecords.filter((child) => child.businessStatus === "done").length;
              const firstHold = record.dependencies.find((item) => item.holdReason)?.holdReason;
              return <div key={record.id} className={`flex items-start gap-1 rounded-md border p-1 ${record.id === selectedId ? "bg-muted/50 ring-1 ring-ring" : ""}`} data-selected={record.id === selectedId ? "true" : "false"}>
                <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md focus-within:ring-2 focus-within:ring-ring"><span className="sr-only">选择 {record.title}</span><input aria-label={`选择 ${record.title}`} type="checkbox" className="size-4 accent-primary" checked={checked.includes(record.id)} onChange={(event) => setChecked((current) => event.target.checked ? [...new Set([...current, record.id])] : current.filter((id) => id !== record.id))} /></label>
                <button type="button" aria-current={record.id === selectedId ? "true" : undefined} className="min-h-11 min-w-0 flex-1 rounded-md p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedId(record.id)}>
                  <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{record.title}</span><StatusBadge record={record} liveStatus={liveAvailable && record.execution.issueId ? liveByIssue.get(record.execution.issueId) : undefined} liveUnknown={!liveAvailable} /></span>
                  <span className="mt-1 block text-xs text-muted-foreground">{depth > 0 ? "子项 · " : ""}{record.kind === "defect" ? "缺陷" : "计划"} · 执行 {record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? "未知" : "未分配"} · QA {record.qaAssigneeAgentId ? agentNames[record.qaAssigneeAgentId] ?? "未知" : "未分配"} · 业务 {BUSINESS[record.businessStatus]} · 派发 {DISPATCH[record.dispatchState]} · 质量 {QUALITY[record.quality.phase]} · 子项 {completeChildren}/{childRecords.length} · {firstHold ? `阻断 ${HOLD[firstHold] ?? firstHold}` : "无阻断"}</span>
                </button><ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </div>;
            })}
          </CardContent>
        </Card>

        <Card className="self-start xl:col-span-1">
          <CardHeader><CardTitle>原位详情</CardTitle><CardDescription>选择其他行不会挤压或移动列表。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {selected ? <>
              <div><h3 className="font-semibold">{selected.title}</h3><p className="text-xs text-muted-foreground">修订 {selected.revision} · 派发轮次 {selected.dispatchRound}</p></div>
              <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1"><Stat label="业务状态">{BUSINESS[selected.businessStatus]}</Stat><Stat label="派发状态">{DISPATCH[selected.dispatchState]}</Stat><Stat label="质量阶段">{QUALITY[selected.quality.phase]} · 第 {selected.quality.cycleNumber ?? 0} 轮</Stat><Stat label="下一责任">{nextOwner(selected, quality.data, agentNames)}</Stat><Stat label="真实运行">{!liveAvailable ? "暂不可确认" : selected.execution.issueId && liveByIssue.get(selected.execution.issueId) ? `真实${liveByIssue.get(selected.execution.issueId) === "running" ? "运行中" : "排队中"}` : selected.execution.lastRunStatus ? RUN[selected.execution.lastRunStatus] ?? `已结束 · ${selected.execution.lastRunStatus}` : "无实时运行"}</Stat><Stat label="执行投影">{PROJECTION[selected.execution.projectionState] ?? selected.execution.projectionState}{selected.execution.projectionError ? ` · ${selected.execution.projectionError}` : ""}</Stat><Stat label="缺陷证据">{selected.quality.defectCount} 条</Stat></dl>
              {selected.dependencies.length ? <div><h4 className="text-sm font-medium">依赖与阻断</h4><ul className="mt-1 space-y-1 text-sm text-muted-foreground">{selected.dependencies.map((item) => <li key={item.predecessorRecordId}>{item.title}{item.holdReason ? ` · ${HOLD[item.holdReason] ?? item.holdReason}` : " · 已满足"}</li>)}</ul></div> : <p className="text-sm text-muted-foreground">无前置依赖。</p>}
              <div><h4 className="text-sm font-medium">通知证据</h4><p className="text-sm text-muted-foreground">{deliveryLabel(selected).delivered}</p><p className="text-sm text-muted-foreground">{deliveryLabel(selected).acknowledged}</p></div>
              {selected.recovery.canReconcile ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="text-destructive">{selected.recovery.message ?? "状态需要重新核对"}</p><Button className="mt-2 min-h-11" variant="outline" size="sm" disabled={!online || reconcileCapability?.allowed !== true || reconcileRecord.isPending} onClick={() => reconcileRecord.mutate(selected.id)}><RefreshCw className="mr-2 size-4" />重新核对当前记录</Button>{reconcileCapability?.allowed === false ? <p className="mt-2 text-xs text-muted-foreground">{reconcileCapability.reason}</p> : null}</div> : null}
              {selected.execution.issueId ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline" to={`/issues/${selected.execution.issueIdentifier ?? selected.execution.issueId}`}>打开唯一主任务 {selected.execution.issueIdentifier ?? ""}</Link> : <p className="text-sm text-muted-foreground">尚未建立主任务。</p>}
              {selected.execution.lastRunId && selected.execution.lastRunAgentId ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline" to={`/agents/${selected.execution.lastRunAgentId}/runs/${selected.execution.lastRunId}`}>打开最近真实运行</Link> : null}
            </> : null}
          </CardContent>
        </Card>
      </div>

      {preview ? <Card><CardHeader><CardTitle>派发前范围预览</CardTitle><CardDescription>{previewMode === "whole_package" ? "整个工作包" : "仅所选记录"} · {preview.recordCount} 项 · {preview.edgeCount} 条依赖 · 最大深度 {preview.maxDepth}</CardDescription></CardHeader><CardContent className="space-y-4">
        {previewMode === "selected_records" ? <p className="rounded-md bg-muted/50 p-3 text-sm">只处理下列所选记录；不会派发父项、兄弟项或前置记录。未满足的前置仍会保持来源阻断。</p> : <p className="rounded-md bg-muted/50 p-3 text-sm">范围根记录：{recordTitle(records, preview.rootRecordId)}。已有关联会复用，已完成项不会重启。</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Stat label="将新建">{previewCounts.create}</Stat><Stat label="将复用">{previewCounts.reuse}</Stat><Stat label="保持完成">{previewCounts.completed}</Stat><Stat label="安全受阻">{previewCounts.blocked}</Stat></div>
        {!preview.eligibility.canPrepare ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="font-medium text-destructive">负责人缺口会阻断整包派发</p><ul className="mt-2 space-y-1 text-muted-foreground">{preview.eligibility.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.recordId}`}>{blocker.title} · 缺少 {blocker.requiredRole}</li>)}</ul><div className="mt-3 flex flex-wrap items-center gap-3"><Button className="min-h-11" variant="outline" disabled={!online || previewMode !== "whole_package" || escalateCapability?.allowed !== true || escalateAssignmentGaps.isPending || Boolean(persistedEscalation)} onClick={() => escalateAssignmentGaps.mutate()}>{persistedEscalation ? "已上报 CEO" : "上报 CEO 协调"}</Button>{persistedEscalation ? <p className="text-muted-foreground">{assignmentEscalationMessage(persistedEscalation)}；不会覆盖已有负责人。</p> : <p className="text-muted-foreground">上报只记录缺口，不会覆盖已有负责人。</p>}</div>{escalateCapability?.allowed === false ? <p className="mt-2 text-xs text-muted-foreground">{escalateCapability.reason}</p> : null}</div> : null}
        <div><h4 className="text-sm font-medium">范围记录</h4><ul className="mt-2 space-y-2">{preview.records.map((item) => { const current = records.find((record) => record.id === item.id); const hold = current?.dependencies.find((dependency) => dependency.holdReason); return <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{item.depth > 0 ? "子项 · " : "父项 · "}{item.title}</p><p className="mt-1 text-xs text-muted-foreground">执行 {item.assigneeAgentId ? agentNames[item.assigneeAgentId] ?? "未知" : "未分配"} · QA {item.qaAssigneeAgentId ? agentNames[item.qaAssigneeAgentId] ?? "未知" : "未分配"}{hold ? ` · ${HOLD[hold.holdReason!] ?? hold.holdReason}` : ""}</p></div><Badge variant={hold ? "destructive" : "secondary"}>{previewDisposition(current)}</Badge></li>; })}</ul></div>
        {preview.edges.length > 0 ? <div><h4 className="text-sm font-medium">依赖边</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{preview.edges.map((edge) => <li key={`${edge.predecessorRecordId}:${edge.successorRecordId}`}>{recordTitle(records, edge.predecessorRecordId)} → {recordTitle(records, edge.successorRecordId)}</li>)}</ul></div> : <p className="text-sm text-muted-foreground">范围内没有依赖边。</p>}
        <p className="break-all font-mono text-xs text-muted-foreground">范围摘要 {preview.scopeDigest}</p><div className="flex flex-wrap items-center justify-end gap-3">{prepareCapability?.allowed === false ? <p className="text-sm text-muted-foreground">{prepareCapability.reason}</p> : null}<Button className="min-h-11" disabled={!online || prepareCapability?.allowed !== true || !preview.eligibility.canPrepare || prepare.isPending} onClick={() => prepare.mutate()}><PackageCheck className="mr-2 size-4" />确认范围并准备派发</Button></div>
      </CardContent></Card> : null}

      {batch.data ? <Card><CardHeader><CardTitle>最近派发批次</CardTitle><CardDescription>{BATCH[batch.data.batch.state] ?? batch.data.batch.state} · {batch.data.items.length} 项 · <span className="break-all font-mono">{batch.data.batch.id}</span></CardDescription></CardHeader><CardContent><div className="flex flex-wrap gap-2">{batch.data.items.map((item) => <Badge key={item.id} variant={item.materializationState === "failed" || item.materializationState === "blocked" ? "destructive" : "secondary"}>{records.find((record) => record.id === item.recordId)?.title ?? item.recordId} · {MATERIALIZATION[item.materializationState] ?? item.materializationState}</Badge>)}</div>{batch.data.batch.state === "failed" || batch.data.batch.state === "blocked" ? <Button className="mt-3 min-h-11" variant="outline" disabled={!online || reconcileCapability?.allowed !== true || reconcile.isPending} onClick={() => reconcile.mutate()}><RefreshCw className="mr-2 size-4" />原位核对并恢复</Button> : null}</CardContent></Card> : null}

      {selected ? <Card><CardHeader><CardTitle>质量轮次与专用命令</CardTitle><CardDescription>PO 与 QA 使用独立命令；原因和证据随判定留存。</CardDescription></CardHeader><CardContent className="space-y-4">
        {quality.isLoading ? <p className="text-sm text-muted-foreground">正在加载质量证据…</p> : null}
        {quality.error ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"><p>质量证据加载失败：{quality.error.message}</p><Button className="min-h-11" variant="outline" size="sm" disabled={!online || quality.isFetching} onClick={() => quality.refetch()}>重试加载</Button></div> : null}
        {activeCycle ? <><div className="flex flex-wrap gap-2"><Badge>第 {activeCycle.cycleNumber} 轮</Badge><Badge variant="secondary">{QUALITY[activeCycle.qualityPhase]}</Badge><Badge variant="outline">{CYCLE_KIND[activeCycle.kind] ?? activeCycle.kind}</Badge></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{(quality.data?.items ?? []).map((item) => <div key={item.id} className="rounded-md border p-3"><p className="text-sm font-medium">{ROLE[item.role]} · {ITEM_STATE[item.state]}</p><p className="mt-1 text-xs text-muted-foreground">{records.find((record) => record.id === item.recordId)?.title ?? item.recordId}{item.defectRecordId ? ` · 缺陷 ${recordTitle(records, item.defectRecordId)}` : ""}</p></div>)}</div>
          <label className="block space-y-1 text-sm font-medium"><span>判定原因</span><Textarea value={reason} onChange={(event) => { setReason(event.target.value); updateDraft({ reason: event.target.value }); }} placeholder="必填：说明通过或退回依据" /></label>
          <label className="block space-y-1 text-sm font-medium"><span>证据引用（每行一个）</span><Textarea value={evidenceRefs} onChange={(event) => { setEvidenceRefs(event.target.value); updateDraft({ evidenceRefs: event.target.value }); }} placeholder="artifact://…" /></label>
          <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-sm font-medium"><span>缺陷记录</span><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={defectRecordId} onChange={(event) => { setDefectRecordId(event.target.value); updateDraft({ defectRecordId: event.target.value }); }}><option value="">请选择</option>{records.filter((record) => record.kind === "defect").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label><label className="space-y-1 text-sm font-medium"><span>原修复记录（可选）</span><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={repairRecordId} onChange={(event) => { setRepairRecordId(event.target.value); updateDraft({ repairRecordId: event.target.value }); }}><option value="">归属不明，交 PO 判断</option>{records.filter((record) => record.kind === "plan" && record.id !== selected.id).map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label></div>
          <div className="flex flex-wrap gap-2"><Button className="min-h-11" variant="outline" disabled={!online || linkCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || linkDefect.isPending} onClick={() => linkDefect.mutate()}>{repairRecordId ? "关联缺陷证据" : "关联缺陷并交 PO 判断"}</Button><Button className="min-h-11" variant="outline" disabled={!online || qaCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || qaVerdict.isPending} onClick={() => qaVerdict.mutate("return")}>QA 退回</Button><Button className="min-h-11" variant="outline" disabled={!online || qaCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || qaVerdict.isPending} onClick={() => qaVerdict.mutate("pass")}>QA 通过</Button><Button className="min-h-11" variant="outline" disabled={!online || poCapability?.allowed !== true || !reason.trim() || !poItem || checked.length === 0 || poVerdict.isPending} onClick={() => poVerdict.mutate("return")}>PO 退回所选</Button><Button className="min-h-11" disabled={!online || poCapability?.allowed !== true || !reason.trim() || !poItem || poVerdict.isPending} onClick={() => poVerdict.mutate("approve")}>PO 验收通过</Button></div>
          {poCapability?.allowed === false || qaCapability?.allowed === false ? <p className="text-sm text-muted-foreground">PO/QA 写入已按权限预先禁用：{poCapability?.reason ?? qaCapability?.reason}</p> : null}
        </> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" />当前没有开放质量轮次。</div>}
        {(quality.data?.links.length ?? 0) > 0 ? <div><h4 className="text-sm font-medium">缺陷与原任务关系</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{quality.data!.links.map((link) => <li key={link.id}>{recordTitle(records, link.defectRecordId)} → 修复 {recordTitle(records, link.repairRecordId)} → QA {recordTitle(records, link.qaRecordId)}</li>)}</ul></div> : null}
        {(quality.data?.history.cycles.length ?? 0) > 0 ? <div><h4 className="text-sm font-medium">返工与验收历史</h4><ol className="mt-2 space-y-3 border-l pl-4">{quality.data!.history.cycles.map((cycle) => { const verdicts = quality.data!.history.verdicts.filter((verdict) => verdict.cycleId === cycle.id); return <li key={cycle.id} className="space-y-2"><div><p className="text-sm font-medium">第 {cycle.cycleNumber} 轮 · {QUALITY[cycle.qualityPhase]} · {CYCLE_STATE[cycle.state] ?? cycle.state}</p><p className="text-xs text-muted-foreground">{CYCLE_KIND[cycle.kind] ?? cycle.kind} · {cycle.reason ?? "未记录轮次原因"} · {time(cycle.createdAt)}</p></div>{verdicts.length > 0 ? <ul className="space-y-2">{verdicts.map((verdict) => <li key={verdict.id} className="rounded-md bg-muted/50 p-3 text-sm"><p className="font-medium">{VERDICT[verdict.outcome] ?? verdict.outcome} · {verdict.defectRecordId ? recordTitle(records, verdict.defectRecordId) : "工作包"}</p><p className="mt-1 text-muted-foreground">{verdict.reason ?? "未记录判定原因"} · {time(verdict.createdAt)}</p>{verdict.evidenceRefs.length > 0 ? <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">{verdict.evidenceRefs.map((ref) => <li key={ref} className="break-all">{ref}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">未附证据引用</p>}</li>)}</ul> : <p className="text-xs text-muted-foreground">本轮尚无判定。</p>}</li>; })}</ol></div> : null}
      </CardContent></Card> : null}
    </section>
  );
}
