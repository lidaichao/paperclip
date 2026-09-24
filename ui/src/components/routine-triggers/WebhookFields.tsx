import { l10n } from "../../i18n";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/clipboard";

export function CopyField({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
        <code title={value} className="min-w-0 flex-1 truncate text-xs">
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={l10n("local.copy_value_3f3ebff4", {v0: (label)})}
          onClick={async () => {
            try {
              await copyTextToClipboard(value);
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? l10n("local.copied_8d525e5f") : l10n("local.copy_e21f935f")}
        </Button>
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {l10n("local.copy_failed_select_and_copy_the_text_below_7a858143")}</p>
          <textarea
            readOnly
            aria-label={l10n("local.value_text_00554678", {v0: (label)})}
            value={value}
            rows={5}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}

export function AgentInstructions({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <section
      aria-label={l10n("local.agent_instructions_dc390e18")}
      className="space-y-3 rounded-md bg-muted/40 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{l10n("local.agent_instructions_dc390e18")}</h2>
        <p className="text-sm text-muted-foreground">
          {l10n("local.give_your_agent_everything_it_needs_to_connec_ea90b46a")}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={l10n("local.copy_for_your_agent_64d2d48d")}
        onClick={async () => {
          try {
            await copyTextToClipboard(value);
            setCopied(true);
            setError(false);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? l10n("local.copied_instructions_28a80735") : l10n("local.copy_for_your_agent_64d2d48d")}
      </Button>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {l10n("local.copy_failed_select_and_copy_the_instructions_a143bf11")}</p>
          <textarea
            readOnly
            aria-label={l10n("local.agent_instructions_text_fe12d6fe")}
            value={value}
            rows={5}
            className="w-full rounded-md border border-input bg-background p-3 text-sm"
          />
        </div>
      )}
    </section>
  );
}
