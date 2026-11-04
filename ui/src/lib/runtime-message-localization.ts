import { l10n } from "../i18n";

const RUNTIME_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  "Waiting for execution recovery. Your message is saved.": "local.waiting_for_execution_recovery_10301187",
  "The agent has reached its daily limit. Your message is saved until work can resume.": "local.agent_daily_limit_message_saved_10301188",
  "New conversation session": "local.new_conversation_session_10301189",
  "Scheduled retry was requested to run now": "local.scheduled_retry_requested_now_10301190",
  "Scheduled retry became due and was promoted to the queued run pool": "local.scheduled_retry_promoted_10301191",
  "Scheduled retry was promoted to the queued run pool": "local.scheduled_retry_promoted_10301191",
  "Scheduled retry was already promoted": "local.scheduled_retry_already_promoted_10301192",
  "No live scheduled retry exists for this issue": "local.no_live_scheduled_retry_10301193",
  "Process identity recorded; prior stop evidence no longer applies.": "local.process_identity_recorded_10301194",
  "Adopted live child process after hot restart": "local.live_child_process_adopted_10301195",
  "Recovery verified the local process stopped before clearing its identity.": "local.local_process_stop_verified_10301196",
  "The old runner and provider stopped. New user input will use a fresh session; prior action outcomes remain recorded.": "local.old_runtime_stopped_fresh_session_10301197",
  "Native inbound attachment staging cleanup failed.": "local.attachment_staging_cleanup_failed_10301198",
  "Native execution requested; prior local stop evidence no longer applies.": "local.native_execution_requested_10301199",
  "Source-resolved watchdog fold finalized stale active run": "local.stale_active_run_finalized_10301200",
  "Scheduled retry suppressed because the agent no longer exists": "local.retry_agent_missing_10301228",
  "Scheduled retry suppressed because the agent is not invokable": "local.retry_agent_not_invokable_10301229",
  "Scheduled retry suppressed because issue ownership changed": "local.retry_owner_changed_10301230",
  "Scheduled replacement suppressed because the task was blocked after recovery": "local.replacement_blocked_after_recovery_10301231",
  "Scheduled replacement suppressed because another run owns task execution or checkout": "local.replacement_execution_owned_10301232",
  "Scheduled retry suppressed because issue dependencies are still blocked": "local.retry_dependencies_blocked_10301233",
  "Conversation retry is waiting for a response to a pending question or approval": "local.retry_waiting_for_response_10301234",
  "Cancelled because the target issue no longer exists": "local.retry_target_missing_10301235",
  "Cancelled because issue dependencies became blocked before replacement dispatch": "local.replacement_dependencies_blocked_10301236",
  "Subscription retry suppressed because the task execution lock changed": "local.subscription_retry_lock_changed_10301237",
};

/** Translate only stable Alice-authored lifecycle messages. */
export function localizeRuntimeMessage(message: string): string {
  const key = RUNTIME_MESSAGE_KEYS[message.trim()];
  return key ? l10n(key) : message;
}
