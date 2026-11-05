import { l10n } from "../i18n";
import { enumLabel } from "../i18n/display";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";
import { formatReviewPolicyValue } from "./review-policy";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": l10n("local.created_406effb1"),
  "issue.updated": l10n("local.updated_27eb5e51"),
  "issue.read_marked": l10n("local.read_3316348d"),
  "issue.read_unmarked": l10n("local.marked_unread_27fd8612"),
  "issue.checked_out": l10n("local.checked_out_7901037f"),
  "issue.released": l10n("local.released_d29eae13"),
  "issue.comment_added": l10n("local.commented_on_189a57e1"),
  "issue.comment_cancelled": l10n("local.cancelled_a_queued_comment_on_d6512e70"),
  "issue.queued_comment_edited": l10n("local.edited_a_queued_comment_on_610f376e"),
  "issue.queued_comments_reordered": l10n("local.reordered_queued_comments_on_0cb8d462"),
  "issue.queued_comment_discarded": l10n("local.discarded_a_queued_comment_on_b3f772fd"),
  "issue.comment_deleted": l10n("local.deleted_a_comment_on_280640c6"),
  "issue.attachment_added": l10n("local.attached_file_to_188d5b2a"),
  "issue.attachment_removed": l10n("local.removed_attachment_from_cbeef6a3"),
  "issue.document_created": l10n("local.created_document_for_30c08d04"),
  "issue.document_updated": l10n("local.updated_document_on_687df025"),
  "issue.document_locked": l10n("local.locked_document_on_970d755c"),
  "issue.document_unlocked": l10n("local.unlocked_document_on_82c64068"),
  "issue.document_deleted": l10n("local.deleted_document_from_b11bafc2"),
  "issue.monitor_scheduled": l10n("local.scheduled_monitor_on_1a877f93"),
  "issue.monitor_triggered": l10n("local.triggered_monitor_for_fc870ab0"),
  "issue.monitor_cleared": l10n("local.cleared_monitor_on_2caca447"),
  "issue.monitor_skipped": l10n("local.skipped_monitor_for_e32135fa"),
  "issue.monitor_exhausted": l10n("local.exhausted_monitor_on_563471d4"),
  "issue.monitor_recovery_wake_queued": l10n("local.queued_monitor_recovery_for_02a94579"),
  "issue.monitor_recovery_issue_created": l10n("local.created_monitor_recovery_for_bfb8e267"),
  "issue.monitor_escalated_to_board": l10n("local.escalated_monitor_for_c9f669fd"),
  "issue.commented": l10n("local.commented_on_189a57e1"),
  "issue.deleted": l10n("local.deleted_1185f37d"),
  "issue.successful_run_handoff_required": l10n("local.flagged_missing_next_step_on_fcc6c86b"),
  "issue.successful_run_handoff_resolved": l10n("local.recorded_next_step_chosen_on_65acaf70"),
  "issue.successful_run_handoff_escalated": l10n("local.escalated_missing_next_step_on_02f63b69"),
  "issue.accepted_plan_decomposition_updated": l10n("local.updated_accepted_plan_decomposition_on_360f8d6e"),
  "issue.recovery_action_opened": l10n("local.opened_a_recovery_action_on_ed7cdf8f"),
  "issue.recovery_action_resolved": l10n("local.resolved_the_recovery_action_on_2b0fb1ac"),
  "issue.recovery_action_escalated": l10n("local.escalated_the_recovery_action_on_2b92ea3f"),
  "agent.created": l10n("local.created_406effb1"),
  "agent.updated": l10n("local.updated_27eb5e51"),
  "agent.paused": l10n("local.paused_a7a9dc5b"),
  "agent.resumed": l10n("local.resumed_cf8ad4d9"),
  "agent.error_cleared": l10n("local.cleared_error_on_e4241a93"),
  "agent.terminated": l10n("local.terminated_e8c95a2a"),
  "agent.key_created": l10n("local.created_api_key_for_758b2e5a"),
  "agent.budget_updated": l10n("local.updated_budget_for_775594b4"),
  "agent.runtime_session_reset": l10n("local.reset_session_for_a1a65b9e"),
  "heartbeat.invoked": l10n("local.invoked_heartbeat_for_d2899821"),
  "heartbeat.cancelled": l10n("local.cancelled_heartbeat_for_e01b6ea0"),
  "heartbeat.output_stale_source_resolved": l10n("local.system_folded_stale_run_on_5ce8c91b"),
  "heartbeat.output_stale_recovery_recursion_refused": l10n("local.refused_recovery_on_recovery_for_7144956d"),
  "approval.created": l10n("local.requested_approval_b9dd33f1"),
  "approval.approved": l10n("local.approved_2687f86e"),
  "approval.rejected": l10n("local.rejected_20cd938a"),
  // Interaction outcomes (PAP-16506). An agent may now resolve one — including a
  // review of its own work — so these must read as outcomes in the feed instead
  // of falling through to the raw "issue thread interaction accepted" action id.
  // `details.interactionKind` sharpens the wording; see INTERACTION_OUTCOME_LABELS.
  "issue.thread_interaction_created": l10n("local.asked_for_a_decision_on_d9f4516a"),
  "issue.thread_interaction_accepted": l10n("local.accepted_the_request_on_92ff89db"),
  "issue.thread_interaction_rejected": l10n("local.rejected_the_request_on_130d3312"),
  "issue.thread_interaction_answered": l10n("local.answered_the_request_on_e29fe756"),
  "issue.thread_interaction_withdrawn": l10n("local.withdrew_the_request_on_91783315"),
  "issue.thread_interaction_cancelled": l10n("local.cancelled_the_request_on_a394e9e7"),
  "issue.thread_interaction_skipped": l10n("local.skipped_the_request_on_a0ef8e86"),
  "issue.thread_interaction_expired": l10n("local.expired_the_request_on_7dea2985"),
  "issue.thread_interaction_item_verdicts_submitted": l10n("local.submitted_verdicts_on_a5476053"),
  "issue.stalled_review_decided": l10n("local.recorded_a_review_verdict_on_56bf2707"),
  "project.created": l10n("local.created_406effb1"),
  "project.updated": l10n("local.updated_27eb5e51"),
  "project.deleted": l10n("local.deleted_1185f37d"),
  "goal.created": l10n("local.created_406effb1"),
  "goal.updated": l10n("local.updated_27eb5e51"),
  "goal.deleted": l10n("local.deleted_1185f37d"),
  "cost.reported": l10n("local.reported_cost_for_4fefe239"),
  "cost.recorded": l10n("local.recorded_cost_for_ecb04581"),
  "company.created": l10n("local.created_organization_205554dd"),
  "company.updated": l10n("local.updated_organization_5c628ba3"),
  "company.archived": l10n("local.archived_dd9e8812"),
  "company.reactivated": l10n("local.reactivated_f9176977"),
  "company.budget_updated": l10n("local.updated_budget_for_775594b4"),
  "audit.exported": l10n("local.exported_the_agent_audit_log_for_593df5cb"),
  "tool_app.connected": l10n("local.connected_12a7bd86"),
  "tool_app.oauth_connected": l10n("local.connected_credentials_for_a5565c1f"),
  "tool_app.oauth_failed": l10n("local.failed_to_connect_credentials_for_e1866a22"),
  "tool_app.oauth_access_finalized": l10n("local.finished_credential_access_for_25c33b98"),
  "tool_app.finished": l10n("local.finished_setup_for_52ae9ebb"),
  "tool_app.reconnected": l10n("local.reconnected_6f0258f8"),
  "tool_connection.created": l10n("local.created_406effb1"),
  "tool_connection.updated": l10n("local.updated_27eb5e51"),
  "tool_connection.archived": l10n("local.removed_e1f79758"),
  "tool_connection.catalog_refresh": l10n("local.refreshed_actions_for_6d7c49ef"),
  "tool_connection.installs_synced": l10n("local.changed_agent_installs_for_e0c04196"),
  "tool_connection.install_access_extended": l10n("local.extended_agent_access_for_6c73a9e3"),
  "tool_connection.grant_audience_replaced": l10n("local.changed_human_access_for_01dc059e"),
  "tool_connection.grant_added": l10n("local.added_credentials_to_ad55b2e5"),
  "tool_connection.grant_revoked": l10n("local.revoked_credentials_from_52423f02"),
  "tool_connection.grant_delegated": l10n("local.delegated_credentials_for_a8fc31d4"),
  "tool_connection.grant_delegation_revoked": l10n("local.revoked_credential_delegation_for_75ee3ee2"),
  "environment.lease_acquired": l10n("local.manual_environment_lease_acquired"),
  "environment.lease_released": l10n("local.manual_environment_lease_released"),
  "provider_trace.capture_requested": l10n("local.manual_provider_trace_capture_requested"),
  "provider_trace.metadata_listed": l10n("local.manual_provider_trace_metadata_listed"),
  "provider_trace.redacted_viewed": l10n("local.manual_provider_trace_redacted_viewed"),
  "provider_trace.workspace_diffs_reprojected": l10n("local.manual_provider_trace_diffs_reprojected"),
  "provider_trace.frame_revealed": l10n("local.manual_provider_trace_frame_revealed"),
  "provider_trace.downloaded": l10n("local.manual_provider_trace_downloaded"),
  "provider_trace.deleted": l10n("local.manual_provider_trace_deleted"),
  "provider_trace.expired": l10n("local.manual_provider_trace_expired"),
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": l10n("local.created_the_issue_9d8ff2c0"),
  "issue.updated": l10n("local.updated_the_issue_ad4620e2"),
  "issue.checked_out": l10n("local.checked_out_the_issue_6716c0d7"),
  "issue.released": l10n("local.released_the_issue_fea7c629"),
  "issue.comment_added": l10n("local.added_a_comment_112609f0"),
  "issue.comment_cancelled": l10n("local.cancelled_a_queued_comment_1b529df8"),
  "issue.queued_comment_edited": l10n("local.edited_a_queued_comment_949cb992"),
  "issue.queued_comments_reordered": l10n("local.reordered_queued_comments_e19f9ce8"),
  "issue.queued_comment_discarded": l10n("local.discarded_a_queued_comment_4ddb19a8"),
  "issue.comment_deleted": l10n("local.deleted_a_comment_8f41dfb4"),
  "issue.feedback_vote_saved": l10n("local.saved_feedback_on_an_ai_output_8f8379a0"),
  "issue.attachment_added": l10n("local.added_an_attachment_e285ebec"),
  "issue.attachment_removed": l10n("local.removed_an_attachment_ce47849e"),
  "issue.document_created": l10n("local.created_a_document_a604892e"),
  "issue.document_updated": l10n("local.updated_a_document_dc27a3d0"),
  "issue.document_locked": l10n("local.locked_a_document_a4b384bd"),
  "issue.document_unlocked": l10n("local.unlocked_a_document_8d59fb8a"),
  "issue.document_deleted": l10n("local.deleted_a_document_9bbec11b"),
  "issue.monitor_scheduled": l10n("local.scheduled_a_monitor_c813fd09"),
  "issue.monitor_triggered": l10n("local.triggered_a_monitor_96c68e8b"),
  "issue.monitor_cleared": l10n("local.cleared_a_monitor_c8004e58"),
  "issue.monitor_skipped": l10n("local.skipped_a_monitor_901fd805"),
  "issue.monitor_exhausted": l10n("local.exhausted_a_monitor_c877954e"),
  "issue.monitor_recovery_wake_queued": l10n("local.queued_a_monitor_recovery_wake_d5ffedde"),
  "issue.monitor_recovery_issue_created": l10n("local.created_a_monitor_recovery_issue_3ce71d9e"),
  "issue.monitor_escalated_to_board": l10n("local.escalated_a_monitor_to_the_board_d9d7a2b3"),
  "issue.deleted": l10n("local.deleted_the_issue_95d0072b"),
  "issue.successful_run_handoff_required": l10n("local.run_finished_without_a_clear_next_step_10aac19b"),
  "issue.successful_run_handoff_resolved": l10n("local.next_step_chosen_ac2c77e2"),
  "issue.successful_run_handoff_escalated": l10n("local.run_finished_without_a_next_step_recovery_esc_e64846a5"),
  "issue.cross_issue_influence_cap_rejected": l10n("local.hit_the_per_run_cross_task_write_cap_65c620aa"),
  "issue.cross_issue_influence_observed": l10n("local.made_a_cross_task_write_b66ede03"),
  "issue.attribution_spoof_rejected": l10n("local.tried_to_choose_its_own_responsible_user_d9bfdb06"),
  "issue.recovery_action_opened": l10n("local.opened_a_source_scoped_recovery_action_f8b3a8a5"),
  "issue.recovery_action_resolved": l10n("local.resolved_the_recovery_action_2a5db4b4"),
  "issue.recovery_action_escalated": l10n("local.escalated_the_recovery_action_ca139ac5"),
  "issue.accepted_plan_decomposition_updated": l10n("local.updated_the_accepted_plan_decomposition_d3bed05b"),
  "agent.created": l10n("local.created_an_agent_a0c57525"),
  "agent.updated": l10n("local.updated_the_agent_87de823b"),
  "agent.paused": l10n("local.paused_the_agent_61e9f800"),
  "agent.resumed": l10n("local.resumed_the_agent_312c5ea0"),
  "agent.error_cleared": l10n("local.cleared_the_agent_error_05290279"),
  "agent.terminated": l10n("local.terminated_the_agent_7f5b16a9"),
  "heartbeat.invoked": l10n("local.invoked_a_heartbeat_5ae5dbdd"),
  "heartbeat.cancelled": l10n("local.cancelled_a_heartbeat_042ad8c7"),
  "heartbeat.output_stale_source_resolved": l10n("local.system_folded_a_stale_run_e621cf5c"),
  "heartbeat.output_stale_recovery_recursion_refused": l10n("local.refused_recovery_on_recovery_escalation_344e9249"),
  "approval.created": l10n("local.requested_approval_b9dd33f1"),
  "approval.approved": l10n("local.approved_2687f86e"),
  "approval.rejected": l10n("local.rejected_20cd938a"),
  "issue.thread_interaction_created": l10n("local.asked_for_a_decision_9355a156"),
  "issue.thread_interaction_accepted": l10n("local.accepted_the_request_f94438e4"),
  "issue.thread_interaction_rejected": l10n("local.rejected_the_request_661788ff"),
  "issue.thread_interaction_answered": l10n("local.answered_the_request_5864dcaa"),
  "issue.thread_interaction_withdrawn": l10n("local.withdrew_the_request_6f73bddd"),
  "issue.thread_interaction_cancelled": l10n("local.cancelled_the_request_d2994404"),
  "issue.thread_interaction_skipped": l10n("local.skipped_the_request_9718a716"),
  "issue.thread_interaction_expired": l10n("local.expired_the_request_8f8235ce"),
  "issue.thread_interaction_item_verdicts_submitted": l10n("local.submitted_verdicts_on_the_request_5f3145ac"),
  "issue.stalled_review_decided": l10n("local.recorded_a_review_verdict_622b5a6b"),
};

