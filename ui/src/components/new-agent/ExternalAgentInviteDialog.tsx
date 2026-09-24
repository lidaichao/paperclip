import { l10n } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/** Preserve the existing agent-only invitation path beside the setup wizard. */
export function ExternalAgentInviteDialog({ companyId, onClose, onBack }: {
  companyId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [message, setMessage] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy(value: string) {
    try {
      await copyTextToClipboard(value);
      if (mounted.current) { setCopied(true); setCopyError(false); }
    } catch {
      if (mounted.current) setCopyError(true);
    }
  }
  const createInvite = useMutation({
    mutationFn: async () => {
      const invite = await accessApi.createCompanyInvite(companyId, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: message.trim() || null,
      });
      void cache.invalidateQueries({ queryKey: queryKeys.access.invites(companyId, "all", 5) });
      const path = invite.onboardingTextUrl ?? invite.onboardingTextPath ?? `/api/invites/${invite.token}/onboarding.txt`;
      const onboardingTextUrl = new URL(path, window.location.origin).href;
      const manifest = await accessApi.getInviteOnboarding(invite.token).catch(() => null);
      return buildAgentOnboardingPrompt({
        onboardingTextUrl,
        connectionCandidates: manifest?.onboarding.connectivity?.connectionCandidates ?? null,
        testResolutionUrl: manifest?.onboarding.connectivity?.testResolutionEndpoint?.url ?? null,
      });
    },
    onSuccess: async (value) => {
      if (!mounted.current) return;
      setPrompt(value);
      await copy(value);
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-(--sz-calc-16) overflow-y-auto sm:max-w-2xl">
      <DialogTitle>{prompt ? l10n("local.agent_onboarding_prompt_e2f7c7dd") : l10n("local.invite_an_external_agent_0c21d454")}</DialogTitle>
      <DialogDescription>
        {prompt ? l10n("local.send_this_one_time_prompt_to_the_agent_that_s_c0aa00b8")
          : l10n("local.generate_a_one_time_onboarding_prompt_for_an_8efd37db")}
      </DialogDescription>
      {prompt ? <>
        <Textarea aria-label={l10n("local.agent_onboarding_prompt_e2f7c7dd")} readOnly value={prompt} className="min-h-64 font-mono text-xs" />
        {copyError && <p role="alert" className="text-sm text-muted-foreground">{l10n("local.clipboard_unavailable_copy_the_prompt_manuall_9cdc5c8d")}</p>}
        <div className="flex justify-between gap-4">
          <Button variant="ghost" onClick={onClose}>{l10n("local.done_11a6767d")}</Button>
          <Button variant="outline" onClick={() => void copy(prompt)}>{copied ? l10n("local.copied_prompt_15284f98") : l10n("local.copy_prompt_ffc64b8b")}</Button>
        </div>
      </> : <>
        <label className="space-y-2 text-sm">
          <span>{l10n("local.optional_message_for_the_agent_28ffcc30")}</span>
          <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} className="min-h-24" />
        </label>
        {createInvite.error && <p role="alert" className="text-sm text-destructive">{createInvite.error.message}</p>}
        <div className="flex justify-between gap-4">
          <Button variant="ghost" onClick={onBack}>{l10n("local.back_76900f1b")}</Button>
          <Button disabled={createInvite.isPending} onClick={() => createInvite.mutate()}>
            {createInvite.isPending ? l10n("local.generating_d20a4476") : l10n("local.generate_onboarding_prompt_8248025e")}
          </Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
