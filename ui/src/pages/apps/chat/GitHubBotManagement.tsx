import { l10n } from "../../../i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { GitHubChatConfiguration } from "@paperclipai/shared";
import {
  githubChatApi,
  type GitHubConfigurationRecord,
} from "@/api/githubChat";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import {
  GitHubAccessEditor,
  GitHubPolicyEditor,
  GitHubToggle,
  githubSelectClass,
} from "./GitHubBotConfiguration";

export function GitHubBotManagement({
  endpoint,
  view,
}: {
  endpoint: ChatEndpoint;
  view: "settings" | "access";
}) {
  const query = useQuery({
    queryKey: ["github-bot-configuration", endpoint.id],
    queryFn: () => githubChatApi.configuration(endpoint.id),
  });
  const resources = useQuery({
    queryKey: ["github-bot-repositories", endpoint.id],
    queryFn: () => chatEndpointsApi.listResources(endpoint.id),
  });
  const [draft, setDraft] = useState<GitHubConfigurationRecord | null>(null);
  const [repository, setRepository] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const record = draft ?? query.data;
  const edit = (configuration: GitHubChatConfiguration) => {
    if (record) setDraft({ ...record, configuration });
    setNotice("");
  };
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setPending(false);
    }
  };
  if (query.isError || resources.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {l10n("local.could_not_load_the_bot_configuration_52018652")}{" "}
        <Button
          variant="link"
          onClick={() => {
            void query.refetch();
            void resources.refetch();
          }}
        >
          {l10n("local.try_again_d8b8392e")}</Button>
      </p>
    );
  if (!record)
    return (
      <p className="text-sm text-muted-foreground">{l10n("local.loading_configuration_bc8fd86d")}</p>
    );
  const config = record.configuration;
  const override = repository ? config.repositories[repository] : undefined;
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">
          {view === "access"
            ? l10n("local.who_can_start_work_a4285ffa")
            : l10n("local.agent_and_review_behavior_3a5d8a8c")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {endpoint.assignedAgentName} {l10n("local.is_permanently_assigned_to_this_bot_github_me_116958d0")}</p>
        <Link
          className="text-sm underline"
          to={`/apps/${endpoint.connectionId}`}
        >
          {l10n("local.bot_s_github_tool_connection_ef3e4ed5")}</Link>
      </div>
      {view === "access" ? (
        <GitHubAccessEditor
          endpointId={endpoint.id}
          companyId={endpoint.companyId}
          configuration={config}
          onChange={edit}
        />
      ) : (
        <>
          <GitHubToggle
            label={l10n("local.agent_can_use_this_bot_s_github_tools_48a207ab")}
            description={l10n("local.uses_the_same_github_app_limited_to_this_bot_64035f24")}
            checked={config.toolsEnabled}
            onChange={(toolsEnabled) => edit({ ...config, toolsEnabled })}
          />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{l10n("local.repository_access_3e3d7edf")}</h3>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      await githubChatApi.refreshRepositories(endpoint.id);
                      await resources.refetch();
                      setNotice(
                        l10n("local.repository_access_refreshed_new_repositories_1b9f7156"),
                      );
                    })
                  }
                >
                  <RefreshCw className="size-4" />
                  {l10n("local.refresh_0e916101")}</Button>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={
                      endpoint.setup?.github?.managementUrl ??
                      endpoint.setup?.github?.installationUrl ??
                      "https://github.com/settings/installations"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {l10n("local.configure_on_github_106d3442")}<ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {l10n("local.these_repositories_come_from_the_bot_app_s_in_2726cc48")}</p>
            {resources.data
              ?.filter((r) => r.type === "repository")
              .map((resource) => (
                <GitHubToggle
                  key={resource.id}
                  label={resource.label ?? resource.providerResourceId}
                  description={
                    resource.availability === "available"
                      ? undefined
                      : l10n("local.installation_access_is_unavailable_update_acc_bca11134")
                  }
                  checked={resource.enabled}
                  onChange={(enabled) =>
                    void act(async () => {
                      await chatEndpointsApi.updateResources(endpoint.id, [
                        { id: resource.id, enabled },
                      ]);
                      await resources.refetch();
                    })
                  }
                />
              ))}
          </div>
          <div className="space-y-2">
            <label
              htmlFor="github-policy-repository"
              className="text-sm font-medium"
            >
              {l10n("local.review_configuration_da791254")}</label>
            <select
              id="github-policy-repository"
              className={githubSelectClass}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              <option value="">{l10n("local.connection_defaults_ef6250a5")}</option>
              {resources.data
                ?.filter(
                  (r) =>
                    r.type === "repository" &&
                    r.enabled &&
                    r.metadata?.providerRepositoryId,
                )
                .map((r) => (
                  <option
                    key={r.id}
                    value={String(r.metadata?.providerRepositoryId)}
                  >
                    {r.label ?? r.providerResourceId}
                  </option>
                ))}
            </select>
          </div>
          {repository && (
            <GitHubToggle
              label={l10n("local.override_connection_defaults_fa09d2e2")}
              description={l10n("local.this_repository_can_have_its_own_prompts_filt_d31e5099")}
              checked={!!override}
              onChange={(enabled) => {
                const repositories = { ...config.repositories };
                if (enabled) repositories[repository] = { ...config.defaults };
                else delete repositories[repository];
                edit({ ...config, repositories });
              }}
            />
          )}
          {!repository || override ? (
            <GitHubPolicyEditor
              policy={{ ...config.defaults, ...override }}
              onChange={(policy) =>
                edit(
                  repository
                    ? {
                        ...config,
                        repositories: {
                          ...config.repositories,
                          [repository]: policy,
                        },
                      }
                    : { ...config, defaults: policy },
                )
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {l10n("local.this_repository_follows_the_connection_defaul_d0a794ab")}</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          variant="ghost"
          disabled={!draft || pending}
          onClick={() => {
            setDraft(null);
            setError("");
          }}
        >
          {l10n("local.discard_changes_f9bfa3dc")}</Button>
        <Button
          disabled={!draft || pending}
          onClick={() =>
            void act(async () => {
              const saved = await githubChatApi.save(
                endpoint.id,
                record.revision,
                config,
              );
              setDraft(saved);
              await query.refetch();
              setDraft(null);
              setNotice(l10n("local.configuration_saved_6b5b3c69"));
            })
          }
        >
          {pending ? l10n("local.saving_23e39291") : l10n("local.save_changes_dd0ae7a5")}
        </Button>
      </div>
    </section>
  );
}

export function GitHubReviews({ endpointId }: { endpointId: string }) {
  const query = useQuery({
    queryKey: ["github-bot-reviews", endpointId],
    queryFn: () => githubChatApi.reviews(endpointId),
    refetchInterval: 5000,
  });
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{l10n("local.reviews_84cb7871")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.review_activity_from_the_agent_s_paperclip_ta_1dc20451")}</p>
      </div>
      {query.isError && (
        <p role="alert" className="text-sm text-destructive">
          {l10n("local.reviews_could_not_be_loaded_58b6d154")}{" "}
          <Button variant="link" onClick={() => void query.refetch()}>
            {l10n("local.try_again_d8b8392e")}</Button>
        </p>
      )}
      {query.isLoading && (
        <p className="text-sm text-muted-foreground">{l10n("local.loading_reviews_510c765f")}</p>
      )}
      {query.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {l10n("local.no_reviews_yet_mention_the_bot_on_an_enabled_f6b5ca55")}</p>
      )}
      {query.data?.map((review) => (
        <article
          key={review.id}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a
              className="text-sm font-medium underline"
              href={`https://github.com/${review.repository}/pull/${review.pullNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              {review.repository} #{review.pullNumber}
            </a>
            <span className="text-sm">
              {review.assessment?.complete
                ? l10n("local.value_5_931c6465", {v0: (review.assessment.score)})
                : review.state.replaceAll("_", " ")}{" "}
              ·{" "}
              {review.conclusion?.replaceAll("_", " ") ?? l10n("local.awaiting_assessment_53000e1b")}
            </span>
          </div>
          <p className="text-sm">
            {review.assessment?.summary ?? review.event.title}
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <code>{review.headSha.slice(0, 12)}</code>
            <span>{formatDateTime(review.updatedAt)}</span>
            <Link className="underline" to={`/issues/${review.issueId}`}>
              {l10n("local.paperclip_task_ff44b378")}</Link>
            {review.runId && (
              <Link
                className="underline"
                to={`/issues/${review.issueId}?runId=${review.runId}`}
              >
                {l10n("local.run_00d60e31")}</Link>
            )}
            {review.summaryUrl && (
              <a
                className="underline"
                href={review.summaryUrl}
                target="_blank"
                rel="noreferrer"
              >
                {l10n("local.summary_8e76a94a")}</a>
            )}
            {review.checkUrl && (
              <a
                className="underline"
                href={review.checkUrl}
                target="_blank"
                rel="noreferrer"
              >
                {l10n("local.check_9d60841e")}</a>
            )}
          </div>
          {review.assessment && (
            <details className="text-sm">
              <summary className="cursor-pointer">
                {l10n("local.rationale_and_coverage_439aa4e2")}</summary>
              <p className="mt-2">{review.assessment.rationale}</p>
              <p className="mt-2 text-muted-foreground">
                {review.assessment.coverage.reviewedPaths.length} {l10n("local.files_reviewed_4db53103")}{" "}{review.assessment.coverage.omittedPaths.length} {l10n("local.omitted_f34912a1")}</p>
              {review.assessment.coverage.limitations.map((limit, index) => (
                <p key={index} className="mt-1 text-muted-foreground">
                  {limit}
                </p>
              ))}
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
