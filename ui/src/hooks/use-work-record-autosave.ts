import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorkRecord, WorkRecordKind } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { workRecordsApi } from "@/api/work-records";
import {
  applyWorkRecordDraftFields,
  buildWorkRecordDraftPatch,
  changedWorkRecordDraftFields,
  createWorkRecordDraftEnvelope,
  loadWorkRecordDraft,
  mergeWorkRecordDraft,
  removeWorkRecordDraft,
  saveWorkRecordDraft,
  workRecordDraftStorageKey,
  workRecordEditorDraftFromRecord,
  type WorkRecordDraftField,
  type WorkRecordDraftScope,
  type WorkRecordEditorDraft,
} from "@/lib/work-record-autosave";

export type WorkRecordAutosaveStatus = "clean" | "dirty" | "queued" | "saving" | "saved" | "offline_local" | "conflict" | "failed";
export type WorkRecordConflictChoice = "local" | "remote";

export interface WorkRecordAutosaveConflict {
  base: WorkRecordEditorDraft;
  local: WorkRecordEditorDraft;
  remote: WorkRecordEditorDraft;
  merged: WorkRecordEditorDraft;
  conflictGroups: WorkRecordDraftField[][];
  choices: Array<WorkRecordConflictChoice | null>;
}

interface InternalConflict extends WorkRecordAutosaveConflict {
  remoteRecord: WorkRecord;
  baseRevision: number;
  baseDependencySetRevision: number;
}

interface Baseline {
  snapshot: WorkRecordEditorDraft;
  revision: number;
  dependencySetRevision: number;
}

interface AutosaveConfig {
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  principalId: string | null;
  record: WorkRecord | null;
  enabled: boolean;
  onSaved?: (record: WorkRecord) => void;
}

const TEXT_FIELDS = new Set<WorkRecordDraftField>(["title", "description", "qaRetestExemptionReason"]);
const TEXT_DEBOUNCE_MS = 900;

function draftsEqual(left: WorkRecordEditorDraft, right: WorkRecordEditorDraft) {
  return changedWorkRecordDraftFields(left, right).length === 0;
}

function deletedRecordError() {
  return new Error("The work record was deleted on the server. The local draft was kept.");
}

function localStorageError() {
  return new Error("The work record draft could not be saved in local storage.");
}

function isOfflineError(error: unknown) {
  return error instanceof ApiError && error.status === 0;
}

function isConflictError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function isDeletedError(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

function browserIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine;
}

function scopeFor(config: AutosaveConfig, record: WorkRecord): WorkRecordDraftScope {
  if (!config.principalId) throw new Error("The signed-in account identity is unavailable");
  return {
    principalId: config.principalId,
    companyId: config.companyId,
    projectId: config.projectId,
    kind: config.kind,
    recordId: record.id,
  };
}

function sameRecordScope(config: AutosaveConfig, identity: string) {
  return Boolean(config.record) && `${config.principalId}:${config.companyId}:${config.projectId}:${config.kind}:${config.record!.id}` === identity;
}

