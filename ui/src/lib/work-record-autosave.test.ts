import { describe, expect, it, vi } from "vitest";
import {
  WORK_RECORD_DRAFT_MAX_BYTES,
  applyWorkRecordDraftFields,
  buildWorkRecordDraftPatch,
  changedWorkRecordDraftFields,
  createWorkRecordDraftEnvelope,
  loadWorkRecordDraft,
  mergeWorkRecordDraft,
  removeWorkRecordDraft,
  saveWorkRecordDraft,
  workRecordDraftStorageKey,
  type WorkRecordDraftScope,
  type WorkRecordDraftStorage,
  type WorkRecordEditorDraft,
} from "./work-record-autosave";

const scope: WorkRecordDraftScope = { principalId: "user:1", companyId: "company", projectId: "project", kind: "plan", recordId: "record" };

function draft(overrides: Partial<WorkRecordEditorDraft> = {}): WorkRecordEditorDraft {
  return {
    title: "任务", description: "说明", businessStatus: "todo", assigneeAgentId: "", qaAssigneeAgentId: "",
    userResponsibilities: [], parentRecordId: "", predecessorRecordIds: [], packageQaRole: "execution",
    qaRetestExemptionReason: "", iterationId: "", iterationAssignmentMode: "independent",
    plannedStartDate: "", plannedCompletionDate: "", priority: "medium", defectSeverity: "", foundInVersionId: "",
    ...overrides,
  };
}

