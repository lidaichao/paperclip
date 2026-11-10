const safeIssueCreateFields = ["title", "description", "priority", "status", "assigneeAgentId",
  "assigneeUserId", "projectId", "goalId", "parentId", "labelIds", "billingCode"] as const;
const safeCommentCreateFields = ["body"] as const;
const safeDocumentPutFields = ["title", "format", "body", "changeSummary", "baseRevisionId"] as const;
const safeIssuePatchFields = ["title", "description", "priority", "assigneeAgentId", "status"] as const;

function hasOnlyFields(body: unknown, fields: readonly string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => fields.includes(key));
}

function isSafeIssueCreate(body: unknown) {
  if (!hasOnlyFields(body, safeIssueCreateFields)) return false;
  const status = (body as Record<string, unknown>).status;
  return status === undefined || ["backlog", "todo"].includes(String(status));
}

function isSafeCommentCreate(body: unknown) {
  return hasOnlyFields(body, safeCommentCreateFields) &&
    typeof (body as Record<string, unknown>).body === "string";
}

function isSafeDocumentPut(body: unknown) {
  return hasOnlyFields(body, safeDocumentPutFields);
}

function isSafeIssuePatch(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const allowed = new Set<string>(safeIssuePatchFields);
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => !allowed.has(key))) return false;
  return record.status === undefined || ["backlog", "todo"].includes(String(record.status));
}

export function sessionWriteBodyPolicy(method: string, path: string, body: unknown) {
  if (method === "POST" && /^\/api\/companies\//i.test(path)) {
    return { safe: isSafeIssueCreate(body), allowedFields: safeIssueCreateFields };
  }
  if (method === "POST" && /\/comments\/?$/i.test(path)) {
    return { safe: isSafeCommentCreate(body), allowedFields: safeCommentCreateFields };
  }
  if (method === "PATCH") {
    return { safe: isSafeIssuePatch(body), allowedFields: safeIssuePatchFields };
  }
  if (method === "PUT") {
    return { safe: isSafeDocumentPut(body), allowedFields: safeDocumentPutFields };
  }
  return { safe: false, allowedFields: [] as readonly string[] };
}
