import { l10n } from "../i18n";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildHoneycombRunUrl } from "@/lib/honeycomb-run-link";

export function HoneycombRunLink({
  runId,
  enabled,
}: {
  runId: string;
  enabled: boolean;
}) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setHref(null);
      return () => {
        active = false;
      };
    }

    void buildHoneycombRunUrl(runId)
      .then((url) => {
        if (active) setHref(url);
      })
      .catch(() => {
        if (active) setHref(null);
      });

    return () => {
      active = false;
    };
  }, [enabled, runId]);

  if (!enabled || !href) return null;

  return (
    <Button asChild variant="ghost" size="xs">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={l10n("local.open_this_run_s_task_run_trace_query_in_honey_b056c270")}
      >
        <ExternalLink />
        {l10n("local.view_in_honeycomb_358cde94")}</a>
    </Button>
  );
}