export function useWorkRecordAutosave({
  companyId,
  projectId,
  kind,
  principalId,
  record,
  draft,
  setDraft,
  enabled,
  onSaved,
}: {
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  principalId: string | null;
  record: WorkRecord | null;
  draft: WorkRecordEditorDraft;
  setDraft: Dispatch<SetStateAction<WorkRecordEditorDraft>>;
  enabled: boolean;
  onSaved?: (record: WorkRecord) => void;
}) {
  const [status, setStatus] = useState<WorkRecordAutosaveStatus>("clean");
  const [error, setError] = useState<Error | null>(null);
  const [conflict, setConflict] = useState<WorkRecordAutosaveConflict | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const configRef = useRef<AutosaveConfig>({ companyId, projectId, kind, principalId, record, enabled, onSaved });
  configRef.current = { companyId, projectId, kind, principalId, record, enabled, onSaved };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef<Baseline | null>(null);
  const priorObservedDraftRef = useRef(draft);
  const internalDraftRef = useRef<WorkRecordEditorDraft | null>(null);
  const suppressDraftEffectRef = useRef(false);
  const identityRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRef = useRef(false);
  const drainPromiseRef = useRef<Promise<void> | null>(null);
  const conflictRef = useRef<InternalConflict | null>(null);
  const localDraftStoredRef = useRef(false);
  const aliveRef = useRef(true);
  const drainRef = useRef<() => Promise<void>>(async () => undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const applyDraft = useCallback((next: WorkRecordEditorDraft) => {
    draftRef.current = next;
    priorObservedDraftRef.current = next;
    internalDraftRef.current = next;
    setDraft(next);
  }, [setDraft]);

  const setConflictState = useCallback((next: InternalConflict | null) => {
    conflictRef.current = next;
    setConflict(next ? {
      base: next.base,
      local: next.local,
      remote: next.remote,
      merged: next.merged,
      conflictGroups: next.conflictGroups,
      choices: next.choices,
    } : null);
  }, []);

  const removeCurrentLocalDraft = useCallback(() => {
    const config = configRef.current;
    if (!config.record || !config.principalId) return true;
    try {
      const removed = removeWorkRecordDraft(window.localStorage, workRecordDraftStorageKey(scopeFor(config, config.record)));
      if (removed) localDraftStoredRef.current = false;
      return removed;
    } catch {
      // A missing browser storage implementation must not break remote saves.
      return false;
    }
  }, []);

  const persistCurrentDraft = useCallback((baseline: Baseline, nextDraft: WorkRecordEditorDraft, overrideRecord?: WorkRecord) => {
    const config = configRef.current;
    const activeRecord = overrideRecord ?? config.record;
    if (!activeRecord || !config.principalId) return false;
    try {
      const scope = scopeFor(config, activeRecord);
      const envelope = createWorkRecordDraftEnvelope({
        scope,
        baseRevision: baseline.revision,
        baseDependencySetRevision: baseline.dependencySetRevision,
        baseSnapshot: baseline.snapshot,
        draft: nextDraft,
      });
      const stored = saveWorkRecordDraft(window.localStorage, workRecordDraftStorageKey(scope), envelope);
      localDraftStoredRef.current = stored;
      return stored;
    } catch {
      localDraftStoredRef.current = false;
      return false;
    }
  }, []);

  const markLocalDraft = useCallback((baseline: Baseline, nextDraft: WorkRecordEditorDraft) => {
    const dirty = !draftsEqual(baseline.snapshot, nextDraft);
    setIsDirty(dirty);
    if (!dirty) {
      const removed = removeCurrentLocalDraft();
      if (!removed) {
        setError(localStorageError());
        setStatus("failed");
      }
      return removed;
    }
    if (!configRef.current.principalId) return true;
    const stored = persistCurrentDraft(baseline, nextDraft);
    if (!stored) {
      setError(localStorageError());
      setStatus("failed");
    }
    return stored;
  }, [persistCurrentDraft, removeCurrentLocalDraft]);

  const queueSave = useCallback((delay: number) => {
    clearTimer();
    const config = configRef.current;
    if (!config.enabled || !config.record || conflictRef.current) return;
    if (!browserIsOnline()) {
      if (!config.principalId) setError(new Error("The signed-in account identity is unavailable, so this draft cannot be preserved offline."));
      setStatus(localDraftStoredRef.current ? "offline_local" : "failed");
      return;
    }
    if (delay > 0) setStatus("dirty");
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!aliveRef.current || conflictRef.current) return;
      queuedRef.current = true;
      setStatus("queued");
      void drainRef.current();
    }, delay);
  }, [clearTimer]);

  const enterConflict = useCallback((input: {
    baseline: Baseline;
    local: WorkRecordEditorDraft;
    remoteRecord: WorkRecord;
  }) => {
    const remote = workRecordEditorDraftFromRecord(input.remoteRecord);
    const result = mergeWorkRecordDraft({ base: input.baseline.snapshot, local: input.local, remote });
    if (result.conflictGroups.length === 0) {
      const baseline: Baseline = {
        snapshot: remote,
        revision: input.remoteRecord.revision,
        dependencySetRevision: input.remoteRecord.dependencySetRevision,
      };
      baseRef.current = baseline;
      setConflictState(null);
      applyDraft(result.merged);
      markLocalDraft(baseline, result.merged);
      queuedRef.current = !draftsEqual(remote, result.merged);
      setStatus(queuedRef.current ? "queued" : "clean");
      return false;
    }
    const next: InternalConflict = {
      base: structuredClone(input.baseline.snapshot),
      local: structuredClone(input.local),
      remote,
      merged: result.merged,
      conflictGroups: result.conflictGroups,
      choices: result.conflictGroups.map(() => null),
      remoteRecord: input.remoteRecord,
      baseRevision: input.baseline.revision,
      baseDependencySetRevision: input.baseline.dependencySetRevision,
    };
    setConflictState(next);
    setStatus("conflict");
    setIsDirty(true);
    return true;
  }, [applyDraft, markLocalDraft, setConflictState]);

  const executeAttempt = useCallback(async () => {
    const config = configRef.current;
    const baseline = baseRef.current;
    const activeRecord = config.record;
    if (!config.enabled || !activeRecord || !baseline || conflictRef.current) return "stop" as const;
    const identity = `${config.principalId}:${config.companyId}:${config.projectId}:${config.kind}:${activeRecord.id}`;
    const captured = structuredClone(draftRef.current);
    const patch = buildWorkRecordDraftPatch({
      kind: config.kind,
      base: baseline.snapshot,
      draft: captured,
      expectedRevision: baseline.revision,
      dependencySetRevision: baseline.dependencySetRevision,
    });
    if (!patch) {
      setIsDirty(false);
      if (removeCurrentLocalDraft()) setStatus("clean");
      else { setError(localStorageError()); setStatus("failed"); }
      return "stop" as const;
    }
    if (!browserIsOnline()) {
      const stored = persistCurrentDraft(baseline, captured, activeRecord);
      if (!stored) setError(config.principalId ? localStorageError() : new Error("The signed-in account identity is unavailable, so this draft cannot be preserved offline."));
      setStatus(stored ? "offline_local" : "failed");
      return "stop" as const;
    }
    setError(null);
    setStatus("saving");
    try {
      const saved = await workRecordsApi.update(config.companyId, config.projectId, activeRecord.id, patch);
      if (!aliveRef.current || !sameRecordScope(configRef.current, identity)) return "stop" as const;
      try { config.onSaved?.(saved); } catch { /* Cache notification must not turn a confirmed save into failure. */ }
      const savedDraft = workRecordEditorDraftFromRecord(saved);
      const latest = draftRef.current;
      const editedDuringSave = changedWorkRecordDraftFields(captured, latest);
      const rebased = applyWorkRecordDraftFields(savedDraft, latest, editedDuringSave);
      const nextBaseline: Baseline = {
        snapshot: savedDraft,
        revision: saved.revision,
        dependencySetRevision: saved.dependencySetRevision,
      };
      baseRef.current = nextBaseline;
      applyDraft(rebased);
      const dirty = !draftsEqual(savedDraft, rebased);
      setIsDirty(dirty);
      if (!dirty) {
        if (removeCurrentLocalDraft()) setStatus("saved");
        else { setError(localStorageError()); setStatus("failed"); }
      } else {
        persistCurrentDraft(nextBaseline, rebased, saved);
        setStatus(queuedRef.current ? "queued" : "dirty");
      }
      return "continue" as const;
    } catch (caught) {
      if (!aliveRef.current || !sameRecordScope(configRef.current, identity)) return "stop" as const;
      if (isOfflineError(caught)) {
        const stored = persistCurrentDraft(baseline, draftRef.current, activeRecord);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setStatus(stored ? "offline_local" : "failed");
        return "stop" as const;
      }
      if (isDeletedError(caught)) {
        setError(deletedRecordError());
        setStatus("failed");
        return "stop" as const;
      }
      if (isConflictError(caught)) {
        try {
          const latestRecords = await workRecordsApi.list(config.companyId, config.projectId);
          if (!aliveRef.current || !sameRecordScope(configRef.current, identity)) return "stop" as const;
          const remoteRecord = latestRecords.find((candidate) => candidate.id === activeRecord.id);
          if (!remoteRecord) {
            setError(deletedRecordError());
            setStatus("failed");
            return "stop" as const;
          }
          if (remoteRecord.revision <= baseline.revision && remoteRecord.dependencySetRevision <= baseline.dependencySetRevision) {
            setError(caught instanceof Error ? caught : new Error(String(caught)));
            setStatus("failed");
            return "stop" as const;
          }
          const hasConflict = enterConflict({ baseline, local: draftRef.current, remoteRecord });
          return hasConflict ? "stop" as const : "continue" as const;
        } catch (refreshError) {
          if (isOfflineError(refreshError)) {
            const stored = persistCurrentDraft(baseline, draftRef.current, activeRecord);
            setError(refreshError instanceof Error ? refreshError : new Error(String(refreshError)));
            setStatus(stored ? "offline_local" : "failed");
          } else {
            setError(refreshError instanceof Error ? refreshError : new Error(String(refreshError)));
            setStatus("failed");
          }
          return "stop" as const;
        }
      }
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setStatus("failed");
      return "stop" as const;
    }
  }, [applyDraft, enterConflict, persistCurrentDraft, removeCurrentLocalDraft]);

  drainRef.current = async () => {
    if (drainPromiseRef.current) return drainPromiseRef.current;
    const pending = (async () => {
      while (queuedRef.current && aliveRef.current) {
        queuedRef.current = false;
        const outcome = await executeAttempt();
        if (outcome === "stop") break;
      }
    })();
    drainPromiseRef.current = pending;
    try {
      await pending;
    } finally {
      if (drainPromiseRef.current === pending) drainPromiseRef.current = null;
      if (queuedRef.current && aliveRef.current && !conflictRef.current && browserIsOnline()) void drainRef.current();
    }
  };

  const flush = useCallback(async () => {
    clearTimer();
    const config = configRef.current;
    if (!config.enabled || !config.record || !baseRef.current || conflictRef.current) return false;
    const stored = markLocalDraft(baseRef.current, draftRef.current);
    if (!browserIsOnline()) {
      if (!config.principalId) setError(new Error("The signed-in account identity is unavailable, so this draft cannot be preserved offline."));
      setStatus(stored ? "offline_local" : "failed");
      return false;
    }
    queuedRef.current = true;
    setStatus("queued");
    await drainRef.current();
    return Boolean(baseRef.current && !conflictRef.current && draftsEqual(baseRef.current.snapshot, draftRef.current));
  }, [clearTimer, markLocalDraft]);

  const chooseConflictGroup = useCallback((groupIndex: number, choice: WorkRecordConflictChoice) => {
    const current = conflictRef.current;
    if (!current || groupIndex < 0 || groupIndex >= current.conflictGroups.length) return;
    const choices = [...current.choices];
    choices[groupIndex] = choice;
    let merged = current.merged;
    merged = applyWorkRecordDraftFields(merged, choice === "local" ? current.local : current.remote, current.conflictGroups[groupIndex]);
    const next = { ...current, choices, merged };
    if (choices.some((value) => value === null)) {
      setConflictState(next);
      return;
    }
    const baseline: Baseline = {
      snapshot: current.remote,
      revision: current.remoteRecord.revision,
      dependencySetRevision: current.remoteRecord.dependencySetRevision,
    };
    baseRef.current = baseline;
    setConflictState(null);
    applyDraft(merged);
    const dirty = !draftsEqual(current.remote, merged);
    setIsDirty(dirty);
    if (!dirty) {
      const removed = removeCurrentLocalDraft();
      setError(null);
      if (removed) setStatus("clean");
      else { setError(localStorageError()); setStatus("failed"); }
      return;
    }
    persistCurrentDraft(baseline, merged, current.remoteRecord);
    queuedRef.current = true;
    setError(null);
    setStatus("queued");
    void drainRef.current();
  }, [applyDraft, persistCurrentDraft, removeCurrentLocalDraft, setConflictState]);

  const discardLocal = useCallback(() => {
    clearTimer();
    queuedRef.current = false;
    const currentConflict = conflictRef.current;
    const config = configRef.current;
    const remoteRecord = currentConflict?.remoteRecord ?? config.record;
    const baseline = currentConflict && remoteRecord
      ? { snapshot: currentConflict.remote, revision: remoteRecord.revision, dependencySetRevision: remoteRecord.dependencySetRevision }
      : baseRef.current;
    if (!baseline) return;
    const remote = baseline.snapshot;
    baseRef.current = baseline;
    setConflictState(null);
    applyDraft(remote);
    const removed = removeCurrentLocalDraft();
    setIsDirty(false);
    setError(null);
    if (removed) setStatus("clean");
    else { setError(localStorageError()); setStatus("failed"); }
  }, [applyDraft, clearTimer, removeCurrentLocalDraft, setConflictState]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimer();
      queuedRef.current = false;
    };
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    queuedRef.current = false;
    setConflictState(null);
    setError(null);
    const config = configRef.current;
    if (!config.enabled || !config.record) {
      identityRef.current = "";
      baseRef.current = null;
      setIsDirty(false);
      setStatus("clean");
      return;
    }
    const identity = `${config.principalId}:${config.companyId}:${config.projectId}:${config.kind}:${config.record.id}`;
    identityRef.current = identity;
    localDraftStoredRef.current = false;
    const remote = workRecordEditorDraftFromRecord(config.record);
    const remoteBaseline: Baseline = { snapshot: remote, revision: config.record.revision, dependencySetRevision: config.record.dependencySetRevision };
    baseRef.current = remoteBaseline;
    suppressDraftEffectRef.current = true;
    priorObservedDraftRef.current = remote;
    let restored = false;
    let initializationFailed = false;
    try {
      if (!config.principalId) {
        applyDraft(remote);
        setIsDirty(false);
        setStatus("clean");
        return;
      }
      const scope = scopeFor(config, config.record);
      const key = workRecordDraftStorageKey(scope);
      const loaded = loadWorkRecordDraft(window.localStorage, key, scope);
      if (loaded.status === "ready") {
        restored = true;
        localDraftStoredRef.current = true;
        const envelope = loaded.envelope;
        if (envelope.baseRevision === config.record.revision && envelope.baseDependencySetRevision === config.record.dependencySetRevision) {
          const baseline = { snapshot: envelope.baseSnapshot, revision: envelope.baseRevision, dependencySetRevision: envelope.baseDependencySetRevision };
          baseRef.current = baseline;
          applyDraft(envelope.draft);
          const dirty = !draftsEqual(baseline.snapshot, envelope.draft);
          setIsDirty(dirty);
          if (dirty) queueSave(browserIsOnline() ? 0 : TEXT_DEBOUNCE_MS);
          else setStatus("clean");
        } else {
          const hasConflict = enterConflict({
            baseline: { snapshot: envelope.baseSnapshot, revision: envelope.baseRevision, dependencySetRevision: envelope.baseDependencySetRevision },
            local: envelope.draft,
            remoteRecord: config.record,
          });
          if (!hasConflict && queuedRef.current) void drainRef.current();
        }
      } else if (loaded.status === "invalid") {
        initializationFailed = true;
        setError(new Error(`The saved work record draft is invalid: ${loaded.reason}`));
        setStatus("failed");
      }
    } catch (caught) {
      initializationFailed = true;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      setStatus("failed");
    }
    if (!restored) {
      applyDraft(remote);
      setIsDirty(false);
      if (!initializationFailed) setStatus("clean");
    }
  // Record revision changes are reconciled by successful saves and the dedicated effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, projectId, kind, principalId, record?.id, enabled]);

  useEffect(() => {
    if (suppressDraftEffectRef.current) {
      suppressDraftEffectRef.current = false;
      priorObservedDraftRef.current = draft;
      return;
    }
    if (internalDraftRef.current && draftsEqual(internalDraftRef.current, draft)) {
      internalDraftRef.current = null;
      priorObservedDraftRef.current = draft;
      return;
    }
    const config = configRef.current;
    const baseline = baseRef.current;
    const previous = priorObservedDraftRef.current;
    priorObservedDraftRef.current = draft;
    draftRef.current = draft;
    if (!config.enabled || !config.record || !baseline) return;
    if (conflictRef.current) {
      const priorConflict = conflictRef.current;
      persistCurrentDraft({ snapshot: priorConflict.base, revision: priorConflict.baseRevision, dependencySetRevision: priorConflict.baseDependencySetRevision }, draft);
      enterConflict({
        baseline: { snapshot: priorConflict.base, revision: priorConflict.baseRevision, dependencySetRevision: priorConflict.baseDependencySetRevision },
        local: draft,
        remoteRecord: priorConflict.remoteRecord,
      });
      return;
    }
    const changed = changedWorkRecordDraftFields(previous, draft);
    const dirty = !draftsEqual(baseline.snapshot, draft);
    setIsDirty(dirty);
    if (!dirty) {
      clearTimer();
      if (removeCurrentLocalDraft()) setStatus("clean");
      else { setError(localStorageError()); setStatus("failed"); }
      return;
    }
    markLocalDraft(baseline, draft);
    const textOnly = changed.length > 0 && changed.every((field) => TEXT_FIELDS.has(field));
    queueSave(textOnly ? TEXT_DEBOUNCE_MS : 0);
  }, [draft, clearTimer, enterConflict, markLocalDraft, persistCurrentDraft, queueSave, removeCurrentLocalDraft]);

  useEffect(() => {
    const config = configRef.current;
    const baseline = baseRef.current;
    if (!config.enabled || !record || !baseline || record.id !== config.record?.id || record.revision <= baseline.revision) return;
    const local = draftRef.current;
    const hasConflict = enterConflict({ baseline, local, remoteRecord: record });
    if (!hasConflict && queuedRef.current) void drainRef.current();
  }, [record?.revision, record, enabled, enterConflict]);

  useEffect(() => {
    const retry = () => {
      if (!aliveRef.current || status !== "offline_local" || conflictRef.current || !baseRef.current || !configRef.current.record) return;
      queuedRef.current = true;
      setStatus("queued");
      void drainRef.current();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [status]);

  return { status, error, conflict, flush, chooseConflictGroup, discardLocal, isDirty };
}
