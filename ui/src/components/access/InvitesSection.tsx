import { l10n } from "../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: l10n("local.viewer_678bfa6a"),
    description: l10n("local.can_view_organization_work_and_follow_along_c0074ebb"),
    gets: l10n("local.view_only_organization_membership_f5ae52ac"),
  },
  {
    value: "operator",
    label: l10n("local.operator_291101a0"),
    description: l10n("local.recommended_for_people_who_need_to_help_run_w_2090f335"),
    gets: l10n("local.can_assign_tasks_656878c3"),
  },
  {
    value: "admin",
    label: l10n("local.admin_c1c224b0"),
    description: l10n("local.recommended_for_operators_who_need_to_invite_508b27fb"),
    gets: l10n("local.can_create_agents_invite_users_assign_tasks_a_21f5dfbb"),
  },
  {
    value: "owner",
    label: l10n("local.owner_4b1b8aa3"),
    description: l10n("local.full_organization_access_including_membership_050eacd9"),
    gets: l10n("local.everything_in_admin_plus_managing_members_0064ba82"),
  },
] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      afterFallback?.();
    }
    pushToast({
      title: l10n("local.clipboard_unavailable_4ff69f6f"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, "The invite URL is selected. Copy it manually from the field.", selectLatestInviteUrl);
  }

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        agentMessage: null,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      const copied = await copyText(invite.inviteUrl, "Copy the invite URL manually from the field below.");

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: l10n("local.invite_created_eb00b164"),
        body: copied ? l10n("local.invite_ready_below_and_copied_to_clipboard_2956aad1") : l10n("local.invite_ready_below_c7f94a60"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.failed_to_create_invite_23a0de73"),
        body: error instanceof Error ? error.message : l10n("local.unknown_error_27c2ccd9"),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: l10n("local.invite_revoked_d8fb3309"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.failed_to_revoke_invite_ac674f0b"),
        body: error instanceof Error ? error.message : l10n("local.unknown_error_27c2ccd9"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{l10n("local.select_an_organization_to_manage_invites_462e1828")}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{l10n("local.loading_invites_5c525c4d")}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? l10n("local.you_do_not_have_permission_to_manage_organiza_e61b9719")
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : l10n("local.failed_to_load_invites_d62fcfaa");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {l10n("local.invite_people_to_request_access_to_this_organ_b8b2979c")}</p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{l10n("local.invite_a_person_f76f965e")}</h2>
          <p className="text-sm text-muted-foreground">
            {l10n("local.generate_a_human_invite_link_and_choose_the_d_dd31c56f")}</p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{l10n("local.choose_a_role_a49c49b0")}</legend>
          <div className="rounded-xl border border-border">
            {inviteRoleOptions.map((option, index) => {
              const checked = humanRole === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={option.value}
                    checked={checked}
                    onChange={() => setHumanRole(option.value)}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {l10n("local.default_21b111cb")}</Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {l10n("local.each_invite_link_is_single_use_human_invitees_87964037")}</div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? l10n("local.creating_c79ed949") : l10n("local.create_invite_9f395b8f")}
          </Button>
          <span className="text-sm text-muted-foreground">{l10n("local.invite_history_below_keeps_the_audit_trail_03076923")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{l10n("local.latest_invite_link_ee47fab1")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {l10n("local.copied_8d525e5f")}</div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {l10n("local.this_url_includes_the_current_paperclip_domai_3bad0330")}</div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{l10n("local.latest_invite_url_35fbc9bc")}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={l10n("local.latest_invite_url_35fbc9bc")}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                {l10n("local.copy_link_dbf362d4")}</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{l10n("local.invite_history_0269fea6")}</h2>
            <p className="text-sm text-muted-foreground">
              {l10n("local.review_invite_status_audience_inviter_and_any_bc3cae1e")}</p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {l10n("local.open_join_request_queue_3f3aa696")}</Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {l10n("local.no_invites_have_been_created_for_this_organiz_c20447f4")}</div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.state_a3b50c47")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.for_ca15ebc0")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.invited_by_c7a6f156")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.created_d70b9e24")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.join_request_d7d9cd19")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{l10n("local.action_64cff131")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || l10n("local.unknown_inviter_7cf15ed2")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {l10n("local.review_request_dcea8abb")}</Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            {l10n("local.revoke_87e6d00b")}</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{l10n("local.inactive_ac7c949f")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? l10n("local.loading_more_964e5f88") : l10n("local.view_more_267e5558")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  if (invite.allowedJoinTypes === "agent") return "Agent";
  if (invite.allowedJoinTypes === "both") return invite.humanRole ? `Human or agent · ${invite.humanRole}` : "Human or agent";
  return invite.humanRole ?? "Human";
}
