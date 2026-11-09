import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { l10n } from "@/i18n";
import { displayLocale } from "@/i18n/display";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deriveWorkRecordDisplayState, type WakeupRequestStatus, type WorkPackageAssignmentEscalationReceipt, type WorkPackageDispatchPreview, type WorkRecord, type WorkRecordKind, type WorkRecordQualityView } from "@paperclipai/shared";
import { CheckCircle2, PackageCheck, RefreshCw, WifiOff, X } from "lucide-react";
import { heartbeatsApi } from "@/api/heartbeats";
import { ApiError } from "@/api/client";
import { workRecordsApi } from "@/api/work-records";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "@/lib/status-colors";
import { localizeWorkRecordRecoveryMessage } from "@/lib/work-record-message-localization";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { WorkRecordDenseTable } from "@/components/WorkRecordDenseTable";

const BUSINESS: Record<string, string> = { backlog: "local.backlog_bf986e9a", todo: "local.todo_4ff402d7", in_progress: "local.in_progress_c1f88e9d", in_review: "local.in_review_c3905914", blocked: "local.blocked_18f2a094", done: "local.done_11a6767d", cancelled: "local.cancelled_d353a99e" };
const SEVERITY: Record<string, string> = { critical: "local.work_record_severity_critical", high: "local.work_record_severity_high", medium: "local.work_record_severity_medium", low: "local.work_record_severity_low" };
const DISPATCH: Record<string, string> = { not_dispatched: "local.work_record_not_dispatched", preparing: "local.work_record_preparing", blocked: "local.work_record_waiting_for_predecessor", linked: "local.work_record_linked", queued: "local.work_record_dispatch_queued", failed: "local.work_record_failed" };
const QUALITY: Record<string, string> = { not_started: "local.work_record_not_started", waiting_children: "local.work_record_waiting_for_children", qa_initial: "local.work_record_qa_initial_review", waiting_fix: "local.work_record_waiting_for_fix", qa_retest: "local.work_record_qa_retest", po_acceptance: "local.work_record_po_acceptance", impact_review: "local.work_record_impact_review", approval_wait: "local.work_record_waiting_for_approval", accepted: "local.work_record_accepted", attention_required: "local.work_record_needs_attention" };
const DISPLAY: Record<string, string> = { running: "local.work_record_running", queued: "local.work_record_run_queued", unknown: "local.work_record_run_status_unknown", preparing: "local.work_record_preparing_dispatch", failed: "local.work_record_dispatch_failed", blocked: "local.work_record_waiting_for_predecessor", linked: "local.work_record_waiting_for_scheduling", not_dispatched: "local.work_record_not_dispatched", conflict: "local.work_record_status_conflict", done: "local.done_11a6767d", cancelled: "local.cancelled_d353a99e", ended: "local.work_record_run_ended", stale: "local.work_record_projection_stale", error: "local.work_record_projection_error" };
const ITEM_STATE: Record<string, string> = { waiting: "local.work_record_waiting", blocked: "local.blocked_18f2a094", ready: "local.work_record_ready", active: "local.work_record_active", submitted: "local.work_record_awaiting_verdict", accepted: "local.work_record_approved", rejected: "local.work_record_returned", superseded: "local.work_record_superseded", cancelled: "local.cancelled_d353a99e" };
const ROLE: Record<string, string> = { repair: "local.work_record_repair_role", qa: "QA", po: "PO" };
const HOLD: Record<string, string> = { prerequisite_not_dispatched: "local.work_record_predecessor_not_dispatched", prerequisite_not_completed: "local.work_record_predecessor_not_complete", prerequisite_cancelled_impact_pending: "local.work_record_predecessor_cancelled_waiting_for_po", delivery_sync_pending: "local.work_record_waiting_for_delivery_sync", native_dependency_pending: "local.work_record_waiting_for_native_task_dependency", release_pending: "local.work_record_waiting_for_release", release_failed: "local.work_record_release_failed", quality_gate_pending: "local.work_record_waiting_for_quality_gate", approval_pending: "local.work_record_waiting_for_approval" };
const PROJECTION: Record<string, string> = { none: "local.work_record_no_projection_yet", current: "local.work_record_reconciled", stale: "local.work_record_projection_stale", error: "local.work_record_projection_error" };
const RUN: Record<string, string> = { succeeded: "local.work_record_completed_successfully", failed: "local.work_record_ended_with_failure", cancelled: "local.cancelled_d353a99e", timed_out: "local.work_record_timed_out", running: "local.work_record_running", queued: "local.work_record_queue_in_progress" };
const CYCLE_KIND: Record<string, string> = { package_acceptance: "local.work_record_work_package_acceptance", package_rework: "local.work_record_work_package_rework", defect_rework: "local.work_record_defect_rework", standalone_defect: "local.work_record_standalone_defect" };
const CYCLE_STATE: Record<string, string> = { open: "local.in_progress_c1f88e9d", accepted: "local.work_record_accepted", superseded: "local.work_record_superseded_by_next_cycle", cancelled: "local.cancelled_d353a99e" };
const VERDICT: Record<string, string> = { approve: "local.work_record_po_approved_verdict", pass: "local.work_record_qa_passed_verdict", return: "local.work_record_return" };
// The outbox values are constrained by work_record_outbox_state_check in the DB schema.
const DELIVERY_STATE_LABELS: Record<string, string> = { pending: "local.work_record_delivery_pending", processing: "local.work_record_delivery_processing", retry: "local.work_record_delivery_retry", delivered: "local.work_record_delivery_delivered", superseded: "local.work_record_delivery_superseded", dead_letter: "local.work_record_delivery_dead_letter" };
const WAKE_STATE_LABELS: Record<WakeupRequestStatus, string> = { queued: "local.work_record_wake_queued", deferred_issue_execution: "local.work_record_wake_deferred", claimed: "local.work_record_wake_claimed", coalesced: "local.work_record_wake_coalesced", skipped: "local.work_record_wake_skipped", completed: "local.work_record_wake_completed", failed: "local.work_record_wake_failed", cancelled: "local.work_record_wake_cancelled" };
function stateLabelKey(labels: Record<string, string>, state: string | null): string | null {
  return state && Object.prototype.hasOwnProperty.call(labels, state) ? labels[state] : null;
}
const BATCH: Record<string, string> = { preparing: "local.work_record_preparing", prepared: "local.work_record_prepared", blocked: "local.blocked_18f2a094", failed: "local.work_record_failed", completed: "local.done_11a6767d" };
const MATERIALIZATION: Record<string, string> = { pending: "local.work_record_pending", created: "local.work_record_created", reused: "local.work_record_reused", completed: "local.work_record_keep_completed", blocked: "local.work_record_safely_blocked", failed: "local.work_record_failed" };
const QA_COVERAGE: Record<string, string> = { qa_coverage_missing: "local.work_record_qa_coverage_missing", qa_outside_package: "local.work_record_qa_outside_package", qa_unavailable: "local.work_record_qa_unavailable", qa_dependency_missing: "local.work_record_qa_dependency_missing" };
const DISPLAY_TONE: Record<string, string> = { running: "running", queued: "queued", preparing: "pending", blocked: "blocked", failed: "failed", conflict: "error", error: "error", done: "done", cancelled: "cancelled", ended: "backlog", linked: "backlog", not_dispatched: "backlog", unknown: "warning", stale: "warning" };

