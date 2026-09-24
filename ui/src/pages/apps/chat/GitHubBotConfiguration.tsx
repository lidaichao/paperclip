import { l10n } from "../../../i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GITHUB_REVIEW_EVENTS,
  type GitHubChatConfiguration,
  type GitHubReviewPolicy,
  type GitHubAllowedPerson,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Link } from "@/lib/router";

export const githubSelectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const eventLabels = {
  opened: l10n("local.new_pull_request_263c7984"),
  synchronize: l10n("local.updated_commits_30b31318"),
  reopened: l10n("local.reopened_53a4ae1c"),
  ready_for_review: l10n("local.ready_for_review_75c2a5c8"),
  mention: l10n("local.mention_d820d8de"),
  comment: l10n("local.follow_up_comment_f33a51e2"),
};
export function GitHubToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
export function GitHubPolicyEditor({
  policy,
  onChange,
}: {
  policy: GitHubReviewPolicy;
  onChange: (policy: GitHubReviewPolicy) => void;
}) {
  const [prompt, setPrompt] =
    useState<(typeof GITHUB_REVIEW_EVENTS)[number]>("opened");
  const set = <K extends keyof GitHubReviewPolicy>(
    key: K,
    value: GitHubReviewPolicy[K],
  ) => onChange({ ...policy, [key]: value });
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="github-invocation">
          {l10n("local.when_should_this_agent_review_e10e8e09")}</Label>
        <select
          id="github-invocation"
          className={githubSelectClass}
          value={policy.invocation}
          onChange={(e) =>
            set(
              "invocation",
              e.target.value as GitHubReviewPolicy["invocation"],
            )
          }
        >
          <option value="linked_authors">
            {l10n("local.linked_members_prs_and_authorized_mentions_eb44de80")}</option>
          <option value="mentions_only">{l10n("local.authorized_mentions_only_3d0d0ce4")}</option>
          <option value="allowed_authors">
            {l10n("local.allowed_authors_prs_and_authorized_mentions_97449943")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {l10n("local.newly_added_people_have_a_separate_automatic_f329c97f")}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium">{l10n("local.automatic_review_events_7edf33ae")}</h3>
        {GITHUB_REVIEW_EVENTS.slice(0, 4).map((event) => (
          <GitHubToggle
            key={event}
            label={eventLabels[event]}
            checked={policy.events.includes(event)}
            onChange={(enabled) =>
              set(
                "events",
                enabled
                  ? [...new Set([...policy.events, event])]
                  : policy.events.filter((value) => value !== event),
              )
            }
          />
        ))}
        <GitHubToggle
          label={l10n("local.include_draft_prs_433fa0da")}
          checked={policy.reviewDrafts}
          onChange={(value) => set("reviewDrafts", value)}
        />
        <GitHubToggle
          label={l10n("local.include_bot_authors_1d326547")}
          description={l10n("local.also_allow_the_bot_account_in_access_with_a_s_7231d929")}
          checked={policy.reviewBotAuthors}
          onChange={(value) => set("reviewBotAuthors", value)}
        />
      </div>
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {l10n("local.author_branch_label_and_file_filters_a7d25ebd")}</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(
            [
              [
                "includeAuthors",
                "Included authors",
                "Leave empty to include any authorized author. One username or glob per line.",
              ],
              [
                "excludeAuthors",
                "Excluded authors",
                "One username or glob per line.",
              ],
              [
                "targetBranches",
                "Target branches",
                "Leave empty for all branches. Supports * and **.",
              ],
              [
                "excludedBranches",
                "Excluded target branches",
                "Never automatically review these branches. Supports * and **.",
              ],
              [
                "requiredLabels",
                "Required labels",
                "All listed labels must be present.",
              ],
              [
                "excludedLabels",
                "Excluded labels",
                "Any listed label prevents automatic review.",
              ],
              [
                "ignoredPaths",
                "Ignored file paths",
                "Excluded from manual and automatic analysis. Supports * and **.",
              ],
            ] as const
          ).map(([key, label, help]) => (
            <div className="space-y-2" key={key}>
              <Label htmlFor={`github-${key}`}>{label}</Label>
              <Textarea
                id={`github-${key}`}
                value={policy[key].join("\n")}
                onChange={(e) =>
                  set(key, e.target.value.split("\n").filter(Boolean))
                }
              />
              <p className="text-xs text-muted-foreground">{help}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {l10n("local.authorized_manual_requests_bypass_automatic_s_84230b68")}</p>
      </details>
      <div className="space-y-2">
        <Label htmlFor="github-instructions">{l10n("local.review_instructions_e61fbd96")}</Label>
        <Textarea
          id="github-instructions"
          value={policy.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {l10n("local.additional_guidance_for_the_assigned_agent_pr_b4e33a0e")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-prompt-event">{l10n("local.event_prompts_d3e623f3")}</Label>
        <select
          id="github-prompt-event"
          className={githubSelectClass}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value as typeof prompt)}
        >
          {GITHUB_REVIEW_EVENTS.map((event) => (
            <option key={event} value={event}>
              {eventLabels[event]}
            </option>
          ))}
        </select>
        <Textarea
          aria-label={l10n("local.value_prompt_a25ddbc4", {v0: (eventLabels[prompt])})}
          value={policy.prompts[prompt]}
          onChange={(e) =>
            set("prompts", { ...policy.prompts, [prompt]: e.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">
          {l10n("local.paperclip_supplies_repository_pr_base_and_hea_2688728d")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="github-categories">{l10n("local.finding_categories_6f31e9d6")}</Label>
          <Input
            id="github-categories"
            value={policy.findingCategories.join(", ")}
            onChange={(e) =>
              set(
                "findingCategories",
                e.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
          <p className="text-xs text-muted-foreground">
            {l10n("local.comma_separated_assessment_categories_ca9a3f17")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="github-severity">
            {l10n("local.minimum_inline_comment_severity_d20fbcf4")}</Label>
          <select
            id="github-severity"
            className={githubSelectClass}
            value={policy.minimumCommentSeverity}
            onChange={(e) =>
              set(
                "minimumCommentSeverity",
                e.target.value as GitHubReviewPolicy["minimumCommentSeverity"],
              )
            }
          >
            <option value="info">{l10n("local.info_170322a3")}</option>
            <option value="warning">{l10n("local.warning_e981ddae")}</option>
            <option value="error">{l10n("local.error_54a0e8c1")}</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {l10n("local.hidden_comments_still_count_in_the_assessment_42ac3ca4")}</p>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">{l10n("local.publication_permissions_24669fa3")}</h3>
        <GitHubToggle
          label={l10n("local.publish_summary_e1d31b27")}
          checked={policy.publishSummary}
          onChange={(value) => set("publishSummary", value)}
        />
        <GitHubToggle
          label={l10n("local.publish_inline_findings_d2558312")}
          checked={policy.publishInline}
          onChange={(value) => set("publishInline", value)}
        />
        <GitHubToggle
          label={l10n("local.allow_formal_approvals_22261e40")}
          description={l10n("local.a_separate_agent_action_a_5_5_score_never_aut_329a945b")}
          checked={policy.allowApprove}
          onChange={(value) => set("allowApprove", value)}
        />
        <GitHubToggle
          label={l10n("local.allow_formal_request_changes_d5b9658c")}
          checked={policy.allowRequestChanges}
          onChange={(value) => set("allowRequestChanges", value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-rating">{l10n("local.paperclip_review_check_5cfccfdc")}</Label>
        <select
          id="github-rating"
          className={githubSelectClass}
          value={policy.ratingThreshold ?? "report"}
          onChange={(e) =>
            set(
              "ratingThreshold",
              e.target.value === "report"
                ? null
                : (Number(e.target.value) as 1 | 2 | 3 | 4 | 5),
            )
          }
        >
          {[5, 4, 3, 2, 1].map((score) => (
            <option key={score} value={score}>
              {l10n("local.require_at_least_d5cad176")}{" "}{score}/5
            </option>
          ))}
          <option value="report">{l10n("local.report_only_5d497412")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {l10n("local.paperclip_computes_the_result_for_the_exact_r_4f0df9fa")}</p>
        <a
          className="text-xs underline"
          href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository"
          target="_blank"
          rel="noreferrer"
        >
          {l10n("local.set_up_a_required_check_on_github_91663fc2")}</a>
      </div>
    </div>
  );
}

export function GitHubAccessEditor({
  endpointId,
  companyId,
  configuration,
  onChange,
}: {
  endpointId: string;
  companyId: string;
  configuration: GitHubChatConfiguration;
  onChange: (configuration: GitHubChatConfiguration) => void;
}) {
  const accountLink = useRef<HTMLAnchorElement>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const members = useQuery({
    queryKey: ["github-members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
  });
  const links = useQuery({
    queryKey: ["github-linked-members", endpointId],
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const [kind, setKind] = useState<"member" | "guest" | null>(null);
  const [login, setLogin] = useState("");
  const [sponsor, setSponsor] = useState(configuration.responsibleUserId);
  const [candidate, setCandidate] = useState<{
    githubUserId: string;
    login: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const add = (person: GitHubAllowedPerson) => {
    if (
      configuration.people.some((p) => p.githubUserId === person.githubUserId)
    )
      return;
    onChange({
      ...configuration,
      ...(person.kind === "member" ? { memberAccess: "selected" } : {}),
      people: [...configuration.people, person],
    });
    setKind(null);
    setCandidate(null);
    setLogin("");
  };
  const activeMembers = (members.data?.members ?? []).filter(
    (member) =>
      member.status === "active" && member.membershipRole !== "viewer",
  );
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="github-responsible">
          {l10n("local.responsible_user_for_automatic_events_8c627ece")}</Label>
        <select
          id="github-responsible"
          className={githubSelectClass}
          value={configuration.responsibleUserId}
          onChange={(e) =>
            onChange({ ...configuration, responsibleUserId: e.target.value })
          }
        >
          {activeMembers.map((member) => (
            <option key={member.principalId} value={member.principalId}>
              {member.user?.name ?? member.user?.email ?? member.principalId}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {l10n("local.accountable_for_automatic_tasks_the_pr_author_e06deb8c")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-member-access">{l10n("local.company_member_access_2a721252")}</Label>
        <select
          id="github-member-access"
          className={githubSelectClass}
          value={configuration.memberAccess}
          onChange={(e) =>
            onChange({
              ...configuration,
              memberAccess: e.target.value as "all_linked" | "selected",
            })
          }
        >
          <option value="all_linked">{l10n("local.all_linked_company_members_c4f6d738")}</option>
          <option value="selected">{l10n("local.only_selected_linked_members_c749e6e7")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {l10n("local.members_connect_their_own_github_account_95eaa9c7")}{" "}
          <Link
            className="underline"
            ref={accountLink}
            to={`/apps/chat/connect?provider=github&resume=${endpointId}&stage=identity`}
          >
            {l10n("local.open_account_linking_9218eed4")}</Link>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              if (accountLink.current)
                void copyTextToClipboard(accountLink.current.href).then(
                  () => setLinkCopied(true),
                  () =>
                    setError(
                      l10n("local.could_not_copy_the_link_open_account_linking_e3f2cbe8"),
                    ),
                );
            }}
          >
            {linkCopied ? l10n("local.link_copied_d12860c2") : l10n("local.copy_link_for_teammates_272c0287")}
          </Button>
          .
        </p>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">{l10n("local.linked_github_accounts_5d7ade44")}</h3>
        {links.isError && (
          <p role="alert" className="text-sm text-destructive">
            {l10n("local.could_not_load_linked_accounts_c1b59db6")}</p>
        )}
        {(links.data ?? [])
          .filter((link) => link.status === "linked")
          .map((link) => (
            <div
              key={link.principalId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <p className="text-sm">
                @{link.githubLogin ?? link.externalLabel}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await chatEndpointsApi.revokeLink(
                      endpointId,
                      link.principalId,
                    );
                    await links.refetch();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "Could not unlink this account.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {l10n("local.unlink_account_f3f145c6")}</Button>
            </div>
          ))}
        {!links.isPending &&
          !links.isError &&
          !(links.data ?? []).some((link) => link.status === "linked") && (
            <p className="text-sm text-muted-foreground">
              {l10n("local.no_accounts_linked_yet_each_teammate_confirms_c50b6cec")}</p>
          )}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {configuration.people.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {l10n("local.no_individual_access_entries_unlinked_people_19fe80bc")}</p>
        )}
        {configuration.people.map((person) => (
          <div key={person.githubUserId} className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">@{person.login}</p>
                <p className="text-xs text-muted-foreground">
                  {person.kind === "member"
                    ? l10n("local.linked_company_member_a8583eb5")
                    : l10n("local.external_contributor_restricted_guest_permiss_3de380bb")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ...configuration,
                    people: configuration.people.filter(
                      (p) => p.githubUserId !== person.githubUserId,
                    ),
                  })
                }
              >
                {l10n("local.remove_c3812fc4")}</Button>
            </div>
            <GitHubToggle
              label={l10n("local.automatic_pr_reviews_for_value_406d7fb5", {v0: (person.login)})}
              checked={person.automaticReviews}
              onChange={(value) =>
                onChange({
                  ...configuration,
                  people: configuration.people.map((p) =>
                    p.githubUserId === person.githubUserId
                      ? { ...p, automaticReviews: value }
                      : p,
                  ),
                })
              }
            />
            {person.kind === "guest" && (
              <p className="text-xs text-muted-foreground">
                {l10n("local.sponsor_79d0c211")}{" "}
                {activeMembers.find(
                  (member) => member.principalId === person.sponsorUserId,
                )?.user?.name ?? person.sponsorUserId}
                {l10n("local._no_company_membership_or_personal_credential_8c0bbf8e")}</p>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setKind("member")}>
          {l10n("local.add_linked_member_0c1b3674")}</Button>
        <Button variant="outline" onClick={() => setKind("guest")}>
          {l10n("local.allow_external_contributor_fea8e4f5")}</Button>
      </div>
      {kind === "member" && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm">
            {l10n("local.adding_a_member_switches_access_to_the_select_e96fb181")}</p>
          {(links.data ?? [])
            .filter((link) => link.status === "linked" && link.paperclipUserId)
            .map((link) => (
              <Button
                className="mr-2"
                key={link.id}
                variant="outline"
                disabled={configuration.people.some(
                  (p) =>
                    p.kind === "member" && p.userId === link.paperclipUserId,
                )}
                onClick={() => {
                  const id = link.githubUserId;
                  if (!id) {
                    setError(
                      l10n("local.refresh_linked_identities_before_adding_this_90c0958b"),
                    );
                    return;
                  }
                  add({
                    kind: "member",
                    userId: link.paperclipUserId!,
                    githubUserId: id,
                    login: link.githubLogin ?? link.externalLabel,
                    automaticReviews: false,
                  });
                }}
              >
                {link.paperclipUserLabel ?? link.externalLabel}
              </Button>
            ))}
          <Button variant="ghost" onClick={() => setKind(null)}>
            {l10n("local.cancel_19766ed6")}</Button>
        </div>
      )}
      {kind === "guest" && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <p className="text-sm">
            {l10n("local.allow_one_github_account_to_mention_the_bot_w_66d4493e")}</p>
          <div className="space-y-2">
            <Label htmlFor="github-guest-login">{l10n("local.github_username_64477e38")}</Label>
            <div className="flex gap-2">
              <Input
                id="github-guest-login"
                value={login}
                onChange={(e) => {
                  setLogin(e.target.value);
                  setCandidate(null);
                }}
              />
              <Button
                variant="outline"
                disabled={busy || !login}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setCandidate(await githubChatApi.lookup(endpointId, login));
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : "Lookup failed",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {l10n("local.look_up_504101bc")}</Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="github-guest-sponsor">{l10n("local.sponsor_fd6e874f")}</Label>
            <select
              id="github-guest-sponsor"
              className={githubSelectClass}
              value={sponsor}
              onChange={(e) => setSponsor(e.target.value)}
            >
              {activeMembers.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {member.user?.name ?? member.principalId}
                </option>
              ))}
            </select>
          </div>
          {candidate && (
            <p className="text-sm">
              @{candidate.login} {l10n("local._github_id_d614c4e4")}{" "}{candidate.githubUserId}
            </p>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setKind(null)}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              disabled={
                !candidate ||
                !sponsor ||
                configuration.people.some(
                  (p) => p.githubUserId === candidate.githubUserId,
                )
              }
              onClick={() =>
                candidate &&
                add({
                  ...candidate,
                  kind: "guest",
                  sponsorUserId: sponsor,
                  permissionProfile: "restricted",
                  automaticReviews: false,
                })
              }
            >
              {l10n("local.allow_this_account_0c44f8da")}</Button>
          </div>
        </div>
      )}
      {(error || members.error || links.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ||
            l10n("local.could_not_load_members_or_linked_accounts_ref_ed5ce86d")}
        </p>
      )}
    </div>
  );
}
