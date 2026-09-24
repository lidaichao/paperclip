import { l10n } from "../i18n";
import type { IssueChangeReceiptEntry } from "@paperclipai/shared";
import { formatReviewPolicyValue } from "./review-policy";

/**
 * Read + format the field-level change receipts carried on an `issue.updated`
 * activity event (the open cross-task write design (audit), built on the field-change receipts the API already records).
 *
 * Every issue PATCH — agent and board alike — must leave an auditable record of
 * who changed what, when, and under which authorization. The server writes that
 * receipt; this module turns it into something a human can scan in the activity
 * stream without opening the audit log.
 *
 * The server already drops `updatedAt` and truncates long text (flagging it with
 * `updated: true`), so this module renders what it is given rather than
 * re-deciding what is interesting.
 */

/** Field names whose raw ids carry no meaning in a scannable summary. */
const FIELD_LABELS: Record<string, string> = {
  assigneeAgentId: l10n("local.assignee_5e20d20e"),
  assigneeUserId: l10n("local.assignee_user_aab320ef"),
  responsibleUserId: l10n("local.responsible_user_aafb0485"),
  blockedByIssueIds: l10n("local.blockers_cb9b9d5c"),
  labelIds: l10n("local.labels_934b8899"),
  parentId: l10n("local.parent_5f7953f7"),
  projectId: l10n("local.project_98595978"),
  goalId: l10n("local.goal_cdbf6975"),
  workMode: l10n("local.work_mode_b4c4aec3"),
  reviewPolicy: l10n("local.who_can_approve_933be04f"),
  billingCode: l10n("local.billing_code_1aad3d28"),
  checkoutRunId: l10n("local.checkout_run_d755944f"),
  executionRunId: l10n("local.execution_run_d78fe751"),
  hiddenAt: l10n("local.hidden_7e6fefff"),
  startedAt: l10n("local.started_ecbc89cd"),
  completedAt: l10n("local.completed_22a970d2"),
  cancelledAt: l10n("local.cancelled_d353a99e"),
  requestDepth: l10n("local.request_depth_bdf6410f"),
  sourceTrust: l10n("local.source_trust_5894ecd9"),
  executionPolicy: l10n("local.execution_policy_b9215cec"),
  executionWorkspaceId: l10n("local.execution_workspace_d31c92b6"),
  projectWorkspaceId: l10n("local.project_workspace_ce016e7f"),
};

/** Human label for a changed field, e.g. `assigneeAgentId` → "Assignee". */
export function issueChangeFieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  // camelCase / snake_case → "Sentence case".
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const VALUE_PREVIEW_BUDGET = 72;

/**
 * Render one side of a change for display. Never returns an empty string, so a
 * receipt row always reads as "from → to" rather than trailing into nothing.
 */
export function formatIssueChangeValue(
  value: unknown,
  options: { resolveAgentLabel?: (id: string) => string | null | undefined;
    resolveUserLabel?: (id: string) => string | null | undefined;
    field?: string } = {},
): string {
  // `reviewPolicy` is nullable-by-default: a cleared column means "anyone can
  // approve", not "no value" (PAP-16506), so it resolves before the null branch.
  if (options.field === "reviewPolicy") return formatReviewPolicyValue(value);
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    const strings = value.filter((entry): entry is string => typeof entry === "string");
    if (strings.length !== value.length) return `${value.length} items`;
    return strings.length <= 3
      ? strings.map((id) => shortenId(id)).join(", ")
      : `${strings.length} items`;
  }

  if (value instanceof Date) return value.toLocaleString();

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "none";
    // Ids resolve to names when the directory is loaded; otherwise they shorten.
    const resolved = options.field?.toLowerCase().includes("agent")
      ? options.resolveAgentLabel?.(trimmed)
      : options.field?.toLowerCase().includes("user")
        ? options.resolveUserLabel?.(trimmed)
        : null;
    if (resolved) return resolved;
    if (isIsoTimestamp(trimmed)) return new Date(trimmed).toLocaleString();
    if (looksLikeId(trimmed)) return shortenId(trimmed);
    const humanized = trimmed.includes(" ") ? trimmed : trimmed.replace(/_/g, " ");
    return truncate(humanized);
  }

  // Objects (execution policy, workspace settings) are structural — the receipt
  // records that they moved, and the audit log holds the full value.
  return "updated";
}

function truncate(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= VALUE_PREVIEW_BUDGET) return value;
  return `${chars.slice(0, VALUE_PREVIEW_BUDGET).join("")}…`;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function shortenId(value: string): string {
  return looksLikeId(value) ? value.slice(0, 8) : truncate(value);
}

export interface IssueChangeReceiptRow {
  field: string;
  label: string;
  from: string;
  to: string;
  /** Server flagged the values as truncated previews of long text. */
  truncated: boolean;
}

function isChangeEntry(value: unknown): value is IssueChangeReceiptEntry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "from" in (value as object) && "to" in (value as object);
}

/**
 * Parse `details.changes` off an activity event into display rows. Returns an
 * empty array for events with no receipt (older rows, non-PATCH actions), so
 * callers can render nothing without special-casing.
 */
export function readIssueChangeReceipt(
  details: Record<string, unknown> | null | undefined,
  options: Parameters<typeof formatIssueChangeValue>[1] = {},
): IssueChangeReceiptRow[] {
  const changes = details?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

  const rows: IssueChangeReceiptRow[] = [];
  for (const [field, entry] of Object.entries(changes as Record<string, unknown>)) {
    if (!isChangeEntry(entry)) continue;
    rows.push({
      field,
      label: issueChangeFieldLabel(field),
      from: formatIssueChangeValue(entry.from, { ...options, field }),
      to: formatIssueChangeValue(entry.to, { ...options, field }),
      truncated: entry.updated === true,
    });
  }
  // Stable, scannable order regardless of JSON key order (jsonb reorders keys).
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** Authorization reasons, as recorded by the server's write-policy decision. */
const AUTHORIZATION_REASON_LABELS: Record<string, string> = {
  allow_visible_issue_write: l10n("local.default_open_write_on_a_visible_task_b8bfd7fd"),
  allow_scoped_agent_write: l10n("local.scoped_agent_write_bc00f989"),
  allow_board_actor: l10n("local.board_actor_cf2ed14e"),
  allow_self: l10n("local.own_task_d37df892"),
  allow_issue_mention_grant: l10n("local.mention_grant_982e0e74"),
  allow_direct_parent_report: l10n("local.direct_parent_report_0141a958"),
  allow_low_trust_boundary: l10n("local.low_trust_boundary_allowance_c03a45cf"),
  allow_explicit_grant: l10n("local.explicit_permission_grant_af5e909a"),
  allow_instance_admin: l10n("local.instance_admin_6eabc9c5"),
  allow_local_board: l10n("local.local_board_59e8df74"),
  internal_agent_write: l10n("local.internal_agent_write_1a965cd9"),
};

/**
 * Human phrasing for the authorization reason on a write receipt. Unknown
 * reasons degrade to their humanized code rather than disappearing — an
 * unexplained write is worse than an ugly one.
 */
export function issueAuthorizationReasonLabel(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  return AUTHORIZATION_REASON_LABELS[trimmed] ?? trimmed.replace(/_/g, " ");
}