function mappedLabel(map: Record<string, string>, value: string): string | undefined {
  const key = map[value];
  return key ? l10n(key) : undefined;
}

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
  if (!value) return l10n("local.work_record_not_confirmed_yet");
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? l10n("local.work_record_time_unknown") : parsed.toLocaleString(displayLocale());
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
  if (!recordId) return l10n("local.work_record_not_specified");
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
  if (category === "completed") return l10n("local.work_record_keep_completed");
  if (category === "blocked") return record?.execution.issueId ? l10n("local.work_record_reuse_native_task_and_remain_safely_") : l10n("local.work_record_create_link_and_remain_safely_blocke");
  if (category === "reuse") return l10n("local.work_record_reuse_native_task");
  return l10n("local.work_record_will_create");
}

function nextOwner(record: WorkRecord, quality: WorkRecordQualityView | undefined, agentNames: Record<string, string>) {
  const phase = record.quality.phase;
  if (phase === "po_acceptance" || phase === "impact_review") return record.assigneeAgentId ? l10n("local.work_record_role_owner", { role: "PO", name: agentNames[record.assigneeAgentId] ?? l10n("local.work_record_unknown") }) : l10n("local.work_record_po_unassigned");
  if (phase === "qa_initial" || phase === "qa_retest") return record.qaAssigneeAgentId ? l10n("local.work_record_role_owner", { role: "QA", name: agentNames[record.qaAssigneeAgentId] ?? l10n("local.work_record_unknown") }) : l10n("local.work_record_qa_unassigned");
  if (phase === "approval_wait") return "Jack / Board";
  const active = quality?.items.find((item) => ["ready", "active", "submitted", "blocked"].includes(item.state));
  if (active?.role === "po") return record.assigneeAgentId ? l10n("local.work_record_role_owner", { role: "PO", name: agentNames[record.assigneeAgentId] ?? l10n("local.work_record_unknown") }) : l10n("local.work_record_po_unassigned");
  if (active?.role === "qa") return record.qaAssigneeAgentId ? l10n("local.work_record_role_owner", { role: "QA", name: agentNames[record.qaAssigneeAgentId] ?? l10n("local.work_record_unknown") }) : l10n("local.work_record_qa_unassigned");
  return record.assigneeAgentId ? agentNames[record.assigneeAgentId] ?? l10n("local.work_record_unknown") : l10n("local.work_record_to_be_assigned");
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
      {mappedLabel(DISPLAY, state.state) ?? state.state}
    </Badge>
  );
}

function deliveryLabel(record: WorkRecord) {
  const deliveryState = record.delivery.deliveryState;
  const wakeStatus = record.delivery.wakeStatus;
  const deliveryKey = stateLabelKey(DELIVERY_STATE_LABELS, deliveryState);
  const wakeKey = stateLabelKey(WAKE_STATE_LABELS, wakeStatus);
  const delivered = deliveryState === "delivered" ? l10n("local.work_record_delivered_at", { time: time(record.delivery.deliveredAt) }) : deliveryState ? l10n("local.work_record_delivery_state", { state: deliveryKey ? l10n(deliveryKey) : l10n("local.work_record_unknown_state") }) : l10n("local.work_record_not_delivered_yet");
  const acknowledged = record.delivery.acknowledgedAt ? l10n("local.work_record_acknowledged_at", { time: time(record.delivery.acknowledgedAt) }) : wakeStatus ? l10n("local.work_record_ack_state", { state: wakeKey ? l10n(wakeKey) : l10n("local.work_record_unknown_state") }) : l10n("local.work_record_receipt_not_acknowledged_yet");
  return { delivered, acknowledged, unknownDeliveryState: deliveryState && !deliveryKey ? deliveryState : null, unknownWakeStatus: wakeStatus && !wakeKey ? wakeStatus : null };
}

function assignmentEscalationMessage(receipt: WorkPackageAssignmentEscalationReceipt) {
  if (receipt.state === "queued") return l10n("local.work_record_missing_owner_reported_to_ceo_coordi");
  if (receipt.state === "delivered") return l10n("local.work_record_missing_owner_reported_to_ceo_ceo_re");
  if (receipt.state === "acknowledged") return l10n("local.work_record_missing_owner_reported_to_ceo_ceo_ru");
  if (receipt.state === "ceo_unavailable") return l10n("local.work_record_missing_owner_recorded_but_no_ceo_is");
  if (receipt.state === "delivery_failed") return l10n("local.work_record_missing_owner_recorded_but_ceo_notif");
  return l10n("local.work_record_missing_owner_recorded_ceo_coordinat");
}

