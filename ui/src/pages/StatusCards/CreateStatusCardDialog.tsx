import { l10n } from "../../i18n";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { InlineBanner } from "@/components/InlineBanner";
import { queryKeys } from "@/lib/queryKeys";
import { SummarizerAgentSelect } from "./SummarizerAgentSelect";

const EXAMPLES = [
  "issues about evals",
  "everything blocked this week",
  "is feature X live? if not, the exact next actions to ship it",
];

export function CreateStatusCardDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  // "" → the built-in Summarizer; otherwise the id of the override agent.
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPrompt("");
    setAgentId("");
    setError(null);
  }

  function close() {
    onOpenChange(false);
    // Delay reset so the closing animation does not flash cleared fields.
    window.setTimeout(reset, 200);
  }

  const createMutation = useMutation({
    mutationFn: () =>
      statusCardsApi.create(companyId, {
        interestPrompt: prompt.trim(),
        titlePinned: false,
        agentId: agentId || null,
        refreshPolicy: defaultStatusCardRefreshPolicy,
      }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, false) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, true) }),
      ]);
      close();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create the card."),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{l10n("local.new_card_8d3efc39")}</DialogTitle>
          <DialogDescription>
            {l10n("local.one_message_sets_up_the_whole_card_say_what_y_7ce8e93d")}</DialogDescription>
        </DialogHeader>

        {error ? <InlineBanner tone="danger" title={l10n("local.create_failed_3e05ffcf")}>{error}</InlineBanner> : null}

        <div className="space-y-3">
          <label htmlFor="status-card-prompt" className="block pb-1 text-sm font-semibold">
            {l10n("local.what_do_you_want_to_keep_an_eye_on_2abdde3d")}</label>
          <Textarea
            id="status-card-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            autoFocus
            placeholder={l10n("local.keep_an_eye_on_the_id_and_cloud_projects_tell_1cadc7b8")}
            className="text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.examples_e68ee04d")}</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40"
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-semibold">{l10n("local.agent_11b39c93")}</label>
          <SummarizerAgentSelect companyId={companyId} value={agentId} onChange={setAgentId} enabled={open} />
          <p className="text-xs text-muted-foreground">
            {l10n("local.runs_this_card_s_setup_and_updates_leave_on_t_d23a2d8b")}</p>
        </div>

        <DialogFooter>
          <div className="flex gap-2">
            <Button variant="outline" onClick={close} disabled={createMutation.isPending}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={prompt.trim().length === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {l10n("local.create_card_939a6a1b")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
