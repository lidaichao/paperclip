import type {
  IssuePriority,
  UpdateWorkRecord,
  WorkRecord,
  WorkRecordBusinessStatus,
  WorkRecordDefectSeverity,
  WorkRecordIterationAssignmentMode,
  WorkRecordKind,
  WorkRecordUserResponsibility,
} from "@paperclipai/shared";

export interface WorkRecordEditorDraft {
  title: string;
  description: string;
  businessStatus: WorkRecordBusinessStatus;
  assigneeAgentId: string;
  qaAssigneeAgentId: string;
  userResponsibilities: WorkRecordUserResponsibility[];
  parentRecordId: string;
  predecessorRecordIds: string[];
  packageQaRole: "execution" | "qa";
  qaRetestExemptionReason: string;
  iterationId: string;
  iterationAssignmentMode: WorkRecordIterationAssignmentMode;
  plannedStartDate: string;
  plannedCompletionDate: string;
  priority: IssuePriority;
  defectSeverity: WorkRecordDefectSeverity | "";
  foundInVersionId: string;
}

export type WorkRecordDraftField = keyof WorkRecordEditorDraft;

export interface WorkRecordDraftScope {
  principalId: string;
  companyId: string;
  projectId: string;
  kind: WorkRecordKind;
  recordId: string;
}

export interface WorkRecordDraftEnvelope {
  version: 1;
  scope: WorkRecordDraftScope;
  baseRevision: number;
  baseDependencySetRevision: number;
  baseSnapshot: WorkRecordEditorDraft;
  draft: WorkRecordEditorDraft;
  changedFields: WorkRecordDraftField[];
  updatedAt: string;
}

export interface WorkRecordDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type WorkRecordDraftLoadResult =
  | { status: "empty" }
  | { status: "ready"; envelope: WorkRecordDraftEnvelope }
  | { status: "invalid"; reason: "too_large" | "malformed" | "unsupported" | "scope_mismatch" };

export const WORK_RECORD_DRAFT_MAX_BYTES = 1_500_000;
const MAX_PREDECESSORS = 100;
const MAX_RESPONSIBILITIES = 30;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSINESS_STATUSES = new Set<WorkRecordBusinessStatus>(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);
const PRIORITIES = new Set<IssuePriority>(["critical", "high", "medium", "low"]);
const SEVERITIES = new Set<WorkRecordDefectSeverity>(["critical", "high", "medium", "low"]);
const ITERATION_MODES = new Set<WorkRecordIterationAssignmentMode>(["independent", "inherit_parent"]);

const DRAFT_FIELDS: WorkRecordDraftField[] = [
  "title", "description", "businessStatus", "assigneeAgentId", "qaAssigneeAgentId", "userResponsibilities",
  "parentRecordId", "predecessorRecordIds", "packageQaRole", "qaRetestExemptionReason", "iterationId",
  "iterationAssignmentMode", "plannedStartDate", "plannedCompletionDate", "priority", "defectSeverity", "foundInVersionId",
];

const LOGICAL_GROUPS: WorkRecordDraftField[][] = [
  ["parentRecordId", "iterationAssignmentMode", "iterationId"],
  ["packageQaRole", "qaRetestExemptionReason"],
  ["plannedStartDate", "plannedCompletionDate"],
];
const GROUPED_FIELDS = new Set(LOGICAL_GROUPS.flat());
const MERGE_GROUPS = [
  ...LOGICAL_GROUPS,
  ...DRAFT_FIELDS.filter((field) => !GROUPED_FIELDS.has(field)).map((field) => [field]),
];

function normalizeStringSet(value: string[]) {
  return [...new Set(value)].sort();
}

function normalizeResponsibilities(value: WorkRecordUserResponsibility[]) {
  const unique = new Map<string, WorkRecordUserResponsibility>();
  for (const item of value) unique.set(`${item.userId}\u0000${item.role}`, { userId: item.userId, role: item.role });
  return [...unique.values()].sort((left, right) => `${left.userId}\u0000${left.role}`.localeCompare(`${right.userId}\u0000${right.role}`));
}

function comparableFieldValue(field: WorkRecordDraftField, value: WorkRecordEditorDraft[WorkRecordDraftField]) {
  if (field === "predecessorRecordIds") return normalizeStringSet(value as string[]);
  if (field === "userResponsibilities") return normalizeResponsibilities(value as WorkRecordUserResponsibility[]);
  return value;
}

