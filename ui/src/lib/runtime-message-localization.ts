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
};

/** Translate only stable Alice-authored lifecycle messages. */
export function localizeRuntimeMessage(message: string): string {
  const key = RUNTIME_MESSAGE_KEYS[message.trim()];
  return key ? l10n(key) : message;
}
