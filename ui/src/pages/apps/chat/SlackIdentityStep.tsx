import { l10n } from "../../../i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

export function SlackIdentityStep({ endpointId, command, testStartedAt, onConnected, onSaveExit }: {
  endpointId: string;
  command: string;
  testStartedAt?: string | null;
  onConnected: () => void;
  onSaveExit: () => void;
}) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession, retry: false });
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const identities = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const local = health.data?.deploymentMode === "local_trusted";
  const userId = local ? "local-board" : session.data?.user.id;
  const userLabel = local ? l10n("local.local_board_fbc35f86") : session.data?.user.name || session.data?.user.email;
  const candidates = (identities.data ?? []).filter((identity) => identity.lastConnectAt &&
    (!testStartedAt || Date.parse(identity.lastConnectAt) >= Date.parse(testStartedAt)));
  const linkedToMe = candidates.some((identity) => identity.status === "linked" && identity.paperclipUserId === userId);
  const connectCommand = `${command} connect`;
  const link = useMutation({
    mutationFn: async (principalId: string) => {
      const { confirmationUrl } = await chatEndpointsApi.createLinkIntent(endpointId, principalId);
      const token = new URL(confirmationUrl, window.location.origin).searchParams.get("token");
      if (!token) throw new Error("Could not create the account confirmation. Try again.");
      await chatEndpointsApi.confirmIdentityLink(token);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chatEndpoints.principals(endpointId) }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{l10n("local.connect_your_slack_account_afd67dc6")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.send_this_command_in_slack_so_we_can_identify_074a2e13")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
        <code className="text-sm">{connectCommand}</code>
        <Button variant="ghost" size="sm" onClick={() => {
          void copyTextToClipboard(connectCommand).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
        }}><Copy className="size-4" />{copied ? l10n("local.copied_8d525e5f") : l10n("local.copy_command_9a01feec")}</Button>
      </div>
      {copyError && <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_copy_the_command_select_and_cop_45461a4d")}</p>}
      <p className="text-sm">
        <a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{l10n("local.open_slack_4ddf02a3")}{" "}<ExternalLink className="inline size-3" /></a>{l10n("local._send_the_command_in_your_workspace_then_retu_60046ba6")}</p>
      {identities.isError ? (
        <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_check_for_your_slack_account_we_c513b410")}</p>
      ) : candidates.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{l10n("local.waiting_for_your_connect_command_beec86ad")}</p>
      ) : (
        <div className={`space-y-3 rounded-lg border p-4 ${linkedToMe
          ? "border-(--status-task-done)/30 bg-(--status-task-done)/10"
          : "border-(--status-task-todo)/30 bg-(--status-task-todo)/10"}`}>
          <p className="text-sm">{l10n("local.choose_your_slack_account_below_to_link_it_to_b2acc558")}{" "}<strong>{userLabel ?? l10n("local.your_paperclip_account_3dc48813")}</strong>{l10n("local._only_confirm_an_account_that_belongs_to_you_9a119a5b")}</p>
          {candidates.map((identity) => {
            const mine = identity.status === "linked" && identity.paperclipUserId === userId;
            return (
              <div key={identity.principalId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{identity.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">{identity.externalDetail}</p>
                </div>
                {mine ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-(--status-task-done)" />{l10n("local.linked_to_you_a4856938")}</p>
                  : identity.status === "linked" ? <p className="text-sm text-muted-foreground">{l10n("local.linked_to_38c72375")}{" "}{identity.paperclipUserLabel ?? l10n("local.another_paperclip_account_823087d6")}</p>
                  : <Button variant="outline" disabled={!userId || link.isPending} onClick={() => link.mutate(identity.principalId)} aria-label={l10n("local.link_value_to_my_paperclip_account_5eadbcb4", {v0: (identity.externalLabel)})}>
                    {link.isPending && link.variables === identity.principalId && <Loader2 className="size-4 animate-spin" />}{l10n("local.this_is_my_slack_account_06e7c1bb")}</Button>}
              </div>
            );
          })}
        </div>
      )}
      {!userId && !session.isPending && !health.isPending && <p role="alert" className="text-sm text-destructive">{l10n("local.sign_in_to_paperclip_to_link_your_slack_accou_2de04321")}</p>}
      {link.isError && <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_link_your_account_check_that_yo_93ca6701")}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" className="text-muted-foreground" onClick={onSaveExit}>{l10n("local.save_amp_exit_df456d65")}</Button>
        {linkedToMe && <Button onClick={onConnected}>{l10n("local.continue_to_message_test_4e1133bf")}</Button>}
      </div>
    </div>
  );
}
