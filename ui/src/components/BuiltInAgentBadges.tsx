import { l10n } from "../i18n";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";
import type { BuiltInAgentStatus } from "@/api/builtInAgents";

/**
 * Derived lifecycle chip. Rendered for the amber attention states
 * (`needs_setup`, `pending_approval`). Kept separate from the real agent status
 * (`idle/active/…`) per ux-spec D1.
 */
export function BuiltInLifecycleChip({
  status,
  compact = false,
  className,
}: {
  status: BuiltInAgentStatus;
  compact?: boolean;
  className?: string;
}) {
  if (status !== "needs_setup" && status !== "pending_approval") return null;
  const isPendingApproval = status === "pending_approval";
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge.amber,
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title={
        isPendingApproval
          ? l10n("local.waiting_on_board_hire_approval_before_the_fea_b6383320")
          : l10n("local.needs_adapter_model_setup_before_the_feature_7a0680a6")
      }
    >
      {isPendingApproval ? (compact ? l10n("local.approval_147fb813") : l10n("local.pending_approval_bb33a7f4")) : compact ? l10n("local.setup_7013af4c") : l10n("local.needs_setup_b6df2441")}
    </Badge>
  );
}
