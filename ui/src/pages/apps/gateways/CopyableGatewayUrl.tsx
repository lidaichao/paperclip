import { l10n } from "../../../i18n";
import { Copy } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function gatewayEndpointUrl(endpointPath: string): string {
  if (typeof window === "undefined") return endpointPath;
  try {
    return new URL(endpointPath, window.location.origin).toString();
  } catch {
    return endpointPath;
  }
}

export function CopyableGatewayUrl({
  endpointPath,
  className,
}: {
  endpointPath: string;
  className?: string;
}) {
  const { pushToast } = useToast();
  const url = gatewayEndpointUrl(endpointPath);

  async function copy() {
    try {
      await copyTextToClipboard(url);
      pushToast({ title: l10n("local.gateway_url_copied_f0e942a6"), tone: "success" });
    } catch {
      pushToast({
        title: l10n("local.copy_failed_5b50e7a6"),
        body: l10n("local.clipboard_access_is_unavailable_0899c211"),
        tone: "error",
      });
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      className={cn(
        "flex min-w-0 max-w-full items-center gap-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground",
        className,
      )}
      title={l10n("local.value_click_to_copy_008416f1", {v0: (url)})}
      aria-label={l10n("local.copy_gateway_url_4af9347c")}
    >
      <span className="min-w-0 truncate">{url}</span>
      <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}