/**
 * `issue.stalled_review_decided` carries the verb the actor chose, so the line
 * names the verdict ("approved the review") rather than the generic action.
 * Mirrors `StalledReviewDecisionAction` in shared.
 */
const STALLED_REVIEW_DECISION_LABELS: Record<string, string> = {
  approve: l10n("local.approved_the_review_e2e13c49"),
  request_changes: l10n("local.requested_changes_on_the_review_27797516"),
  send_back: l10n("local.sent_the_review_back_to_work_be0191a4"),
};

/**
 * `issue.thread_interaction_accepted` / `_rejected` fire for *every* interaction
 * kind, not only for a review. A task suggestion or a question is accepted, not
 * approved, so the kind on the event picks the verb. Kinds absent from a map
 * keep the neutral "accepted the request" wording from the tables above, which
 * is also the fallback for an event that carries no kind.
 */
const INTERACTION_ACCEPTED_LABELS: Record<string, string> = {
  request_confirmation: l10n("local.approved_the_request_88a99cae"),
  request_checkbox_confirmation: l10n("local.approved_the_request_88a99cae"),
  suggest_tasks: l10n("local.accepted_the_task_suggestions_ff5e01ce"),
  ask_user_questions: l10n("local.accepted_the_answers_84f6bec1"),
};

