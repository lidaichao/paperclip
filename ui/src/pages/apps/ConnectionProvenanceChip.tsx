import { l10n } from "../../i18n";
import { Blocks } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConnectionProvenanceChip({
  connection,
  className,
}: {
  connection: {
    config?: Record<string, unknown> | null;
    credentialSource?: string;
    externalCredential?: { connectorUid?: string } | null;
  } | null | undefined;
  className?: string;
}) {
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
    className,
  );
  if (connection?.credentialSource === "vercel_connect") {
    const connectorUid = connection.externalCredential?.connectorUid;
    return (
      <span
        className={chipClass}
        title={connectorUid ? l10n("local.credentials_managed_by_vercel_connect_value_bd04515e", {v0: (connectorUid)}) : l10n("local.credentials_managed_by_vercel_connect_25308b6d")}
      >
        <Blocks className="h-3 w-3" />
        {l10n("local.via_vercel_connect_d34e03fb")}</span>
    );
  }

  return null;
}
