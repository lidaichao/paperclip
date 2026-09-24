import { l10n } from "../i18n";
import type { ProviderTraceMetadata } from "@paperclipai/shared";
import { Bug, CircleOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function runRequestedProviderTrace(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (!contextSnapshot) return false;
  const debug = contextSnapshot.debug;
  return (
    typeof debug === "object" &&
    debug !== null &&
    !Array.isArray(debug) &&
    (debug as Record<string, unknown>).providerTrace === "raw"
  );
}

export function ProviderTraceStatusBadge({
  trace,
  requested = false,
  showOff = false,
  className,
}: {
  trace?: ProviderTraceMetadata | null;
  requested?: boolean;
  showOff?: boolean;
  className?: string;
}) {
  const status = trace?.status;
  const expired = trace
    ? new Date(trace.expiresAt).getTime() <= Date.now()
    : false;
  const label = expired
    ? l10n("local.trace_expired_c208aa1a")
    : status === "capturing"
      ? l10n("local.raw_tracing_enabled_812a3547")
      : status === "complete"
        ? l10n("local.trace_captured_c5a0a578")
        : status === "incomplete"
          ? l10n("local.trace_incomplete_329116c8")
          : status === "truncated"
            ? l10n("local.trace_truncated_0efe370c")
            : status === "expired"
              ? l10n("local.trace_expired_c208aa1a")
              : status === "deleted"
                ? l10n("local.trace_deleted_ce1e0dd2")
                : requested
                  ? l10n("local.trace_requested_f1ebbe0e")
                  : showOff
                    ? l10n("local.trace_off_56a98a22")
                    : null;
  if (!label) return null;
  const warning =
    status === "incomplete" ||
    status === "truncated" ||
    status === "expired" ||
    status === "deleted" ||
    expired;
  const Icon = label === "Trace off" ? CircleOff : Bug;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
        label === "Trace off" || label === "Trace deleted" || label === "Trace expired"
          ? "border-border bg-background text-muted-foreground"
          : warning
            ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        className,
      )}
      title={
        trace
          ? l10n("local.value_frames_value_bytes_expires_value_d6e7be65", {v0: (trace.frameCount), v1: (trace.byteCount), v2: (new Date(trace.expiresAt).toLocaleString())})
          : requested
            ? l10n("local.this_run_requested_sensitive_provider_frame_c_4398e38a")
            : l10n("local.raw_provider_frame_capture_was_disabled_for_t_90c06cbc")
      }
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