function memoryStorage(): WorkRecordDraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("work-record autosave contract", () => {
  it("builds an encoded key across every principal and record scope dimension", () => {
    expect(workRecordDraftStorageKey(scope)).toBe("paperclip:work-record-draft:v1:user%3A1:company:project:plan:record");
    for (const [field, value] of [["principalId", "用户：二"], ["companyId", "other:company"], ["projectId", "other project"], ["kind", "defect"], ["recordId", "记录：二"]] as const) {
      expect(workRecordDraftStorageKey({ ...scope, [field]: value })).not.toBe(workRecordDraftStorageKey(scope));
    }
    expect(() => workRecordDraftStorageKey({ ...scope, principalId: "" })).toThrow();
  });

  it("persists, validates, and scope-checks a versioned draft envelope", () => {
    const storage = memoryStorage();
    const key = workRecordDraftStorageKey(scope);
    const base = draft();
    const envelope = createWorkRecordDraftEnvelope({ scope, baseRevision: 2, baseDependencySetRevision: 4, baseSnapshot: base, draft: draft({ title: "新标题" }), updatedAt: "2026-11-10T00:00:00.000Z" });
    expect(saveWorkRecordDraft(storage, key, envelope)).toBe(true);
    expect(saveWorkRecordDraft(storage, "wrong-key", envelope)).toBe(false);
    expect(loadWorkRecordDraft(storage, key, scope)).toEqual({ status: "ready", envelope });
    expect(loadWorkRecordDraft(storage, key, { ...scope, recordId: "other" })).toEqual({ status: "invalid", reason: "scope_mismatch" });
  });

  it("rejects malformed metadata instead of trusting changedFields", () => {
    const storage = memoryStorage();
    const base = draft();
    const envelope = createWorkRecordDraftEnvelope({ scope, baseRevision: 1, baseDependencySetRevision: 1, baseSnapshot: base, draft: draft({ title: "本地" }) });
    storage.values.set("missing", JSON.stringify({ ...envelope, changedFields: [] }));
    storage.values.set("duplicate", JSON.stringify({ ...envelope, changedFields: ["title", "title"] }));
    storage.values.set("time", JSON.stringify({ ...envelope, updatedAt: "tomorrow" }));
    storage.values.set("future", JSON.stringify({ version: 2 }));
    for (const name of ["missing", "duplicate", "time", "future"]) {
      const caseScope = { ...scope, recordId: name };
      const raw = JSON.parse(storage.values.get(name)!) as Record<string, unknown>;
      storage.values.set(workRecordDraftStorageKey(caseScope), JSON.stringify({ ...raw, scope: caseScope }));
    }
    expect(loadWorkRecordDraft(storage, workRecordDraftStorageKey({ ...scope, recordId: "missing" }), { ...scope, recordId: "missing" })).toEqual({ status: "invalid", reason: "malformed" });
    expect(loadWorkRecordDraft(storage, workRecordDraftStorageKey({ ...scope, recordId: "duplicate" }), { ...scope, recordId: "duplicate" })).toEqual({ status: "invalid", reason: "malformed" });
    expect(loadWorkRecordDraft(storage, workRecordDraftStorageKey({ ...scope, recordId: "time" }), { ...scope, recordId: "time" })).toEqual({ status: "invalid", reason: "malformed" });
    expect(loadWorkRecordDraft(storage, workRecordDraftStorageKey({ ...scope, recordId: "future" }), { ...scope, recordId: "future" })).toEqual({ status: "invalid", reason: "unsupported" });
  });

  it("does not throw or claim persistence/removal when storage rejects writes", () => {
    const storage = memoryStorage();
    storage.setItem = vi.fn(() => { throw new DOMException("quota", "QuotaExceededError"); });
    storage.removeItem = vi.fn(() => { throw new DOMException("denied", "SecurityError"); });
    const base = draft();
    const envelope = createWorkRecordDraftEnvelope({ scope, baseRevision: 1, baseDependencySetRevision: 1, baseSnapshot: base, draft: draft({ title: "本地" }) });
    expect(saveWorkRecordDraft(storage, workRecordDraftStorageKey(scope), envelope)).toBe(false);
    expect(removeWorkRecordDraft(storage, "key")).toBe(false);
  });

  it("stores the maximum legal multilingual description with its base snapshot", () => {
    const storage = memoryStorage();
    const base = draft({ description: "中".repeat(100_000) });
    const envelope = createWorkRecordDraftEnvelope({ scope, baseRevision: 1, baseDependencySetRevision: 1, baseSnapshot: base, draft: { ...base, title: "新标题" } });
    expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThan(WORK_RECORD_DRAFT_MAX_BYTES);
    const key = workRecordDraftStorageKey(scope);
    expect(saveWorkRecordDraft(storage, key, envelope)).toBe(true);
    expect(loadWorkRecordDraft(storage, key, scope).status).toBe("ready");
  });

  it("rejects drafts that exceed server relation, strict-object, GUID, or calendar constraints", () => {
    const storage = memoryStorage();
    const base = draft();
    const envelope = createWorkRecordDraftEnvelope({ scope, baseRevision: 1, baseDependencySetRevision: 1, baseSnapshot: base, draft: { ...base, title: "本地" } });
    const cases = [
      { ...envelope, draft: { ...envelope.draft, predecessorRecordIds: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) } },
      { ...envelope, draft: { ...envelope.draft, userResponsibilities: Array.from({ length: 31 }, (_, index) => ({ userId: `u${index}`, role: "qa" })) } },
      { ...envelope, draft: { ...envelope.draft, plannedCompletionDate: "2026-99-99" } },
      { ...envelope, draft: { ...envelope.draft, parentRecordId: "not-a-guid" } },
      { ...envelope, draft: { ...envelope.draft, userResponsibilities: [{ userId: "u1", role: "qa", extra: true }] } },
    ];
    cases.forEach((candidate, index) => {
      const caseScope = { ...scope, recordId: `case-${index}` };
      const key = workRecordDraftStorageKey(caseScope);
      storage.values.set(key, JSON.stringify({ ...candidate, scope: caseScope }));
      expect(loadWorkRecordDraft(storage, key, caseScope)).toEqual({ status: "invalid", reason: "malformed" });
    });
  });

  it("treats dependencies and responsibilities as unordered unique sets", () => {
    const base = draft({ predecessorRecordIds: ["a", "b"], userResponsibilities: [{ userId: "u1", role: "qa" }, { userId: "u2", role: "po" }] });
    const reordered = draft({ predecessorRecordIds: ["b", "a"], userResponsibilities: [{ userId: "u2", role: "po" }, { userId: "u1", role: "qa" }] });
    expect(changedWorkRecordDraftFields(base, reordered)).toEqual([]);
    expect(mergeWorkRecordDraft({ base, local: reordered, remote: base }).conflicts).toEqual([]);
  });

  it("creates a true differential patch and preserves description formatting", () => {
    const base = draft();
    const next = draft({ description: "    code\n", predecessorRecordIds: ["b", "a"] });
    expect(buildWorkRecordDraftPatch({ kind: "plan", base, draft: next, expectedRevision: 3, dependencySetRevision: 7 })).toEqual({
      expectedRevision: 3,
      description: "    code\n",
      predecessorRecordIds: ["a", "b"],
      dependencySetRevision: 7,
    });
  });

  it("submits parent/iteration and dates as invariant-preserving groups", () => {
    const base = draft({ iterationId: "i1", plannedStartDate: "2026-11-01", plannedCompletionDate: "2026-11-02" });
    const next = draft({ parentRecordId: "p1", iterationAssignmentMode: "inherit_parent", iterationId: "i1", plannedStartDate: "2026-11-03", plannedCompletionDate: "2026-11-04" });
    expect(buildWorkRecordDraftPatch({ kind: "plan", base, draft: next, expectedRevision: 2, dependencySetRevision: 1 })).toMatchObject({
      parentRecordId: "p1", iterationAssignmentMode: "inherit_parent", iterationId: null,
      plannedStartDate: "2026-11-03", plannedCompletionDate: "2026-11-04",
    });
  });

  it("clears the QA exemption reason when switching to a QA task", () => {
    const base = draft({ packageQaRole: "execution", qaRetestExemptionReason: "无需复测" });
    const next = draft({ packageQaRole: "qa", qaRetestExemptionReason: "无需复测" });
    expect(buildWorkRecordDraftPatch({ kind: "plan", base, draft: next, expectedRevision: 2, dependencySetRevision: 1 })).toMatchObject({ packageQaRole: "qa", qaRetestExemptionReason: null });
  });

  it("returns null when only fields irrelevant to the current record kind changed", () => {
    expect(buildWorkRecordDraftPatch({ kind: "plan", base: draft(), draft: draft({ defectSeverity: "high" }), expectedRevision: 2, dependencySetRevision: 1 })).toBeNull();
    expect(buildWorkRecordDraftPatch({ kind: "defect", base: draft(), draft: draft({ packageQaRole: "qa" }), expectedRevision: 2, dependencySetRevision: 1 })).toBeNull();
  });

  it("auto-merges non-overlapping independent fields and flags overlapping fields", () => {
    const base = draft();
    const nonOverlapping = mergeWorkRecordDraft({ base, local: draft({ title: "我的标题" }), remote: draft({ description: "服务器说明" }) });
    expect(nonOverlapping.conflicts).toEqual([]);
    expect(nonOverlapping.merged).toMatchObject({ title: "我的标题", description: "服务器说明" });
    const overlapping = mergeWorkRecordDraft({ base, local: draft({ title: "我的标题" }), remote: draft({ title: "服务器标题" }) });
    expect(overlapping.conflicts).toEqual(["title"]);
    expect(overlapping.conflictGroups).toEqual([["title"]]);
  });

  it.each([
    ["parent/iteration", { parentRecordId: "p1", iterationAssignmentMode: "inherit_parent" }, { iterationId: "i2" }, ["parentRecordId", "iterationAssignmentMode", "iterationId"]],
    ["QA role/reason", { packageQaRole: "qa" }, { qaRetestExemptionReason: "远端原因" }, ["packageQaRole", "qaRetestExemptionReason"]],
    ["start/completion", { plannedStartDate: "2026-11-03" }, { plannedCompletionDate: "2026-11-04" }, ["plannedStartDate", "plannedCompletionDate"]],
  ] as const)("does not silently mix concurrent %s edits", (_label, localChanges, remoteChanges, expectedGroup) => {
    const merged = mergeWorkRecordDraft({ base: draft(), local: draft(localChanges), remote: draft(remoteChanges) });
    expect(merged.conflictGroups).toContainEqual(expectedGroup);
    expect(merged.merged).toMatchObject(remoteChanges);
  });

  it("rebases edits made during an in-flight save onto the saved server result", () => {
    const captured = draft({ title: "第一次" });
    const saved = draft({ title: "第一次", description: "服务器补充" });
    const latest = draft({ title: "第二次" });
    const rebased = applyWorkRecordDraftFields(saved, latest, changedWorkRecordDraftFields(captured, latest));
    expect(rebased).toMatchObject({ title: "第二次", description: "服务器补充" });
  });
});
