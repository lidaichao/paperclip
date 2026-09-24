import { l10n } from "../i18n";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

export function CliAuthPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const challengeId = (params.id ?? "").trim();
  const token = (searchParams.get("token") ?? "").trim();
  const currentPath = useMemo(
    () => `/cli-auth/${encodeURIComponent(challengeId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    [challengeId, token],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const challengeQuery = useQuery({
    queryKey: ["cli-auth-challenge", challengeId, token],
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    enabled: challengeId.length > 0 && token.length > 0,
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await challengeQuery.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await challengeQuery.refetch();
    },
  });

  if (!challengeId || !token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{l10n("local.invalid_cli_auth_url_528646e3")}</div>;
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{l10n("local.loading_cli_auth_challenge_c2b409b8")}</div>;
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{l10n("local.cli_auth_challenge_unavailable_0c42ba6c")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : l10n("local.challenge_is_invalid_or_expired_ef7f2fbf")}
          </p>
        </Card>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{l10n("local.cli_auth_challenge_unavailable_14e6eaba")}</div>;
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{l10n("local.cli_access_approved_e272a242")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {l10n("local.the_paperclip_cli_can_now_finish_authenticati_c62ea5b2")}</p>
          <p className="mt-4 text-sm text-muted-foreground">
            {l10n("local.command_a7a9c915")}{" "}<span className="font-mono text-foreground">{challenge.command}</span>
          </p>
        </Card>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">
            {challenge.status === "expired" ? l10n("local.cli_auth_challenge_expired_73f61eb5") : l10n("local.cli_auth_challenge_cancelled_a2f522c6")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {l10n("local.start_the_cli_auth_flow_again_from_your_termi_c79509c4")}</p>
        </Card>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{l10n("local.sign_in_required_255346f2")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {l10n("local.sign_in_or_create_an_account_then_return_to_t_da2e72ba")}</p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{l10n("local.sign_in_create_account_5d4f5eb1")}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">{l10n("local.approve_paperclip_cli_access_4b83de72")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {l10n("local.a_local_paperclip_cli_process_is_requesting_b_dc7992bf")}</p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{l10n("local.command_71316697")}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{l10n("local.client_0c77fe09")}</div>
            <div className="text-foreground">{challenge.clientName ?? l10n("local.paperclipai_cli_145af51e")}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{l10n("local.requested_access_82303475")}</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required" ? l10n("local.instance_admin_03507f86") : l10n("local.board_4816cbfd")}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">{l10n("local.requested_organization_fd802f75")}</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : l10n("local.failed_to_update_cli_auth_challenge_77e4aece")}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {l10n("local.this_challenge_requires_instance_admin_access_c18f2ad8")}</p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending ? l10n("local.approving_cee0e61b") : l10n("local.approve_cli_access_e4749018")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? l10n("local.cancelling_7b261310") : l10n("local.cancel_19766ed6")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
