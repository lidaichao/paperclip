// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkRecord, WorkRecordKind } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  createWorkRecordDraftEnvelope,
  saveWorkRecordDraft,
  workRecordDraftStorageKey,
  workRecordEditorDraftFromRecord,
  type WorkRecordDraftScope,
  type WorkRecordEditorDraft,
} from "@/lib/work-record-autosave";
import { useWorkRecordAutosave } from "./use-work-record-autosave";

const api = vi.hoisted(() => ({ update: vi.fn(), list: vi.fn() }));
vi.mock("@/api/work-records", () => ({ workRecordsApi: api }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(overrides: Partial<WorkRecord> = {}): WorkRecord {
  const now = new Date("2026-11-10T00:00:00.000Z");
  return {
    id: "record-1", recordNumber: 1, recordIdentifier: "PT-1", companyId: "company-1", projectId: "project-1", kind: "plan",
    title: "任务", priority: "medium", description: "说明", descriptionRevision: 1, parentRecordId: null, iterationId: null,
    iterationAssignmentMode: "independent", plannedStartDate: null, plannedCompletionDate: null, defectSeverity: null, foundInVersionId: null,
    assigneeAgentId: null, qaAssigneeAgentId: null, userResponsibilities: [], packageQaRole: null, qaRetestExemptionReason: null,
    qaCoverageRecordIds: [], businessStatus: "todo", statusVersion: 1, revision: 1, dispatchState: "not_dispatched", dispatchRound: 0,
    dependencySetRevision: 1, blockedCycle: 0, dependencies: [],
    execution: { issueId: null, issueIdentifier: null, issueStatus: null, issueStatusVersion: null, lastRunId: null, lastRunStatus: null, lastRunAgentId: null, lastRunStartedAt: null, lastRunEndedAt: null, projectionState: "current", projectionError: null, projectedAt: now },
    recovery: { code: null, message: null, canReconcile: false, lastConfirmedAt: now },
    delivery: { eventKey: null, deliveryState: null, deliveredAt: null, attemptCount: 0, lastError: null, wakeRequestId: null, wakeStatus: null, acknowledgedAt: null, runId: null, recoveryCount: 0, deadLetteredAt: null, lastRecoveredAt: null },
    descriptionDelivery: { descriptionRevision: null, intentKey: null, state: null, commentId: null, attemptCount: 0, sourceRunId: null, successorRunId: null, wakeupRequestId: null, stopConfirmedAt: null, queuedAt: null, modelVisibleAt: null, confirmedAt: null, deliveredAt: null, acknowledgedAt: null, acknowledgedByAgentId: null, acknowledgedByRunId: null, lastError: null },
    quality: { cycleId: null, cycleNumber: null, cycleRevision: null, phase: "not_started", defectCount: 0 },
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useWorkRecordAutosave", () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentRecord: WorkRecord | null;
  let enabled: boolean;
  let kind: WorkRecordKind;
  let principalId: string;
  let setDraft!: Dispatch<SetStateAction<WorkRecordEditorDraft>>;
  let visibleDraft!: WorkRecordEditorDraft;
  let observed!: ReturnType<typeof useWorkRecordAutosave>;
  let onSaved: ReturnType<typeof vi.fn<(record: WorkRecord) => void>>;

  function Harness() {
    const [draft, updateDraft] = useState(() => currentRecord ? workRecordEditorDraftFromRecord(currentRecord) : workRecordEditorDraftFromRecord(record()));
    setDraft = updateDraft;
    visibleDraft = draft;
    observed = useWorkRecordAutosave({
      companyId: "company-1", projectId: "project-1", kind, principalId,
      record: currentRecord, draft, setDraft: updateDraft, enabled, onSaved,
    });
    return null;
  }

  const render = async () => { await act(async () => { root.render(<Harness />); }); };
  const advance = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
  const change = async (patch: Partial<WorkRecordEditorDraft>) => {
    await act(async () => { setDraft((current) => ({ ...current, ...patch })); });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    currentRecord = record();
    enabled = true;
    kind = "plan";
    principalId = "user-1";
    onSaved = vi.fn();
    api.list.mockResolvedValue([currentRecord]);
    api.update.mockImplementation(async (_companyId, _projectId, _recordId, patch) => record({
      ...patch,
      description: patch.description === undefined ? currentRecord?.description : patch.description,
      revision: (patch.expectedRevision as number) + 1,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces text for 900ms and saves non-text fields immediately", async () => {
    await render();
    await change({ title: "新标题" });
    await advance(899);
    expect(api.update).not.toHaveBeenCalled();
    await advance(1);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][3]).toMatchObject({ expectedRevision: 1, title: "新标题" });

    await change({ priority: "high" });
    await advance(0);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1][3]).toMatchObject({ expectedRevision: 2, priority: "high" });
  });

  it("serializes requests and rebases edits made while a save is in flight", async () => {
    const first = deferred<WorkRecord>();
    api.update.mockReturnValueOnce(first.promise).mockImplementationOnce(async (_companyId, _projectId, _recordId, patch) => record({ title: patch.title as string, description: patch.description as string, revision: 3 }));
    await render();
    await change({ title: "第一次" });
    await act(async () => { void observed.flush(); });
    expect(api.update).toHaveBeenCalledTimes(1);

    await change({ title: "第二次", description: "保存中继续编辑" });
    await act(async () => { first.resolve(record({ title: "第一次", description: "服务器补充", revision: 2 })); await Promise.resolve(); });
    expect(visibleDraft).toMatchObject({ title: "第二次", description: "保存中继续编辑" });
    expect(api.update).toHaveBeenCalledTimes(1);
    await advance(900);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1][3]).toMatchObject({ expectedRevision: 2, title: "第二次", description: "保存中继续编辑" });
  });

  it("stores edits locally while offline and retries on the online event", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await render();
    await change({ priority: "high" });
    await advance(0);
    expect(observed.status).toBe("offline_local");
    expect(api.update).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => window.dispatchEvent(new Event("online")));
    await advance(0);
    expect(api.update).toHaveBeenCalledTimes(1);
  });

  it("never reports offline_local when browser storage rejected the draft", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    await render();
    await change({ priority: "high" });
    await advance(0);
    expect(observed.status).toBe("failed");
    expect(observed.error?.message).toContain("local storage");
    expect(api.update).not.toHaveBeenCalled();
  });

  it("treats a status-0 network failure as local-only and retries online", async () => {
    api.update.mockRejectedValueOnce(new ApiError("offline", 0, null));
    await render();
    await change({ priority: "high" });
    await advance(0);
    expect(observed.status).toBe("offline_local");
    expect(localStorage.length).toBe(1);
    await act(async () => window.dispatchEvent(new Event("online")));
    await advance(0);
    expect(api.update).toHaveBeenCalledTimes(2);
  });

  it("automatically rebases a non-overlapping 409 and retries with the latest revision", async () => {
    api.update
      .mockRejectedValueOnce(new ApiError("conflict", 409, { details: { currentRevision: 2 } }))
      .mockResolvedValueOnce(record({ title: "我的标题", description: "服务器说明", revision: 3 }));
    api.list.mockResolvedValueOnce([record({ description: "服务器说明", revision: 2 })]);
    await render();
    await change({ title: "我的标题" });
    await act(async () => { await observed.flush(); });
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1][3]).toMatchObject({ expectedRevision: 2, title: "我的标题" });
    expect(visibleDraft).toMatchObject({ title: "我的标题", description: "服务器说明" });
    expect(observed.conflict).toBeNull();
  });

  it("does not retry a semantic 409 when the server revision did not advance", async () => {
    api.update.mockRejectedValueOnce(new ApiError("Dependencies cannot change while running", 409, { code: "work_record_dependency_running" }));
    api.list.mockResolvedValueOnce([record()]);
    await render();
    await change({ priority: "high" });
    await act(async () => { await observed.flush(); });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(observed.status).toBe("failed");
    expect(observed.error?.message).toContain("Dependencies cannot change");
  });

  it("holds overlapping 409 groups until an atomic local or remote choice is made", async () => {
    const parentA = "00000000-0000-4000-8000-000000000001";
    const parentB = "00000000-0000-4000-8000-000000000002";
    api.update.mockRejectedValueOnce(new ApiError("conflict", 409, {}));
    api.list.mockResolvedValueOnce([record({ parentRecordId: parentB, iterationAssignmentMode: "independent", revision: 2 })]);
    await render();
    await change({ parentRecordId: parentA, iterationAssignmentMode: "inherit_parent" });
    await act(async () => { await observed.flush(); });
    expect(observed.status).toBe("conflict");
    expect(observed.conflict?.conflictGroups[0]).toEqual(["parentRecordId", "iterationAssignmentMode", "iterationId"]);
    expect(api.update).toHaveBeenCalledTimes(1);

    await change({ title: "冲突期间继续编辑" });
    const persisted = JSON.parse(localStorage.getItem([...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))].find(Boolean)!)!) as { baseRevision: number };
    expect(persisted.baseRevision).toBe(1);

    await act(async () => observed.chooseConflictGroup(0, "local"));
    await advance(0);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1][3]).toMatchObject({ expectedRevision: 2, parentRecordId: parentA, iterationAssignmentMode: "inherit_parent", iterationId: null });
  });

  it("stops safely when the server record was deleted", async () => {
    api.update.mockRejectedValueOnce(new ApiError("conflict", 409, {}));
    api.list.mockResolvedValueOnce([]);
    await render();
    await change({ priority: "high" });
    await act(async () => { await observed.flush(); });
    expect(observed.status).toBe("failed");
    expect(observed.error?.message).toContain("deleted");
    expect(localStorage.length).toBe(1);
  });

  it("restores a scoped local draft and discards it back to the server value", async () => {
    const base = workRecordEditorDraftFromRecord(currentRecord!);
    const scope: WorkRecordDraftScope = { principalId: "user-1", companyId: "company-1", projectId: "project-1", kind: "plan", recordId: "record-1" };
    saveWorkRecordDraft(localStorage, workRecordDraftStorageKey(scope), createWorkRecordDraftEnvelope({ scope, baseRevision: 1, baseDependencySetRevision: 1, baseSnapshot: base, draft: { ...base, title: "本地草稿" } }));
    await render();
    expect(visibleDraft.title).toBe("本地草稿");
    expect(observed.isDirty).toBe(true);
    await act(async () => observed.discardLocal());
    expect(visibleDraft.title).toBe("任务");
    expect(localStorage.length).toBe(0);
  });

  it("discards to the last confirmed save even when the record prop is stale", async () => {
    api.update.mockResolvedValueOnce(record({ title: "已确认", revision: 2 }));
    await render();
    await change({ title: "已确认" });
    await act(async () => { await observed.flush(); });
    await change({ title: "尚未保存" });
    await act(async () => observed.discardLocal());
    expect(visibleDraft.title).toBe("已确认");
    expect(observed.status).toBe("clean");
  });

  it("does not autosave new records and clears pending timers on unmount", async () => {
    currentRecord = null;
    await render();
    await change({ title: "尚未创建" });
    await advance(2_000);
    expect(api.update).not.toHaveBeenCalled();
    expect(observed.status).toBe("clean");

    currentRecord = record();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await change({ title: "不应保存" });
    await act(async () => root.unmount());
    await advance(1_000);
    expect(api.update).not.toHaveBeenCalled();
  });

  it("ignores an in-flight response after the principal scope changes", async () => {
    const pending = deferred<WorkRecord>();
    api.update.mockReturnValueOnce(pending.promise);
    await render();
    await change({ priority: "high" });
    await advance(0);
    expect(api.update).toHaveBeenCalledTimes(1);

    principalId = "user-2";
    await render();
    await act(async () => { pending.resolve(record({ priority: "high", revision: 2 })); await Promise.resolve(); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(visibleDraft.priority).toBe("medium");
  });
});
