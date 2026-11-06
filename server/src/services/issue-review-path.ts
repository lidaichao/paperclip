import type { Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { isConversation } from "./agent-conversations.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueApprovalService, issueThreadInteractionService } from "./index.js";
import { hasQueuedInteractionResponse } from "./queued-interaction-response.js";

export const ACTIVE_REVIEW_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

const INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE =
  "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. " +
  "This request would leave the issue in_review without anyone or anything owning the next action. " +
  "Keep working instead of moving to review, create a request_confirmation or ask_user_questions interaction, " +
  "link or request a pending approval, assign a human reviewer with assigneeUserId, set a typed executionState.currentParticipant through an execution policy, " +
  "or schedule an issue monitor for an external review/check. After creating one of those review paths, retry the status update.";

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function hasScheduledMonitor(input: {
  existingMonitorNextCheckAt?: Date | null;
  patchMonitorNextCheckAt?: unknown;
  executionPolicy?: unknown;
}) {
  if (input.patchMonitorNextCheckAt instanceof Date &&
    !Number.isNaN(input.patchMonitorNextCheckAt.getTime())) return true;
  if (input.patchMonitorNextCheckAt === undefined && input.existingMonitorNextCheckAt) return true;
  const policy = normalizeIssueExecutionPolicy(input.executionPolicy ?? null);
  return Boolean(policy?.monitor?.nextCheckAt);
}

export async function assertInReviewReviewPath(db: Db, input: {
  existing: {
    conversationAgentId?: string | null;
    conversationUserId?: string | null;
    id: string;
    companyId: string;
    status: string;
    assigneeUserId?: string | null;
    assigneeAgentId?: string | null;
    executionState?: unknown;
    monitorNextCheckAt?: Date | null;
  };
  updateFields: Record<string, unknown>;
  actorType: "agent" | "user";
  actorId: string;
  actorAgentId?: string | null;
  actorRunId?: string | null;
  reviewInteractionId?: string;
}) {
  const nextStatus = typeof input.updateFields.status === "string"
    ? input.updateFields.status : input.existing.status;
  if (isConversation(input.existing) && !input.reviewInteractionId) return null;
  if (input.existing.status === "in_review" || nextStatus !== "in_review") return null;
  if (input.actorType !== "agent" && !input.reviewInteractionId) return null;

  const interactions = await issueThreadInteractionService(db).listForIssue(input.existing.id);
  const pendingInteractions = interactions.filter((interaction) => interaction.status === "pending");
  const resolvedSourceResponse = input.actorType === "agent" && input.actorRunId
    ? interactions.find(interaction =>
        interaction.sourceRunId === input.actorRunId &&
        interaction.createdByAgentId === input.actorAgentId &&
        (!input.reviewInteractionId || interaction.id === input.reviewInteractionId) &&
        ["accepted", "answered", "rejected"].includes(interaction.status) &&
        (interaction.continuationPolicy === "wake_assignee" ||
          (interaction.continuationPolicy === "wake_assignee_on_accept" &&
            ["accepted", "answered"].includes(interaction.status))))
    : undefined;
  if (resolvedSourceResponse) return null;
  if (input.reviewInteractionId) {
    const designatedReviewConfirmation = pendingInteractions.find((interaction) =>
      interaction.id === input.reviewInteractionId &&
      (interaction.kind === "request_confirmation" ||
        interaction.kind === "request_checkbox_confirmation") &&
      (input.actorType === "agent"
        ? interaction.createdByAgentId === input.actorAgentId &&
          interaction.sourceRunId === input.actorRunId
        : interaction.createdByUserId === input.actorId) &&
      !(interaction.kind === "request_confirmation" && interaction.payload &&
        typeof interaction.payload === "object" &&
        (("toolAction" in interaction.payload && interaction.payload.toolAction !== undefined) ||
          ("secretProposal" in interaction.payload && interaction.payload.secretProposal !== undefined))),
    );
    if (!designatedReviewConfirmation) {
      const creatorDescription = input.actorType === "agent" ? "this agent run" : "this user";
      throw unprocessable(
        `reviewInteractionId must identify a pending non-tool confirmation created by ${creatorDescription}`,
        { code: "invalid_review_interaction", reviewInteractionId: input.reviewInteractionId },
      );
    }
    return designatedReviewConfirmation.id;
  }

  if (input.actorType !== "agent") return null;
  const nextAssigneeUserId = input.updateFields.assigneeUserId === undefined
    ? input.existing.assigneeUserId : input.updateFields.assigneeUserId;
  if (typeof nextAssigneeUserId === "string" && nextAssigneeUserId.trim().length > 0) return null;
  const nextExecutionState = input.updateFields.executionState === undefined
    ? input.existing.executionState : input.updateFields.executionState;
  if (hasExecutionParticipant(nextExecutionState)) return null;
  if (hasScheduledMonitor({
    existingMonitorNextCheckAt: input.existing.monitorNextCheckAt ?? null,
    patchMonitorNextCheckAt: input.updateFields.monitorNextCheckAt,
    executionPolicy: input.updateFields.executionPolicy,
  })) return null;
  if (pendingInteractions.length > 0) return null;
  if (await hasQueuedInteractionResponse(db, input.existing.companyId,
    input.existing.id, input.existing.assigneeAgentId)) return null;
  const approvals = await issueApprovalService(db).listApprovalsForIssue(input.existing.id);
  if (approvals.some((approval) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(approval.status)))) return null;

  throw unprocessable(INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE, {
    code: "invalid_issue_disposition", missing: "review_path",
    validReviewPaths: [
      "pending_issue_thread_interaction", "linked_pending_approval",
      "human_assignee_user_id", "typed_execution_state_current_participant",
      "scheduled_issue_monitor",
    ],
  });
}