function sameFieldValue(field: WorkRecordDraftField, left: WorkRecordEditorDraft, right: WorkRecordEditorDraft) {
  return JSON.stringify(comparableFieldValue(field, left[field])) === JSON.stringify(comparableFieldValue(field, right[field]));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_PREDECESSORS
    && value.every((item) => typeof item === "string" && GUID_PATTERN.test(item))
    && new Set(value).size === value.length;
}

function isResponsibilities(value: unknown): value is WorkRecordUserResponsibility[] {
  if (!Array.isArray(value) || value.length > MAX_RESPONSIBILITIES) return false;
  const keys = new Set<string>();
  for (const item of value) {
    const itemKeys = typeof item === "object" && item !== null ? Object.keys(item).sort() : [];
    if (
      typeof item !== "object" || item === null
      || typeof (item as WorkRecordUserResponsibility).userId !== "string"
      || !(item as WorkRecordUserResponsibility).userId.trim()
      || (item as WorkRecordUserResponsibility).userId.length > 255
      || (item as WorkRecordUserResponsibility).userId.trim() !== (item as WorkRecordUserResponsibility).userId
      || !["execution", "qa", "po"].includes((item as WorkRecordUserResponsibility).role)
      || JSON.stringify(itemKeys) !== JSON.stringify(["role", "userId"])
    ) return false;
    const key = `${(item as WorkRecordUserResponsibility).userId}\u0000${(item as WorkRecordUserResponsibility).role}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isDateOrEmpty(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isGuidOrEmpty(value: unknown): value is string {
  return typeof value === "string" && (value === "" || GUID_PATTERN.test(value));
}

function isDraft(value: unknown): value is WorkRecordEditorDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Partial<WorkRecordEditorDraft>;
  return typeof draft.title === "string" && draft.title.length <= 500
    && typeof draft.description === "string" && draft.description.length <= 100_000
    && BUSINESS_STATUSES.has(draft.businessStatus as WorkRecordBusinessStatus)
    && isGuidOrEmpty(draft.assigneeAgentId)
    && isGuidOrEmpty(draft.qaAssigneeAgentId)
    && isResponsibilities(draft.userResponsibilities)
    && isGuidOrEmpty(draft.parentRecordId)
    && isStringArray(draft.predecessorRecordIds)
    && (draft.packageQaRole === "execution" || draft.packageQaRole === "qa")
    && typeof draft.qaRetestExemptionReason === "string" && draft.qaRetestExemptionReason.length <= 2_000
    && isGuidOrEmpty(draft.iterationId)
    && ITERATION_MODES.has(draft.iterationAssignmentMode as WorkRecordIterationAssignmentMode)
    && isDateOrEmpty(draft.plannedStartDate)
    && isDateOrEmpty(draft.plannedCompletionDate)
    && PRIORITIES.has(draft.priority as IssuePriority)
    && (draft.defectSeverity === "" || SEVERITIES.has(draft.defectSeverity as WorkRecordDefectSeverity))
    && isGuidOrEmpty(draft.foundInVersionId);
}

function isScope(value: unknown): value is WorkRecordDraftScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Partial<WorkRecordDraftScope>;
  return typeof scope.principalId === "string" && scope.principalId.length > 0
    && typeof scope.companyId === "string" && scope.companyId.length > 0
    && typeof scope.projectId === "string" && scope.projectId.length > 0
    && (scope.kind === "plan" || scope.kind === "defect")
    && typeof scope.recordId === "string" && scope.recordId.length > 0;
}

function sameScope(left: WorkRecordDraftScope, right: WorkRecordDraftScope) {
  return left.principalId === right.principalId
    && left.companyId === right.companyId
    && left.projectId === right.projectId
    && left.kind === right.kind
    && left.recordId === right.recordId;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isEnvelope(value: unknown): value is WorkRecordDraftEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Partial<WorkRecordDraftEnvelope>;
  if (
    envelope.version !== 1
    || !isScope(envelope.scope)
    || !Number.isInteger(envelope.baseRevision) || (envelope.baseRevision ?? 0) <= 0
    || !Number.isInteger(envelope.baseDependencySetRevision) || (envelope.baseDependencySetRevision ?? 0) <= 0
    || !isDraft(envelope.baseSnapshot)
    || !isDraft(envelope.draft)
    || !Array.isArray(envelope.changedFields)
    || !isIsoTimestamp(envelope.updatedAt)
  ) return false;
  const changedFields = envelope.changedFields as WorkRecordDraftField[];
  if (changedFields.some((field) => !DRAFT_FIELDS.includes(field)) || new Set(changedFields).size !== changedFields.length) return false;
  return JSON.stringify(changedFields) === JSON.stringify(changedWorkRecordDraftFields(envelope.baseSnapshot, envelope.draft));
}

export function emptyWorkRecordDraft(): WorkRecordEditorDraft {
  return {
    title: "", description: "", businessStatus: "backlog", assigneeAgentId: "", qaAssigneeAgentId: "",
    userResponsibilities: [], parentRecordId: "", predecessorRecordIds: [], packageQaRole: "execution",
    qaRetestExemptionReason: "", iterationId: "", iterationAssignmentMode: "independent",
    plannedStartDate: "", plannedCompletionDate: "", priority: "medium", defectSeverity: "", foundInVersionId: "",
  };
}

export function workRecordEditorDraftFromRecord(record: WorkRecord): WorkRecordEditorDraft {
  return {
    title: record.title,
    description: record.description ?? "",
    businessStatus: record.businessStatus,
    assigneeAgentId: record.assigneeAgentId ?? "",
    qaAssigneeAgentId: record.qaAssigneeAgentId ?? "",
    userResponsibilities: normalizeResponsibilities(record.userResponsibilities),
    parentRecordId: record.parentRecordId ?? "",
    predecessorRecordIds: normalizeStringSet(record.dependencies.map((dependency) => dependency.predecessorRecordId)),
    packageQaRole: record.packageQaRole ?? "execution",
    qaRetestExemptionReason: record.qaRetestExemptionReason ?? "",
    iterationId: record.iterationId ?? "",
    iterationAssignmentMode: record.iterationAssignmentMode ?? (record.parentRecordId ? "inherit_parent" : "independent"),
    plannedStartDate: record.plannedStartDate ?? "",
    plannedCompletionDate: record.plannedCompletionDate ?? "",
    priority: record.priority,
    defectSeverity: record.defectSeverity ?? "",
    foundInVersionId: record.foundInVersionId ?? "",
  };
}

export function applyWorkRecordDraftFields(target: WorkRecordEditorDraft, source: WorkRecordEditorDraft, fields: WorkRecordDraftField[]) {
  const next = structuredClone(target);
  const writable = next as unknown as Record<WorkRecordDraftField, unknown>;
  for (const field of fields) writable[field] = structuredClone(source[field]);
  return next;
}

export function workRecordDraftStorageKey(scope: WorkRecordDraftScope) {
  if (!isScope(scope)) throw new Error("Work record draft scope must contain a real principal and record identity");
  return `paperclip:work-record-draft:v1:${[scope.principalId, scope.companyId, scope.projectId, scope.kind, scope.recordId].map(encodeURIComponent).join(":")}`;
}

export function changedWorkRecordDraftFields(base: WorkRecordEditorDraft, draft: WorkRecordEditorDraft): WorkRecordDraftField[] {
  return DRAFT_FIELDS.filter((field) => !sameFieldValue(field, base, draft));
}

export function createWorkRecordDraftEnvelope(input: {
  scope: WorkRecordDraftScope;
  baseRevision: number;
  baseDependencySetRevision: number;
  baseSnapshot: WorkRecordEditorDraft;
  draft: WorkRecordEditorDraft;
  updatedAt?: string;
}): WorkRecordDraftEnvelope {
  if (!isScope(input.scope)) throw new Error("Work record draft scope is invalid");
  return {
    version: 1,
    scope: structuredClone(input.scope),
    baseRevision: input.baseRevision,
    baseDependencySetRevision: input.baseDependencySetRevision,
    baseSnapshot: structuredClone(input.baseSnapshot),
    draft: structuredClone(input.draft),
    changedFields: changedWorkRecordDraftFields(input.baseSnapshot, input.draft),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function saveWorkRecordDraft(storage: WorkRecordDraftStorage, key: string, envelope: WorkRecordDraftEnvelope): boolean {
  try {
    if (key !== workRecordDraftStorageKey(envelope.scope)) return false;
    const serialized = JSON.stringify(envelope);
    if (new TextEncoder().encode(serialized).byteLength > WORK_RECORD_DRAFT_MAX_BYTES) return false;
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkRecordDraft(storage: WorkRecordDraftStorage, key: string, expectedScope: WorkRecordDraftScope): WorkRecordDraftLoadResult {
  if (key !== workRecordDraftStorageKey(expectedScope)) return { status: "invalid", reason: "scope_mismatch" };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
  if (raw === null) return { status: "empty" };
  if (new TextEncoder().encode(raw).byteLength > WORK_RECORD_DRAFT_MAX_BYTES) return { status: "invalid", reason: "too_large" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version !== 1) return { status: "invalid", reason: "unsupported" };
    if (!isEnvelope(parsed)) return { status: "invalid", reason: "malformed" };
    if (!sameScope(parsed.scope, expectedScope)) return { status: "invalid", reason: "scope_mismatch" };
    return { status: "ready", envelope: parsed };
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
}

export function removeWorkRecordDraft(storage: WorkRecordDraftStorage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function mergeWorkRecordDraft(input: { base: WorkRecordEditorDraft; local: WorkRecordEditorDraft; remote: WorkRecordEditorDraft }) {
  let merged = structuredClone(input.remote);
  const conflictGroups: WorkRecordDraftField[][] = [];
  for (const group of MERGE_GROUPS) {
    const localChanged = group.some((field) => !sameFieldValue(field, input.base, input.local));
    const remoteChanged = group.some((field) => !sameFieldValue(field, input.base, input.remote));
    const sameResult = group.every((field) => sameFieldValue(field, input.local, input.remote));
    if (localChanged && remoteChanged && !sameResult) {
      conflictGroups.push([...group]);
      continue;
    }
    if (localChanged) merged = applyWorkRecordDraftFields(merged, input.local, group);
  }
  const conflicts = [...new Set(conflictGroups.flat())];
  return { merged, conflicts, conflictGroups, changedFields: changedWorkRecordDraftFields(input.remote, merged) };
}

export function buildWorkRecordDraftPatch(input: {
  kind: WorkRecordKind;
  base: WorkRecordEditorDraft;
  draft: WorkRecordEditorDraft;
  expectedRevision: number;
  dependencySetRevision: number;
}): UpdateWorkRecord | null {
  const changed = new Set(changedWorkRecordDraftFields(input.base, input.draft));
  const patch: Record<string, unknown> = { expectedRevision: input.expectedRevision };
  const copy = (field: WorkRecordDraftField, value: unknown) => { if (changed.has(field)) patch[field] = value; };
  copy("title", input.draft.title.trim());
  copy("description", input.draft.description === "" ? null : input.draft.description);
  copy("businessStatus", input.draft.businessStatus);
  copy("assigneeAgentId", input.draft.assigneeAgentId || null);
  copy("qaAssigneeAgentId", input.draft.qaAssigneeAgentId || null);
  copy("userResponsibilities", normalizeResponsibilities(input.draft.userResponsibilities));
  copy("priority", input.draft.priority);

  if (["parentRecordId", "iterationAssignmentMode", "iterationId"].some((field) => changed.has(field as WorkRecordDraftField))) {
    patch.parentRecordId = input.draft.parentRecordId || null;
    patch.iterationAssignmentMode = input.draft.iterationAssignmentMode;
    patch.iterationId = input.draft.iterationAssignmentMode === "inherit_parent" ? null : input.draft.iterationId || null;
  }
  if (["plannedStartDate", "plannedCompletionDate"].some((field) => changed.has(field as WorkRecordDraftField))) {
    patch.plannedStartDate = input.draft.plannedStartDate || null;
    patch.plannedCompletionDate = input.draft.plannedCompletionDate || null;
  }
  if (input.kind === "plan" && ["packageQaRole", "qaRetestExemptionReason"].some((field) => changed.has(field as WorkRecordDraftField))) {
    patch.packageQaRole = input.draft.packageQaRole;
    patch.qaRetestExemptionReason = input.draft.packageQaRole === "qa"
      ? null
      : input.draft.qaRetestExemptionReason === "" ? null : input.draft.qaRetestExemptionReason;
  }
  if (input.kind === "defect") {
    copy("defectSeverity", input.draft.defectSeverity || null);
    copy("foundInVersionId", input.draft.foundInVersionId || null);
  }
  if (changed.has("predecessorRecordIds")) {
    patch.predecessorRecordIds = normalizeStringSet(input.draft.predecessorRecordIds);
    patch.dependencySetRevision = input.dependencySetRevision;
  }
  return Object.keys(patch).length === 1 ? null : patch as UpdateWorkRecord;
}