const INTERACTION_REJECTED_LABELS: Record<string, string> = {
  request_confirmation: l10n("local.rejected_the_request_661788ff"),
  request_checkbox_confirmation: l10n("local.rejected_the_request_661788ff"),
  suggest_tasks: l10n("local.declined_the_task_suggestions_706c5e75"),
  ask_user_questions: l10n("local.declined_the_questions_07ea82d2"),
};

/**
 * Kind-aware wording for an interaction outcome, or `null` when the tables
 * above already say it well enough.
 */
function formatInteractionOutcomeLabel(action: string, details: ActivityDetails): string | null {
  const table = action === "issue.thread_interaction_accepted"
    ? INTERACTION_ACCEPTED_LABELS
    : action === "issue.thread_interaction_rejected"
      ? INTERACTION_REJECTED_LABELS
      : null;
  if (!table) return null;
  const kind = typeof details?.interactionKind === "string" ? details.interactionKind : null;
  return kind ? table[kind] ?? null : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  return enumLabel(String(value ?? "none"), "lower");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId || userId === "local-board") return l10n("local.board_4816cbfd");
  if (options.currentUserId && userId === options.currentUserId) return l10n("local.you_08b04193");
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return l10n("local.user_value_0aa6ba92", {v0: (userId.slice(0, 5))});
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? l10n("local.agent_d4f0bc5a");
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return l10n("local.task_0ebb429f");
}

