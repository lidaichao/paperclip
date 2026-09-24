import { l10n } from "../i18n";
import { displayText, displayLocale } from "../i18n/display";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import { BadgeCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sourceTrustLabel } from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";

export function SourceTrustBadge({
  sourceTrust,
  artifactLabel = "content",
  className,
}: {
  sourceTrust: SourceTrustMetadata | null | undefined;
  artifactLabel?: string;
  className?: string;
}) {
  const label = sourceTrustLabel(sourceTrust);
  if (!label) return null;

  const promoted = sourceTrust?.disposition === "promoted";
  const tooltip = promoted
    ? l10n("local.manual_source_promoted", {v0: sourceTrust.promotedAt ? l10n("local.manual_source_promoted_on", {v0: new Date(sourceTrust.promotedAt).toLocaleString(displayLocale())}) : ""})
    : l10n("local.manual_source_raw", {v0: displayText(artifactLabel)});

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={label}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0 text-(length:--text-nano) font-medium tracking-normal",
            promoted
              ? "border-border text-muted-foreground"
              : "border-amber-500/40 text-amber-700 dark:text-amber-100",
            className,
          )}
        >
          {promoted ? <BadgeCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