function assignmentEscalationRetryable(receipt: WorkPackageAssignmentEscalationReceipt | null) {
  return receipt?.state === "ceo_unavailable" || receipt?.state === "delivery_failed";
}

export function WorkPackageConsole({ companyId, projectId, records, visibleKind, agentNames, recordsLoading, recordsError, onRetryRecords, onEditRecord, onEditCoverage, onReopenRecord, reopeningRecordId, beforeViewSwitch, onViewDraftDirtyChange, registerLeaveGuard }: {
  companyId: string;
  projectId: string;
  records: WorkRecord[];
  visibleKind?: WorkRecordKind;
  agentNames: Record<string, string>;
  recordsLoading: boolean;
  recordsError: Error | null;
  onRetryRecords: () => unknown;
  onEditRecord?: (record: WorkRecord) => void;
  onEditCoverage?: (record: WorkRecord) => void;
  onReopenRecord?: (record: WorkRecord) => void;
  reopeningRecordId?: string | null;
  beforeViewSwitch?: () => Promise<boolean>;
  onViewDraftDirtyChange?: (dirty: boolean) => void;
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const queryClient = useQueryClient();
  const online = useConnectivity();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedTriggerRef = useRef<HTMLElement | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkPackageDispatchPreview | null>(null);
  const [previewMode, setPreviewMode] = useState<"whole_package" | "selected_records">("whole_package");
  const [reason, setReason] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [defectRecordId, setDefectRecordId] = useState("");
  const [repairRecordId, setRepairRecordId] = useState("");
  const closeDetails = () => {
    const previousId = selectedId;
    setSelectedId(null);
    window.setTimeout(() => (selectedTriggerRef.current ?? document.querySelector<HTMLElement>(`[data-record-id="${previousId}"] button`))?.focus(), 0);
  };
  const batchStorageKey = `work-package-batch:${companyId}:${projectId}`;
  const [batchId, setBatchId] = useState(() => localStorage.getItem(batchStorageKey) ?? "");

  const visibleRecords = useMemo(
    () => visibleKind ? records.filter((record) => record.kind === visibleKind) : records,
    [records, visibleKind],
  );
  useEffect(() => {
    if (selectedId && !visibleRecords.some((record) => record.id === selectedId)) setSelectedId(null);
    if (!visibleKind && visibleRecords.length > 0 && !selectedId) {
      setSelectedId(visibleRecords.find((record) => !record.parentRecordId)?.id ?? visibleRecords[0].id);
    }
  }, [selectedId, visibleKind, visibleRecords]);
  useEffect(() => {
    setChecked((current) => current.filter((id) => visibleRecords.some((record) => record.id === id)));
  }, [visibleRecords]);
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

  const selected = visibleRecords.find((record) => record.id === selectedId) ?? null;
  const selectRecord = async (recordId: string) => {
    if (recordId === selectedId) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (beforeViewSwitch && !(await beforeViewSwitch())) return;
    selectedTriggerRef.current = trigger;
    setSelectedId(recordId);
  };
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
  const selectedRoot = useMemo(() => {
    if (!selected) return null;
    const byId = new Map(records.map((record) => [record.id, record]));
    let current = selected; const seen = new Set<string>();
    while (current.parentRecordId && !seen.has(current.id)) {
      seen.add(current.id); const parent = byId.get(current.parentRecordId); if (!parent) break; current = parent;
    }
    return current;
  }, [records, selected]);

  const liveRuns = useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId), refetchInterval: online ? 5_000 : false });
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
      if (!preview) throw new Error(l10n("local.work_record_preview_the_scope_first"));
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
      if (!preview) throw new Error(l10n("local.work_record_preview_the_whole_work_package_first"));
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
  const dispatchRecord = useMutation({
    mutationFn: (record: WorkRecord) => workRecordsApi.dispatch(companyId, projectId, record.id, {
      expectedRevision: record.revision,
      clientRequestId: crypto.randomUUID(),
    }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }),
  });

  const activeCycle = quality.data?.cycle ?? null;
  const poItem = quality.data?.items.find((item) => item.role === "po") ?? null;
  const qaItem = quality.data?.items.find((item) => item.role === "qa") ?? null;
  const qaRecordId = qaItem?.recordId ?? "";
  const commandDone = async () => { setReason(""); setEvidenceRefs(""); setDefectRecordId(""); setRepairRecordId(""); if (qualityDraftKey) sessionStorage.removeItem(qualityDraftKey); await quality.refetch(); await queryClient.invalidateQueries({ queryKey: queryKeys.workRecords.list(companyId, projectId) }); };
  const poVerdict = useMutation({
    mutationFn: (outcome: "approve" | "return") => {
      if (!selected || !activeCycle || !poItem) throw new Error(l10n("local.work_record_no_actionable_po_acceptance_item"));
      const key = `quality:po:${activeCycle.id}:${poItem.id}:${outcome}`;
      return workRecordsApi.recordPoVerdict(companyId, projectId, selected.id, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, itemId: poItem.id, expectedCycleRevision: activeCycle.revision, outcome, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs), targetRecordIds: outcome === "return" ? checked : [] });
    }, onSuccess: commandDone,
  });
  const qaVerdict = useMutation({
    mutationFn: (outcome: "pass" | "return") => {
      if (!selected || !activeCycle || !qaItem || !defectRecordId) throw new Error(l10n("local.work_record_select_defect_confirm_qa_acceptance"));
      const key = `quality:qa:${activeCycle.id}:${qaItem.id}:${outcome}`;
      return workRecordsApi.recordQaVerdict(companyId, projectId, selected.id, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, itemId: qaItem.id, expectedCycleRevision: activeCycle.revision, outcome, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs), defectRecordId, repairRecordId: outcome === "return" ? repairRecordId || null : null });
    }, onSuccess: commandDone,
  });
  const linkDefect = useMutation({
    mutationFn: () => {
      if (!selected || !activeCycle || !defectRecordId || !qaRecordId) throw new Error(l10n("local.work_record_select_defect_confirm_qa_record"));
      const key = `quality:defect:${activeCycle.id}:${defectRecordId}`;
      return workRecordsApi.linkDefect(companyId, projectId, { workflowVersion: 2, clientRequestId: sessionRequest(key), requestPayloadDigest: key, cycleId: activeCycle.id, expectedCycleRevision: activeCycle.revision, defectRecordId, packageRecordId: selected.id, repairRecordId: repairRecordId || null, qaRecordId, reason: reason.trim(), evidenceRefs: evidence(evidenceRefs) });
    }, onSuccess: commandDone,
  });
  const commandError = previewScope.error ?? prepare.error ?? escalateAssignmentGaps.error ?? reconcile.error ?? reconcileRecord.error ?? dispatchRecord.error ?? poVerdict.error ?? qaVerdict.error ?? linkDefect.error;
  const dispatchMissingFields = dispatchRecord.error instanceof ApiError
    ? ((dispatchRecord.error.body as { details?: { missingFields?: Array<{ field: string; label: string }> } } | null)?.details?.missingFields ?? [])
    : [];
  const previewCounts = preview?.records.reduce<Record<PreviewCategory, number>>((counts, item) => {
    counts[previewCategory(records.find((record) => record.id === item.id))] += 1;
    return counts;
  }, { create: 0, reuse: 0, completed: 0, blocked: 0 }) ?? { create: 0, reuse: 0, completed: 0, blocked: 0 };
  const persistedEscalation = assignmentEscalation.data
    ?? preview?.eligibility.escalation
    ?? escalateAssignmentGaps.data
    ?? null;
  const escalationRetryable = assignmentEscalationRetryable(persistedEscalation);

  const surfaceLabel = visibleKind === "defect" ? l10n("local.work_record_defect") : visibleKind === "plan" ? l10n("local.work_record_plan") : l10n("local.work_record_business_records");
  const notification = selected ? deliveryLabel(selected) : null;
  const packageActionsEnabled = visibleKind !== "defect";

  if (recordsLoading) return <div role="status" aria-label={l10n("local.work_record_loading_kind", { kind: surfaceLabel })} className="space-y-3"><Skeleton className="h-11 w-2/5" />{Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>;
  if (recordsError) return <div className="flex min-h-11 items-center justify-between gap-3 text-sm text-destructive"><p>{l10n("local.work_record_kind_load_failed", { kind: surfaceLabel })}{recordsError.message}</p><Button variant="outline" onClick={onRetryRecords}>{l10n("local.work_record_retry")}</Button></div>;
  if (visibleRecords.length === 0) return <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{l10n(visibleKind === "plan" ? "local.work_record_empty_plan" : visibleKind === "defect" ? "local.work_record_empty_defect" : "local.work_record_empty_business_records")}</div>;

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
        {!online ? <div role="status" className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><WifiOff className="size-4" />{l10n("local.work_record_offline_the_last_confirmed_state_is_")}</div> : commandError ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{l10n("local.work_record_operation_incomplete")}{commandError.message}{l10n("local.work_record_the_request_key_is_retained_check_he")}</p> : null}
      </div>
      {permissionExplanation ? <p role="note" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">{permissionExplanation}</p> : null}
      {persistedEscalation ? <p role="status" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">{assignmentEscalationMessage(persistedEscalation)}{l10n("local.work_record_the_work_package_stays_blocked_and_e")}</p> : null}
      <div className="flex min-h-11 flex-wrap items-end justify-between gap-3">
        <div><h2 id="work-package-title" className="text-base font-semibold">{visibleKind === "defect" ? l10n("local.work_record_defects_and_quality_evidence") : l10n("local.work_record_work_packages_and_quality_evidence")}</h2><p className="text-sm text-muted-foreground">{l10n("local.work_record_select_a_row_to_view_details_the_lis")}</p></div>
        {packageActionsEnabled ? <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!online || checked.length === 0 || previewScope.isPending} onClick={() => previewScope.mutate("selected_records")}>{l10n("local.work_record_preview_selected")} {checked.length || ""}</Button><Button disabled={!online || !selected || previewScope.isPending} onClick={() => previewScope.mutate("whole_package")}>{l10n("local.work_record_preview_whole_work_package")}</Button></div> : <div className="min-h-9" aria-hidden="true" />}
      </div>
      <div className={cn("items-start gap-4", selected && "grid xl:grid-cols-3")}>
        <Card className={cn("self-start", selected && "xl:col-span-2")}>
          <CardHeader className="py-3"><CardTitle>{l10n("local.work_record_kind_list", { kind: surfaceLabel })}</CardTitle><CardDescription>{l10n("local.work_record_business_dispatch_quality_and_live_r")}</CardDescription>{visibleRecords[0] ? <StatusBadge record={visibleRecords[0]} liveStatus={liveAvailable ? liveByIssue.get(visibleRecords[0].execution.issueId ?? "") : undefined} liveUnknown={!liveAvailable} /> : null}</CardHeader>
          <CardContent>
            {visibleKind ? <WorkRecordDenseTable companyId={companyId} projectId={projectId} kind={visibleKind} records={visibleRecords} agentNames={agentNames} selectedId={selectedId} checked={checked} onSelect={(recordId) => { void selectRecord(recordId); }} onChecked={setChecked} beforeViewSwitch={beforeViewSwitch ?? (async () => true)} onViewDraftDirtyChange={onViewDraftDirtyChange} registerLeaveGuard={registerLeaveGuard} /> : null}
          </CardContent>
        </Card>

        {selected ? <Card className="self-start xl:col-span-1" data-testid="work-record-detail-drawer" role="region" aria-label={l10n("local.work_record_full_details")} aria-current="true" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") closeDetails(); }}>
          <CardHeader><div className="flex items-start justify-between gap-2"><div><CardTitle>{l10n("local.work_record_details")}</CardTitle><CardDescription>{l10n("local.work_record_selecting_another_row_will_not_move_")}</CardDescription></div><Button size="icon" variant="ghost" aria-label={l10n("local.work_record_close_details")} onClick={closeDetails}><X className="size-4" /></Button></div></CardHeader>
          <CardContent className="space-y-4">
            {selected ? <>
              <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{selected.title}</h3><p className="text-xs text-muted-foreground">{l10n("local.work_record_revision")} {selected.revision} {l10n("local.work_record_dispatch_cycle")} {selected.dispatchRound}</p></div><div className="flex flex-wrap justify-end gap-2">{selected.kind === "defect" ? <Button size="sm" disabled={!online || prepareCapability?.allowed !== true || dispatchRecord.isPending} onClick={() => dispatchRecord.mutate(selected)}>{l10n("local.work_record_dispatch_defect")}</Button> : null}{onEditRecord ? <Button size="sm" variant="outline" onClick={() => onEditRecord(selected)}>{l10n("local.work_record_edit")}</Button> : null}</div></div>
              {dispatchMissingFields.length > 0 ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{l10n("local.work_record_dispatch_missing_fields")}</p><ul className="mt-1 list-disc pl-5">{dispatchMissingFields.map((item) => <li key={item.field}>{item.label}</li>)}</ul></div> : null}
              {onEditCoverage && selected.kind === "plan" && selected.parentRecordId && selected.packageQaRole === "execution" ? <Button size="sm" variant="outline" onClick={() => onEditCoverage(selected)}>{l10n("local.work_record_edit_qa_coverage")}</Button> : null}
              <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1"><Stat label={l10n("local.work_record_business_status")}>{mappedLabel(BUSINESS, selected.businessStatus)}</Stat><Stat label={l10n("local.work_record_dispatch_status")}>{mappedLabel(DISPATCH, selected.dispatchState)}</Stat><Stat label={l10n("local.work_record_quality_phase")}>{l10n("local.work_record_quality_cycle", { phase: mappedLabel(QUALITY, selected.quality.phase), count: selected.quality.cycleNumber ?? 0 })}</Stat><Stat label={l10n("local.work_record_next_owner")}>{nextOwner(selected, quality.data, agentNames)}</Stat><Stat label={l10n("local.work_record_live_run")}>{!liveAvailable ? l10n("local.work_record_cannot_confirm_yet") : selected.execution.issueId && liveByIssue.get(selected.execution.issueId) ? l10n("local.work_record_live_state", { state: liveByIssue.get(selected.execution.issueId) === "running" ? l10n("local.work_record_running") : l10n("local.work_record_queue_in_progress") }) : selected.execution.lastRunStatus ? mappedLabel(RUN, selected.execution.lastRunStatus) ?? l10n("local.work_record_ended_state", { state: selected.execution.lastRunStatus }) : l10n("local.work_record_no_live_run")}</Stat><Stat label={l10n("local.work_record_execution_projection")}>{mappedLabel(PROJECTION, selected.execution.projectionState) ?? selected.execution.projectionState}{selected.execution.projectionError ? ` · ${selected.execution.projectionError}` : ""}</Stat><Stat label={l10n("local.work_record_defect_evidence")}>{l10n("local.work_record_defect_evidence_count", { count: selected.quality.defectCount })}</Stat></dl>
              <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1"><Stat label={l10n("local.work_record_description")}>{selected.description || l10n("local.work_record_not_filled")}</Stat><Stat label={l10n("local.work_record_severity")}>{selected.defectSeverity ? mappedLabel(SEVERITY, selected.defectSeverity) ?? selected.defectSeverity : l10n("local.work_record_severity_unspecified")}</Stat><Stat label={l10n(selected.kind === "defect" ? "local.work_record_fixer" : "local.work_record_executor")}>{selected.assigneeAgentId ? agentNames[selected.assigneeAgentId] ?? selected.assigneeAgentId : l10n("local.work_record_pending_assignment")}</Stat><Stat label="QA">{selected.qaAssigneeAgentId ? agentNames[selected.qaAssigneeAgentId] ?? selected.qaAssigneeAgentId : l10n("local.work_record_pending_assignment")}</Stat><Stat label={l10n("local.work_record_iteration")}>{selected.iterationId ?? l10n("local.work_record_no_iteration")}</Stat><Stat label={l10n("local.work_record_plan_dates")}>{l10n("local.work_record_date_range", { start: selected.plannedStartDate ?? l10n("local.work_record_date_unset"), end: selected.plannedCompletionDate ?? l10n("local.work_record_date_unset") })}</Stat></dl>
              {selected.dependencies.length ? <div><h4 className="text-sm font-medium">{l10n("local.work_record_dependencies_and_blockers")}</h4><ul className="mt-1 space-y-1 text-sm text-muted-foreground">{selected.dependencies.map((item) => <li key={item.predecessorRecordId}>{item.title}{item.holdReason ? ` · ${mappedLabel(HOLD, item.holdReason) ?? item.holdReason}` : l10n("local.work_record_dependency_satisfied_spaced")}</li>)}</ul></div> : <p className="text-sm text-muted-foreground">{l10n("local.work_record_no_predecessor_dependencies")}</p>}
              <div><h4 className="text-sm font-medium">{l10n("local.work_record_notification_evidence")}</h4><p className="text-sm text-muted-foreground">{notification?.delivered}</p><p className="text-sm text-muted-foreground">{notification?.acknowledged}</p>{notification?.unknownDeliveryState || notification?.unknownWakeStatus ? <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{l10n("local.work_record_view_raw_delivery_status")}</summary>{notification.unknownDeliveryState ? <p>{l10n("local.work_record_raw_delivery_state", { code: notification.unknownDeliveryState })}</p> : null}{notification.unknownWakeStatus ? <p>{l10n("local.work_record_raw_wake_status", { code: notification.unknownWakeStatus })}</p> : null}</details> : null}</div>
              {selected.recovery.canReconcile ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="text-destructive">{localizeWorkRecordRecoveryMessage(selected.recovery.message)}</p><Button className="mt-2 min-h-11" variant="outline" size="sm" disabled={!online || reconcileCapability?.allowed !== true || reconcileRecord.isPending} onClick={() => reconcileRecord.mutate(selected.id)}><RefreshCw className="mr-2 size-4" />{l10n("local.work_record_reconcile_current_record")}</Button>{reconcileCapability?.allowed === false ? <p className="mt-2 text-xs text-muted-foreground">{reconcileCapability.reason}</p> : null}</div> : null}
              {selected.execution.issueId ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline" to={`/issues/${selected.execution.issueIdentifier ?? selected.execution.issueId}`}>{l10n("local.work_record_open_linked_native_task")} {selected.execution.issueIdentifier ?? ""}</Link> : <p className="text-sm text-muted-foreground">{l10n("local.work_record_no_native_task_linked_yet")}</p>}
              {selected.execution.lastRunId && selected.execution.lastRunAgentId ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline" to={`/agents/${selected.execution.lastRunAgentId}/runs/${selected.execution.lastRunId}`}>{l10n("local.work_record_open_latest_live_run")}</Link> : null}
              {onReopenRecord && (selected.businessStatus === "done" || selected.businessStatus === "cancelled") ? <Button variant="outline" disabled={reopeningRecordId === selected.id} onClick={() => onReopenRecord(selected)}>{reopeningRecordId === selected.id ? l10n("local.work_record_reopening") : l10n("local.work_record_reopen_defect")}</Button> : null}
            </> : null}
          </CardContent>
        </Card> : null}
      </div>

      {packageActionsEnabled && preview ? <Card><CardHeader><CardTitle>{l10n("local.work_record_scope_preview_before_dispatch")}</CardTitle><CardDescription>{previewMode === "whole_package" ? l10n("local.work_record_whole_work_package") : l10n("local.work_record_selected_records_only")} · {preview.recordCount} {l10n("local.work_record_items")} {preview.edgeCount} {l10n("local.work_record_dependencies_maximum_depth")} {preview.maxDepth}</CardDescription></CardHeader><CardContent className="space-y-4">
        {previewMode === "selected_records" ? <p className="rounded-md bg-muted/50 p-3 text-sm">{l10n("local.work_record_only_the_selected_records_below_are_")}</p> : <p className="rounded-md bg-muted/50 p-3 text-sm">{l10n("local.work_record_scope_root")}{recordTitle(records, preview.rootRecordId)}{l10n("local.work_record_existing_links_are_reused_and_comple")}</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><Stat label={l10n("local.work_record_will_create")}>{previewCounts.create}</Stat><Stat label={l10n("local.work_record_will_reuse")}>{previewCounts.reuse}</Stat><Stat label={l10n("local.work_record_keep_completed")}>{previewCounts.completed}</Stat><Stat label={l10n("local.work_record_safely_blocked")}>{previewCounts.blocked}</Stat></div>
        {preview.qaCoverageIssues.length > 0 ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="font-medium text-destructive">{l10n("local.work_record_qa_coverage_blocks_dispatch")}</p><ul className="mt-2 space-y-1 text-muted-foreground">{preview.qaCoverageIssues.map((issue, index) => <li key={`${issue.recordId}:${issue.qaRecordId ?? "none"}:${index}`}>{recordTitle(records, issue.recordId)} · {mappedLabel(QA_COVERAGE, issue.reason) ?? l10n("local.work_record_qa_coverage_invalid")}{issue.qaRecordId ? ` · ${recordTitle(records, issue.qaRecordId)}` : ""}</li>)}</ul></div> : null}
        {preview.eligibility.blockers.length > 0 ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="font-medium text-destructive">{l10n("local.work_record_missing_owners_block_the_whole_packa")}</p><ul className="mt-2 space-y-1 text-muted-foreground">{preview.eligibility.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.recordId}`}>{blocker.title} {l10n("local.work_record_missing")} {blocker.requiredRole}</li>)}</ul><div className="mt-3 flex flex-wrap items-center gap-3"><Button className="min-h-11" variant="outline" disabled={!online || previewMode !== "whole_package" || escalateCapability?.allowed !== true || escalateAssignmentGaps.isPending || Boolean(persistedEscalation && !escalationRetryable)} onClick={() => escalateAssignmentGaps.mutate()}>{escalationRetryable ? l10n("local.work_record_retry_ceo_report") : persistedEscalation ? l10n("local.work_record_reported_to_ceo") : l10n("local.work_record_report_to_ceo")}</Button>{persistedEscalation ? <Button className="min-h-11" variant="ghost" disabled={!online || assignmentEscalation.isFetching} onClick={() => assignmentEscalation.refetch()}><RefreshCw className="mr-2 size-4" />{l10n("local.work_record_check_notification_status")}</Button> : null}{persistedEscalation ? <p className="text-muted-foreground">{assignmentEscalationMessage(persistedEscalation)}{l10n("local.work_record_existing_owners_will_be_preserved")}</p> : <p className="text-muted-foreground">{l10n("local.work_record_reporting_records_missing_owners_wit")}</p>}</div>{escalateCapability?.allowed === false ? <p className="mt-2 text-xs text-muted-foreground">{escalateCapability.reason}</p> : null}</div> : null}
        <div><h4 className="text-sm font-medium">{l10n("local.work_record_scope_records")}</h4><ul className="mt-2 space-y-2">{preview.records.map((item) => { const current = records.find((record) => record.id === item.id); const hold = current?.dependencies.find((dependency) => dependency.holdReason); return <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{item.depth > 0 ? l10n("local.work_record_child_prefix_spaced") : l10n("local.work_record_parent_prefix_spaced")}{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{l10n("local.work_record_execute")} {item.assigneeAgentId ? agentNames[item.assigneeAgentId] ?? l10n("local.work_record_unknown") : l10n("local.work_record_unassigned_owner")} · QA {item.qaAssigneeAgentId ? agentNames[item.qaAssigneeAgentId] ?? l10n("local.work_record_unknown") : l10n("local.work_record_unassigned_owner")}{hold ? ` · ${mappedLabel(HOLD, hold.holdReason!) ?? hold.holdReason}` : ""}</p></div><Badge variant={hold ? "destructive" : "secondary"}>{previewDisposition(current)}</Badge></li>; })}</ul></div>
        {preview.records.some((item) => item.packageQaRole === "execution") ? <div><h4 className="text-sm font-medium">{l10n("local.work_record_qa_retest_scope")}</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{preview.records.filter((item) => item.packageQaRole === "execution").map((item) => <li key={item.id}>{item.title} · {item.qaRetestExemptionReason ? `${l10n("local.work_record_qa_retest_waived")}${item.qaRetestExemptionReason}` : item.qaCoverageRecordIds.length > 0 ? `${l10n("local.work_record_qa_retest_by")}${item.qaCoverageRecordIds.map((id) => recordTitle(records, id)).join(displayLocale().startsWith("zh") ? "、" : ", ")}` : l10n("local.work_record_qa_coverage_missing")}</li>)}</ul></div> : null}
        {preview.edges.length > 0 ? <div><h4 className="text-sm font-medium">{l10n("local.work_record_dependency_edges")}</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{preview.edges.map((edge) => <li key={`${edge.predecessorRecordId}:${edge.successorRecordId}`}>{recordTitle(records, edge.predecessorRecordId)} → {recordTitle(records, edge.successorRecordId)}</li>)}</ul></div> : <p className="text-sm text-muted-foreground">{l10n("local.work_record_no_dependency_edges_in_this_scope")}</p>}
        <p className="break-all font-mono text-xs text-muted-foreground">{l10n("local.work_record_scope_summary")} {preview.scopeDigest}</p><div className="flex flex-wrap items-center justify-end gap-3">{prepareCapability?.allowed === false ? <p className="text-sm text-muted-foreground">{prepareCapability.reason}</p> : null}<Button className="min-h-11" disabled={!online || prepareCapability?.allowed !== true || !preview.eligibility.canPrepare || prepare.isPending} onClick={() => prepare.mutate()}><PackageCheck className="mr-2 size-4" />{l10n("local.work_record_confirm_scope_and_prepare_dispatch")}</Button></div>
      </CardContent></Card> : null}

      {packageActionsEnabled && batch.data ? <Card><CardHeader><CardTitle>{l10n("local.work_record_latest_dispatch_batch")}</CardTitle><CardDescription>{mappedLabel(BATCH, batch.data.batch.state) ?? batch.data.batch.state} · {batch.data.items.length} {l10n("local.work_record_items")} <span className="break-all font-mono">{batch.data.batch.id}</span></CardDescription></CardHeader><CardContent><div className="flex flex-wrap gap-2">{batch.data.items.map((item) => <Badge key={item.id} variant={item.materializationState === "failed" || item.materializationState === "blocked" ? "destructive" : "secondary"}>{records.find((record) => record.id === item.recordId)?.title ?? item.recordId} · {mappedLabel(MATERIALIZATION, item.materializationState) ?? item.materializationState}</Badge>)}</div>{batch.data.batch.state === "failed" || batch.data.batch.state === "blocked" ? <Button className="mt-3 min-h-11" variant="outline" disabled={!online || reconcileCapability?.allowed !== true || reconcile.isPending} onClick={() => reconcile.mutate()}><RefreshCw className="mr-2 size-4" />{l10n("local.work_record_reconcile_and_resume_here")}</Button> : null}</CardContent></Card> : null}

      {selected ? <Card><CardHeader><CardTitle>{l10n("local.work_record_quality_cycles_and_dedicated_actions")}</CardTitle><CardDescription>{l10n("local.work_record_po_and_qa_use_separate_actions_reaso")}</CardDescription></CardHeader><CardContent className="space-y-4">
        {quality.isLoading ? <p className="text-sm text-muted-foreground">{l10n("local.work_record_loading_quality_evidence")}</p> : null}
        {quality.error ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"><p>{l10n("local.work_record_failed_to_load_quality_evidence")}{quality.error.message}</p><Button className="min-h-11" variant="outline" size="sm" disabled={!online || quality.isFetching} onClick={() => quality.refetch()}>{l10n("local.work_record_retry_loading")}</Button></div> : null}
        {activeCycle && selected.kind === "plan" ? <><div className="flex flex-wrap gap-2"><Badge>{l10n("local.work_record_cycle_number", { count: activeCycle.cycleNumber })}</Badge><Badge variant="secondary">{mappedLabel(QUALITY, activeCycle.qualityPhase)}</Badge><Badge variant="outline">{mappedLabel(CYCLE_KIND, activeCycle.kind) ?? activeCycle.kind}</Badge></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{(quality.data?.items ?? []).map((item) => <div key={item.id} className="rounded-md border p-3"><p className="text-sm font-medium">{mappedLabel(ROLE, item.role)} · {mappedLabel(ITEM_STATE, item.state)}</p><p className="mt-1 text-xs text-muted-foreground">{records.find((record) => record.id === item.recordId)?.title ?? item.recordId}{item.defectRecordId ? l10n("local.work_record_defect_title", { title: recordTitle(records, item.defectRecordId) }) : ""}</p></div>)}</div>
          <label className="block space-y-1 text-sm font-medium"><span>{l10n("local.work_record_verdict_reason")}</span><Textarea value={reason} onChange={(event) => { setReason(event.target.value); updateDraft({ reason: event.target.value }); }} placeholder={l10n("local.work_record_required_explain_why_you_approve_or_")} /></label>
          <label className="block space-y-1 text-sm font-medium"><span>{l10n("local.work_record_evidence_references_one_per_line")}</span><Textarea value={evidenceRefs} onChange={(event) => { setEvidenceRefs(event.target.value); updateDraft({ evidenceRefs: event.target.value }); }} placeholder="artifact://…" /></label>
          <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-sm font-medium"><span>{l10n("local.work_record_defect_record")}</span><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={defectRecordId} onChange={(event) => { setDefectRecordId(event.target.value); updateDraft({ defectRecordId: event.target.value }); }}><option value="">{l10n("local.work_record_select_placeholder")}</option>{records.filter((record) => record.kind === "defect").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label><label className="space-y-1 text-sm font-medium"><span>{l10n("local.work_record_original_fix_record_optional")}</span><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={repairRecordId} onChange={(event) => { setRepairRecordId(event.target.value); updateDraft({ repairRecordId: event.target.value }); }}><option value="">{l10n("local.work_record_ownership_unclear_ask_po_to_decide")}</option>{records.filter((record) => record.kind === "plan" && record.id !== selected.id).map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label></div>
          <div className="flex flex-wrap gap-2"><Button className="min-h-11" variant="outline" disabled={!online || linkCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || linkDefect.isPending} onClick={() => linkDefect.mutate()}>{repairRecordId ? l10n("local.work_record_link_defect_evidence") : l10n("local.work_record_link_defect_and_ask_po_to_decide")}</Button><Button className="min-h-11" variant="outline" disabled={!online || qaCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || qaVerdict.isPending} onClick={() => qaVerdict.mutate("return")}>{l10n("local.work_record_qa_return")}</Button><Button className="min-h-11" variant="outline" disabled={!online || qaCapability?.allowed !== true || !reason.trim() || !qaItem || !defectRecordId || qaVerdict.isPending} onClick={() => qaVerdict.mutate("pass")}>{l10n("local.work_record_qa_pass")}</Button><Button className="min-h-11" variant="outline" disabled={!online || poCapability?.allowed !== true || !reason.trim() || !poItem || checked.length === 0 || poVerdict.isPending} onClick={() => poVerdict.mutate("return")}>{l10n("local.work_record_po_return_selected")}</Button><Button className="min-h-11" disabled={!online || poCapability?.allowed !== true || !reason.trim() || !poItem || poVerdict.isPending} onClick={() => poVerdict.mutate("approve")}>{l10n("local.work_record_po_accept")}</Button></div>
          {poCapability?.allowed === false || qaCapability?.allowed === false ? <p className="text-sm text-muted-foreground">{l10n("local.work_record_po_qa_writes_are_disabled_by_permiss")}{poCapability?.reason ?? qaCapability?.reason}</p> : null}
        </> : selected.kind === "defect" ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" />{l10n("local.work_record_defect_verdicts_are_maintained_by_th")}</div> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" />{l10n("local.work_record_no_open_quality_cycle")}</div>}
        {(quality.data?.links.length ?? 0) > 0 ? <div><h4 className="text-sm font-medium">{l10n("local.work_record_defect_and_original_task_links")}</h4><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{quality.data!.links.map((link) => <li key={link.id}>{recordTitle(records, link.defectRecordId)} {l10n("local.work_record_fix_link")} {recordTitle(records, link.repairRecordId)} → QA {recordTitle(records, link.qaRecordId)}</li>)}</ul></div> : null}
        {(quality.data?.history.cycles.length ?? 0) > 0 ? <div><h4 className="text-sm font-medium">{l10n("local.work_record_rework_and_acceptance_history")}</h4><ol className="mt-2 space-y-3 border-l pl-4">{quality.data!.history.cycles.map((cycle) => { const verdicts = quality.data!.history.verdicts.filter((verdict) => verdict.cycleId === cycle.id); return <li key={cycle.id} className="space-y-2"><div><p className="text-sm font-medium">{l10n("local.work_record_cycle_heading", { count: cycle.cycleNumber, phase: mappedLabel(QUALITY, cycle.qualityPhase), state: mappedLabel(CYCLE_STATE, cycle.state) ?? cycle.state })}</p><p className="text-xs text-muted-foreground">{mappedLabel(CYCLE_KIND, cycle.kind) ?? cycle.kind} · {cycle.reason ?? l10n("local.work_record_no_cycle_reason_recorded")} · {time(cycle.createdAt)}</p></div>{verdicts.length > 0 ? <ul className="space-y-2">{verdicts.map((verdict) => <li key={verdict.id} className="rounded-md bg-muted/50 p-3 text-sm"><p className="font-medium">{mappedLabel(VERDICT, verdict.outcome) ?? verdict.outcome} · {verdict.defectRecordId ? recordTitle(records, verdict.defectRecordId) : l10n("local.work_record_work_package")}</p><p className="mt-1 text-muted-foreground">{verdict.reason ?? l10n("local.work_record_no_verdict_reason_recorded")} · {time(verdict.createdAt)}</p>{verdict.evidenceRefs.length > 0 ? <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">{verdict.evidenceRefs.map((ref) => <li key={ref} className="break-all">{ref}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">{l10n("local.work_record_no_evidence_references")}</p>}</li>)}</ul> : <p className="text-xs text-muted-foreground">{l10n("local.work_record_no_verdicts_in_this_cycle")}</p>}</li>; })}</ol></div> : null}
      </CardContent></Card> : null}
    </section>
  );
}
