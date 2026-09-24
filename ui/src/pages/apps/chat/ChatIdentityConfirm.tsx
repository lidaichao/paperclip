import { l10n } from "../../../i18n";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { healthApi } from "@/api/health";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useSearchParams } from "@/lib/router";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "AgentMail",
  "imessage-photon": "iMessage Photon",
};

export function ChatIdentityConfirm() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [confirmed, setConfirmed] = useState(false);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, retry: false });
  const local = health.data?.deploymentMode === "local_trusted";
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["chat-identity-link-preview", token],
    queryFn: () => chatEndpointsApi.previewIdentityLink(token),
    enabled: token.length >= 32 && (local || Boolean(session.data)),
    refetchInterval: confirmed ? false : 3_000,
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () => chatEndpointsApi.confirmIdentityLink(token),
    onSuccess: () => setConfirmed(true),
  });

  const requestAccess = useMutation({
    mutationFn: () => chatEndpointsApi.requestIdentityAccess(token),
  });
  if (health.isError || (!local && session.isError)) return <main className="mx-auto max-w-lg px-6 py-12 text-sm text-destructive">{l10n("local.couldn_apos_t_load_your_account_refresh_to_tr_334581ad")}</main>;
  if (health.isSuccess && !local && session.isSuccess && !session.data) {
    return <Navigate to={`/auth?next=${encodeURIComponent(`/chat-identity/confirm?token=${token}`)}`} replace />;
  }
  if (token.length < 32 || (!confirmed && preview.isError)) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-12">
        <h1 className="text-xl font-bold">{l10n("local.this_identity_link_is_unavailable_4f759618")}</h1>
        <p className="text-sm text-muted-foreground">
          {l10n("local.the_link_is_invalid_expired_already_used_or_b_1278a4a2")}</p>
      </main>
    );
  }
  if (health.isPending || preview.isLoading || (!local && session.isLoading) || !preview.data) {
    return (
      <main className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {l10n("local.checking_identity_link_b27af017")}</main>
    );
  }
  const identity = preview.data;
  const paperclipAccount = local ? "Local Board" :
    session.data?.user.name?.trim() ||
    session.data?.user.email?.trim() ||
    session.data?.user.id ||
    "the signed-in account";
  if (confirmed) {
    return (
      <main className="mx-auto max-w-lg space-y-5 px-6 py-12">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <h1 className="text-xl font-bold">{l10n("local.identity_linked_ce755132")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.future_messages_from_5e527e30")}{" "}{identity.externalLabel} {l10n("local.use_your_current_paperclip_permissions_in_a861a24a")}{" "}{identity.companyName}.
          </p>
        </div>
        {identity.provider === "slack" && <Button asChild><a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer">{l10n("local.return_to_slack_b460e2df")}</a></Button>}
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
      <div>
        <p className="text-sm text-muted-foreground">{identity.companyName}</p>
        <h1 className="mt-1 text-xl font-bold">{l10n("local.link_your_external_identity_61da1fc1")}</h1>
      </div>
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{l10n("local.provider_472590ae")}</dt>
          <dd className="text-sm font-medium">
            {providerNames[identity.provider]}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{l10n("local.external_identity_22da5353")}</dt>
          <dd className="text-right text-sm font-medium">
            {identity.externalLabel}
            {identity.externalDetail ? ` · ${identity.externalDetail}` : ""}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{l10n("local.paperclip_account_deb2783e")}</dt>
          <dd className="text-right text-sm font-medium">{paperclipAccount}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{l10n("local.agent_11b39c93")}</dt>
          <dd className="text-sm font-medium">
            {identity.botLabel ?? l10n("local.paperclip_agent_b2cc8a55")}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">
        {l10n("local.confirm_only_if_this_is_your_ca472eb0")}{" "}{providerNames[identity.provider]}{" "}
        {l10n("local.identity_paperclip_will_check_your_current_or_5ae51bfb")}</p>
      {confirm.isError && (
        <p className="text-sm text-destructive">
          {l10n("local.this_link_could_not_be_confirmed_it_may_have_bdb905e5")}</p>
      )}
      {identity.canConfirm === false ? (
        <div className="space-y-3">
          <p className="text-sm">{l10n("local.you_need_membership_in_48ab1594")}{" "}{identity.companyName} {l10n("local.before_linking_this_account_8fbf90f9")}</p>
          {requestAccess.isSuccess ? <p role="status" className="text-sm">{l10n("local.access_requested_an_admin_can_approve_it_in_p_817b7731")}</p>
            : <Button disabled={requestAccess.isPending || !identity.selfService} onClick={() => requestAccess.mutate()}>{l10n("local.request_access_b06f1662")}</Button>}
          {requestAccess.isError && <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_request_access_the_link_may_hav_472d81db")}</p>}
        </div>
      ) : <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {l10n("local.confirm_identity_094d10c2")}</Button>}
    </main>
  );
}
