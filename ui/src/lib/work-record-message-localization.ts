import { l10n } from "../i18n";

const RECOVERY_MESSAGE_KEYS: Record<string, string> = {
  projection_stale: "local.work_record_projection_stale_10301225",
  "Release is waiting for durable delivery": "local.api_release_delivery_pending_10301214",
};

export function localizeWorkRecordRecoveryMessage(message: string | null | undefined): string {
  if (!message) return l10n("local.work_record_recovery_required_10301226");
  if (/[^\u0000-\u007f]/.test(message)) return message;
  const key = RECOVERY_MESSAGE_KEYS[message.trim()];
  return key ? l10n(key) : message;
}
