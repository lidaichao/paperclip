import { l10n } from "../../i18n";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? l10n("local.local_trusted_dd3af0b2")
      : l10n("local.authenticated_value_cbc0649f", {v0: (deploymentExposure ?? "private")});

  return <Badge variant="outline">{label}</Badge>;
}