function formatChangedEntityLabel(
  entity: "blocker" | "reviewer" | "approver",
  labels: string[],
): string {
  const keys = {
    blocker: {
      one: "local.activity_blocker_value_10300587",
      many: "local.activity_blockers_count_10300588",
      empty: "local.activity_blockers_10300589",
    },
    reviewer: {
      one: "local.activity_reviewer_value_10300590",
      many: "local.activity_reviewers_count_10300591",
      empty: "local.activity_reviewers_10300592",
    },
    approver: {
      one: "local.activity_approver_value_10300593",
      many: "local.activity_approvers_count_10300594",
      empty: "local.activity_approvers_10300595",
    },
  } as const;
  const entityKeys = keys[entity];
  if (labels.length <= 0) return l10n(entityKeys.empty);
  if (labels.length === 1) return l10n(entityKeys.one, { v0: labels[0] });
  return l10n(entityKeys.many, { v0: labels.length });
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function readStringArrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === "string" && entry.length > 0).length;
}

function formatAcceptedPlanDecompositionDetail(details: ActivityDetails): string | null {
  if (!details) return null;
  const status = typeof details.status === "string" ? details.status : null;
  const requested = readNumber(details.requestedChildCount);
  const totalChildren = readStringArrayLength(details.childIssueIds);
  const newlyCreated = readStringArrayLength(details.newlyCreatedChildIssueIds);
  const reused = Math.max(0, totalChildren - newlyCreated);
  const parts: string[] = [];
  if (newlyCreated > 0) parts.push(l10n("local.activity_created_new_value_10300567", { v0: newlyCreated }));
  if (reused > 0) parts.push(l10n("local.activity_reused_existing_value_10300568", { v0: reused }));
  if (parts.length === 0 && requested !== null) {
    parts.push(l10n("local.activity_requested_value_10300569", { v0: requested }));
  }
  const summary = parts.length > 0
    ? parts.join(l10n("local.activity_list_separator_10300570"))
    : null;
  if (status === "completed" && summary) {
    return l10n("local.activity_decomposition_completed_summary_10300571", { v0: summary });
  }
  if (status === "completed") return l10n("local.activity_decomposition_completed_10300572");
  if (status === "in_flight" && summary) {
    return l10n("local.activity_decomposition_in_flight_summary_10300573", { v0: summary });
  }
  return summary;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    const to = enumLabel(details.status === "in_review" && details.externalConversationState === "waiting" ? "idle" : String(details.status), "lower");
    return from
      ? l10n("local.activity_changed_status_from_to_on_10300574", { v0: enumLabel(String(from), "lower"), v1: to })
      : l10n("local.activity_changed_status_to_on_10300575", { v0: to });
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? l10n("local.activity_changed_priority_from_to_on_10300576", {
          v0: enumLabel(String(from), "lower"),
          v1: enumLabel(String(details.priority), "lower"),
        })
      : l10n("local.activity_changed_priority_to_on_10300577", { v0: enumLabel(String(details.priority), "lower") });
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? l10n("local.agent_d4f0bc5a");
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    const to = enumLabel(details.status === "in_review" && details.externalConversationState === "waiting" ? "idle" : String(details.status), "lower");
    parts.push(
      from
        ? l10n("local.activity_changed_status_from_to_10300578", { v0: enumLabel(String(from), "lower"), v1: to })
        : l10n("local.activity_changed_status_to_10300579", { v0: to }),
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? l10n("local.activity_changed_priority_from_to_10300580", {
            v0: enumLabel(String(from), "lower"),
            v1: enumLabel(String(details.priority), "lower"),
          })
        : l10n("local.activity_changed_priority_to_10300581", { v0: enumLabel(String(details.priority), "lower") }),
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(
      assigneeName
        ? l10n("local.activity_made_responsible_10300582", { v0: assigneeName })
        : l10n("local.activity_cleared_responsible_10300583"),
    );
  }
  if (details.reviewPolicy !== undefined) {
    // `null` is the default ("anyone can approve"), so it must not read as
    // "changed the review policy to none" (PAP-16506).
    parts.push(l10n("local.activity_changed_approval_policy_10300584", {
      v0: formatReviewPolicyValue(details.reviewPolicy),
    }));
  }
  if (details.title !== undefined) parts.push(l10n("local.activity_updated_title_10300585"));
  if (details.description !== undefined) parts.push(l10n("local.activity_updated_description_10300586"));

  return parts.length > 0
    ? parts.join(l10n("local.activity_list_separator_10300570"))
    : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", added);
      return input.forIssueDetail
        ? l10n("local.activity_added_value_10300596", { v0: changed })
        : l10n("local.activity_added_value_to_10300597", { v0: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", removed);
      return input.forIssueDetail
        ? l10n("local.activity_removed_value_10300598", { v0: changed })
        : l10n("local.activity_removed_value_from_10300599", { v0: changed });
    }
    return input.forIssueDetail
      ? l10n("local.activity_updated_value_10300600", { v0: formatChangedEntityLabel("blocker", []) })
      : l10n("local.activity_updated_value_on_10300601", { v0: formatChangedEntityLabel("blocker", []) });
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const entity = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(entity, added);
      return input.forIssueDetail
        ? l10n("local.activity_added_value_10300596", { v0: changed })
        : l10n("local.activity_added_value_to_10300597", { v0: changed });
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(entity, removed);
      return input.forIssueDetail
        ? l10n("local.activity_removed_value_10300598", { v0: changed })
        : l10n("local.activity_removed_value_from_10300599", { v0: changed });
    }
    const changed = formatChangedEntityLabel(entity, []);
    return input.forIssueDetail
      ? l10n("local.activity_updated_value_10300600", { v0: changed })
      : l10n("local.activity_updated_value_on_10300601", { v0: changed });
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action.startsWith("tool_gateway.")) {
    const rawTool = typeof details?.tool === "string"
      ? details.tool
      : typeof details?.upstreamToolName === "string"
        ? details.upstreamToolName
        : l10n("local.activity_app_action_10300602");
    const tool = rawTool.replace(/[._-]+/g, " ");
    const isTest = details?.source === "test";
    if (action === "tool_gateway.call_completed") {
      return l10n(isTest ? "local.activity_tested_tool_on_10300603" : "local.activity_used_tool_on_10300604", { v0: tool });
    }
    if (action === "tool_gateway.call_allowed") {
      return l10n(isTest ? "local.activity_started_test_tool_on_10300605" : "local.activity_allowed_tool_on_10300606", { v0: tool });
    }
    if (action === "tool_gateway.call_denied") {
      return l10n("local.activity_blocked_tool_on_10300607", { v0: tool });
    }
    if (action === "tool_gateway.approval_requested") {
      return l10n("local.activity_asked_tool_on_10300608", { v0: tool });
    }
    if (action === "tool_gateway.session_created") return l10n("local.activity_opened_session_for_10300609");
    if (action === "tool_gateway.session_rejected") return l10n("local.activity_blocked_session_for_10300610");
    if (action === "tool_gateway.discovery") return l10n("local.activity_discovered_actions_for_10300611");
  }

  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision ? STALLED_REVIEW_DECISION_LABELS[decision] : null;
    if (label) return `${label} on`;
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return `${outcomeLabel} on`;

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (action === "issue.accepted_plan_decomposition_updated") {
    const detail = formatAcceptedPlanDecompositionDetail(details);
    if (detail) return detail;
  }

  if (action === "issue.stalled_review_decided") {
    const decision = typeof details?.action === "string" ? details.action : null;
    const label = decision ? STALLED_REVIEW_DECISION_LABELS[decision] : null;
    if (label) return label;
  }

  const outcomeLabel = formatInteractionOutcomeLabel(action, details);
  if (outcomeLabel) return outcomeLabel;

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
    return serviceName ? `${base} for ${serviceName}` : base;
  }

  if (
    (
      action === "issue.document_created" ||
      action === "issue.document_updated" ||
      action === "issue.document_locked" ||
      action === "issue.document_unlocked" ||
      action === "issue.document_deleted"
    ) &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
