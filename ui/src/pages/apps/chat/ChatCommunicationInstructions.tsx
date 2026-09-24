import { l10n } from "../../../i18n";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ChatCommunicationInstructions({ value, onSave }: {
  value: string;
  onSave: (instructions: string) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const text = draft ?? value;
  const dirty = text.trim() !== value;
  return (
    <form className="space-y-3" aria-labelledby={`${id}-label`} onSubmit={async (event) => {
      event.preventDefault();
      if (pending || !dirty) return;
      setPending(true);
      setError(null);
      setSaved(false);
      try {
        await onSave(text.trim());
        setDraft(null);
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Couldn’t save instructions. Try again.");
      } finally {
        setPending(false);
      }
    }}>
      <div className="space-y-1">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold">{l10n("local.additional_communication_instructions_8bff4980")}</label>
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {l10n("local.guide_how_this_agent_communicates_in_slack_op_c5461a7c")}</p>
      </div>
      <Textarea
        id={id}
        aria-describedby={`${id}-help`}
        value={text}
        disabled={pending}
        maxLength={4000}
        rows={4}
        placeholder={l10n("local.for_example_use_our_product_names_and_explain_0e3d02c6")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); setError(null); }}
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <div>
          {dirty ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); setSaved(false); }}>{l10n("local.cancel_19766ed6")}</Button>
            : saved ? <span role="status" className="text-sm text-muted-foreground">{l10n("local.saved_applies_to_new_tasks_9550c32c")}</span> : null}
        </div>
        <Button type="submit" disabled={!dirty || pending}>{pending ? l10n("local.saving_23e39291") : l10n("local.save_instructions_792ce42e")}</Button>
      </div>
    </form>
  );
}
