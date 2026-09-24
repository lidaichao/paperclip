import { l10n } from "../../../i18n";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointResource,
} from "@/api/chatEndpoints";
import {
  githubChatApi,
  type GitHubConfigurationRecord,
  type GitHubIdentity,
  type GitHubVerification,
} from "@/api/githubChat";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { GitHubSetupPrompt } from "./GitHubSetupPrompt";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/context/ToastContext";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  GitHubAccessEditor,
  GitHubPolicyEditor,
  GitHubToggle,
  githubSelectClass,
} from "./GitHubBotConfiguration";

const steps = [
  "Choose agent",
  "Connect GitHub App",
  "Install GitHub App",
  "Select repositories",
  "Verify connection & tools",
  "Connect your account",
  "Configure behavior",
  "Try it",
];
const stages: NonNullable<ChatEndpointSetupState["github"]>["stage"][] = [
  "connect",
  "connect",
  "install",
  "repositories",
  "verify",
  "identity",
  "behavior",
  "test",
];
export function GitHubChatSetup() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [secretCopy, setSecretCopy] = useState<"idle" | "copied" | "failed">("idle");
  const identityOnly = params.get("stage") === "identity";
  const reconnecting = params.get("reconnect") === "1";
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [agentId, setAgentId] = useState(params.get("agentId") ?? "");
  const [step, setStep] = useState(0);
  const [availableStep, setAvailableStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("Paperclip Review");
  const [existing, setExisting] = useState(reconnecting);
  const [credentials, setCredentials] = useState({
    appId: "",
    privateKey: "",
    webhookSecret: "",
  });
  const [registration, setRegistration] = useState<Awaited<
    ReturnType<typeof githubChatApi.registration>
  > | null>(null);
  const [resources, setResources] = useState<ChatEndpointResource[]>([]);
  const [record, setRecord] = useState<GitHubConfigurationRecord | null>(null);
  const [verification, setVerification] = useState<GitHubVerification | null>(
    null,
  );
  const [personalConnectionId, setPersonalConnectionId] = useState("");
  const [identity, setIdentity] = useState<GitHubIdentity | null>(null);
  const [copied, setCopied] = useState(false);
  const resume = params.get("resume");
  const agents = useQuery({
    queryKey: ["github-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !identityOnly,
  });
  const current = useQuery({
    queryKey: ["github-setup", resume],
    queryFn: () => chatEndpointsApi.get(resume!),
    enabled: !!resume,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
  const accounts = useQuery({
    queryKey: ["github-personal-connections", endpoint?.id],
    queryFn: () => githubChatApi.personalConnections(endpoint!.id),
    enabled: !!endpoint && step === 5,
  });
  const test = useQuery({
    queryKey: ["github-test-status", endpoint?.id],
    queryFn: () => chatEndpointsApi.setupTestStatus(endpoint!.id),
    enabled: !!endpoint && step === 7,
    refetchInterval: 3000,
  });
  const selectedAgent = agents.data?.find((agent) => agent.id === agentId);
  useEffect(() => {
    setBreadcrumbs([
      { label: l10n("local.connectors_c3d2e79e"), href: "/apps" },
      { label: l10n("local.connect_github_bot_bb04a725") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    if (!current.data) return;
    setEndpoint(current.data);
    setAgentId(current.data.assignedAgentId);
    if (availableStep === 0) {
      const next = identityOnly
        ? 5
        : reconnecting
          ? 1
          : current.data.setup?.github?.stage
            ? Math.max(1, stages.indexOf(current.data.setup.github.stage))
            : current.data.status === "active"
              ? 6
              : 1;
      setStep(next);
      setAvailableStep(next);
      if (identityOnly) return;
      void Promise.all([
        chatEndpointsApi.listResources(current.data.id),
        githubChatApi.configuration(current.data.id),
      ])
        .then(([resources, config]) => {
          setResources(resources);
          setRecord(config);
        })
        .catch((error) =>
          setError(
            error instanceof Error ? error.message : "Could not resume setup",
          ),
        );
    }
  }, [current.data, availableStep, params]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save this step. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function go(next: number, bot = endpoint) {
    if (bot && next > 0)
      setEndpoint(await githubChatApi.progress(bot.id, stages[next]!));
    setStep(next);
    setAvailableStep((value) => Math.max(value, next));
  }
  async function saveConfiguration() {
    if (!endpoint || !record) return;
    const saved = await githubChatApi.save(
      endpoint.id,
      record.revision,
      record.configuration,
    );
    setRecord(saved);
  }
  const exit = () =>
    void run(async () => {
      if (step === 6) await saveConfiguration();
      if (endpoint && step > 0 && !identityOnly)
        await githubChatApi.progress(endpoint.id, stages[step]!);
      navigate("/apps");
    });
  const footer = (
    label: string,
    action: () => Promise<void>,
    disabled = false,
    extra?: React.ReactNode,
  ) => (
    <SetupWizardFooter onSaveExit={exit}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {step > 0 && !identityOnly && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setStep(step - 1)}
          >
            {l10n("local.back_76900f1b")}</Button>
        )}
        {extra}
        <Button disabled={busy || disabled} onClick={() => void run(action)}>
          {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
          {label}
        </Button>
      </div>
    </SetupWizardFooter>
  );
  const publicHttps = !!endpoint?.setup?.webhookUrl?.startsWith("https://");
  const mention = `@${endpoint?.botUsername?.replace(/\[bot\]$/, "") ?? "your-bot"} review this pull request`;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <SetupWizardNavigation
        labels={identityOnly ? ["Connect your account"] : steps}
        step={identityOnly ? 0 : step}
        availableStep={identityOnly ? 0 : availableStep}
        onSelect={identityOnly ? () => {} : setStep}
        disabled={busy}
        takeover
      />
      <div>
        <p className="text-xs text-muted-foreground">
          {identityOnly
            ? l10n("local.github_account_linking_0b212370")
            : l10n("local.github_bot_step_value_of_value_d94fa5c5", {v0: (step + 1), v1: (steps.length)})}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{steps[step]}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {l10n("local.github_conversations_run_as_paperclip_tasks_o_337de2fd")}</p>
      </div>
      {(error || current.error || agents.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
        >
          {error || l10n("local.could_not_load_this_setup_refresh_to_try_agai_99dc51ba")}
        </p>
      )}
      {step === 0 && (
        <>
          <GitHubSetupPrompt />
          <p className="text-sm">
            {l10n("local.this_assignment_is_permanent_the_agent_works_2810c390")}</p>
          {endpoint ? (
            <Input
              aria-label={l10n("local.assigned_agent_f96135ac")}
              value={
                endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId
              }
              readOnly
            />
          ) : (
            <AgentSelect
              agents={(agents.data ?? []).filter(
                (agent) => !["terminated", "archived"].includes(agent.status),
              )}
              value={agentId}
              onChange={setAgentId}
              placeholder={l10n("local.choose_an_agent_b6890bc2")}
              emptyMessage={l10n("local.no_agents_available_da910835")}
            />
          )}
          <GitHubAgentTrustWarning agent={selectedAgent} />
          {footer(
            "Continue",
            async () => {
              const bot =
                endpoint ??
                (await chatEndpointsApi.create(selectedCompanyId!, {
                  provider: "github",
                  assignedAgentId: agentId,
                }));
              setEndpoint(bot);
              setParams(
                { provider: "github", resume: bot.id },
                { replace: true },
              );
              setRecord(await githubChatApi.configuration(bot.id));
              await go(1, bot);
            },
            !agentId || !selectedCompanyId,
          )}
        </>
      )}
      {step === 1 && endpoint && (
        <>
          {!publicHttps && (
            <div
              role="alert"
              className="rounded-lg border border-(--status-task-todo)/30 bg-(--status-task-todo)/10 p-4 text-sm"
            >
              {l10n("local.a_publicly_reachable_https_address_is_require_7aacdb21")}{" "}{" "}
              <a className="underline" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noreferrer">{l10n("local.learn_how_to_set_up_https_d73f790b")}</a>
            </div>
          )}
          <p className="text-sm">
            {l10n("local.create_a_dedicated_github_app_for_3f4496e9")}{" "}
            {selectedAgent?.name ?? endpoint.assignedAgentName}{l10n("local._paperclip_stores_the_credentials_in_its_vaul_92f80fda")}</p>
          {reconnecting && (
            <p className="text-sm text-muted-foreground">
              {l10n("local.verify_the_saved_app_and_refresh_its_webhook_32758e44")}</p>
          )}
          <div className="flex gap-2">
            <Button
              variant={!existing ? "default" : "outline"}
              onClick={() => setExisting(false)}
            >
              {l10n("local.create_an_app_ee0d7952")}</Button>
            <Button
              variant={existing ? "default" : "outline"}
              onClick={() => setExisting(true)}
            >
              {l10n("local.use_an_existing_app_49f3af52")}</Button>
          </div>
          {existing ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="github-app-id">{l10n("local.app_id_3c2f1e20")}</Label>
                <Input
                  id="github-app-id"
                  value={credentials.appId}
                  onChange={(e) =>
                    setCredentials({ ...credentials, appId: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {l10n("local.find_this_in_your_github_app_s_settings_20685192")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-private-key">{l10n("local.private_key_477bf990")}</Label>
                <Textarea
                  id="github-private-key"
                  autoComplete="off"
                  value={credentials.privateKey}
                  onChange={(e) =>
                    setCredentials({
                      ...credentials,
                      privateKey: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {l10n("local.paste_the_pem_key_it_is_vaulted_server_side_618c80b1")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-webhook-secret">{l10n("local.webhook_secret_342da972")}</Label>
                <Input
                  id="github-webhook-secret"
                  type="password"
                  autoComplete="off"
                  value={credentials.webhookSecret}
                  onChange={(e) =>
                    setCredentials({
                      ...credentials,
                      webhookSecret: e.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {l10n("local.use_the_same_secret_in_github_s_webhook_setti_92781553")}</p>
                {!reconnecting && <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
                    const generated = await chatEndpointsApi.generateSetupSecret(endpoint.id);
                    setCredentials(current => ({ ...current, webhookSecret: generated.webhookSecret }));
                    setSecretCopy("idle");
                  })}>{l10n("local.generate_webhook_secret_cfbc14de")}</Button>
                  {credentials.webhookSecret && <Button variant="outline" onClick={async () => {
                    try { await copyTextToClipboard(credentials.webhookSecret); setSecretCopy("copied"); }
                    catch { setSecretCopy("failed"); pushToast({ title: l10n("local.couldn_t_copy_to_clipboard_72ff542b"), body: l10n("local.select_and_copy_the_value_manually_d630d482"), tone: "error" }); }
                  }}>{secretCopy === "copied" ? l10n("local.webhook_secret_copied_444c369d") : secretCopy === "failed" ? l10n("local.couldn_t_copy_select_it_manually_368f602d") : l10n("local.copy_webhook_secret_a6635b8c")}</Button>}
                </div>}

              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Label htmlFor="github-app-name">{l10n("local.github_app_name_0647b10c")}</Label>
              <Input
                id="github-app-name"
                maxLength={34}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setRegistration(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {l10n("local.github_requires_a_unique_name_continue_on_git_b57b0a8f")}</p>
              {registration && (
                <form
                  action={registration.registrationUrl}
                  method="POST"
                >
                  <input
                    type="hidden"
                    name="manifest"
                    value={JSON.stringify(registration.manifest)}
                  />
                  <Button type="submit">
                    {l10n("local.create_app_on_github_1536e05c")}<ExternalLink className="ml-2 size-4" />
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {l10n("local.registration_expires_at_6afb9390")}{" "}
                    {new Date(registration.expiresAt).toLocaleTimeString()}.
                  </p>
                </form>
              )}
            </div>
          )}
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm">
              {l10n("local.app_permissions_and_callback_details_a84eb7a1")}</summary>
            <p className="mt-3 text-sm">
              {l10n("local.contents_read_issues_pull_requests_checks_wri_b3424f9f")}</p>
            <p className="mt-2 break-all text-xs">
              {endpoint.setup?.webhookUrl ?? l10n("local.public_webhook_url_unavailable_58d73158")}
            </p>
            {endpoint.setup?.webhookUrl && <Button variant="outline" size="sm" className="mt-2" onClick={() => void run(async () => { await copyTextToClipboard(endpoint.setup!.webhookUrl!); pushToast({ title: l10n("local.webhook_url_copied_10a93657"), tone: "success" }); })}>{l10n("local.copy_webhook_url_69179edf")}</Button>}
            {registration && (
              <pre className="mt-3 overflow-auto text-xs">
                {JSON.stringify(registration.manifest, null, 2)}
              </pre>
            )}
          </details>
          {footer(
            reconnecting
              ? "Reconnect App"
              : endpoint.setup?.github?.appSlug
                ? "Continue to installation"
                : existing
                  ? "Connect App"
                  : "Prepare registration",
            async () => {
              if (reconnecting) {
                const saved = await chatEndpointsApi.setup(endpoint.id, {
                  action: "reconnect",
                  ...(credentials.privateKey
                    ? {
                        credentials: {
                          appId: credentials.appId || endpoint.botExternalId!,
                          privateKey: credentials.privateKey,
                        },
                      }
                    : {}),
                });
                setEndpoint(saved);
                setCredentials({
                  appId: "",
                  privateKey: "",
                  webhookSecret: "",
                });
                await go(4, saved);
              } else if (endpoint.setup?.github?.appSlug) await go(2);
              else if (existing) {
                const saved = await githubChatApi.connectApp(
                  endpoint.id,
                  credentials,
                );
                setEndpoint(saved);
                setCredentials({
                  appId: "",
                  privateKey: "",
                  webhookSecret: "",
                });
                await go(2, saved);
              } else
                setRegistration(
                  await githubChatApi.registration(endpoint.id, name),
                );
            },
            !publicHttps ||
              (existing &&
                !reconnecting &&
                (!credentials.appId ||
                  !credentials.privateKey ||
                  !credentials.webhookSecret) &&
                !endpoint.setup?.github?.appSlug),
          )}
        </>
      )}
      {step === 2 && endpoint && (
        <>
          <p className="text-sm">
            {l10n("local.install_the_bot_s_app_into_your_github_accoun_d40d8b89")}</p>
          <p className="text-sm text-muted-foreground">
            {l10n("local.you_will_choose_the_subset_enabled_in_papercl_7a6e89c3")}</p>
          {endpoint.setup?.github?.installationUrl && (
            <Button asChild>
              <a
                href={endpoint.setup.github.installationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {l10n("local.install_app_on_github_e7d912b5")}<ExternalLink className="ml-2 size-4" />
              </a>
            </Button>
          )}
          {footer("I’ve installed the App", async () => {
            setResources(await githubChatApi.refreshRepositories(endpoint.id));
            await go(3);
          })}
        </>
      )}
      {step === 3 && endpoint && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setResources(
                    await githubChatApi.refreshRepositories(endpoint.id),
                  );
                  setEndpoint(await chatEndpointsApi.get(endpoint.id));
                })
              }
            >
              <RefreshCw className="mr-2 size-4" />
              {l10n("local.refresh_access_0df81b58")}</Button>
            <Button variant="outline" asChild>
              <a
                href={
                  endpoint.setup?.github?.managementUrl ??
                  "https://github.com/settings/installations"
                }
                target="_blank"
                rel="noreferrer"
              >
                {l10n("local.configure_access_on_github_e9f56cc3")}<ExternalLink className="ml-2 size-4" />
              </a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {l10n("local.this_list_comes_from_the_bot_app_s_installati_93759d03")}</p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {resources.length === 0 && (
              <p className="p-4 text-sm">
                {l10n("local.no_repositories_found_configure_installation_30bcd525")}</p>
            )}
            {resources.map((resource) => (
              <div key={resource.id} className="p-4">
                <GitHubToggle
                  label={resource.label}
                  description={
                    resource.availability !== "available"
                      ? l10n("local.github_installation_access_is_unavailable_be83c868")
                      : l10n("local.available_to_this_app_installation_343c9809")
                  }
                  checked={
                    resource.enabled && resource.availability === "available"
                  }
                  onChange={(enabled) =>
                    setResources(
                      resources.map((row) =>
                        row.id === resource.id
                          ? {
                              ...row,
                              enabled:
                                enabled && row.availability === "available",
                            }
                          : row,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
          {footer(
            "Save repositories",
            async () => {
              await chatEndpointsApi.updateResources(
                endpoint.id,
                resources.map((resource) => ({
                  id: resource.id,
                  enabled: resource.enabled,
                })),
              );
              await chatEndpointsApi.update(endpoint.id, {
                allowGroupChats: true,
              });
              const configured = await chatEndpointsApi.setup(endpoint.id, {
                action:
                  endpoint.status === "draft" || endpoint.status === "attention"
                    ? "configure"
                    : "reconnect",
              });
              setEndpoint(configured);
              await go(4, configured);
            },
            !resources.some(
              (resource) =>
                resource.enabled && resource.availability === "available",
            ),
          )}
        </>
      )}
      {step === 4 && endpoint && (
        <>
          <p className="text-sm">
            {l10n("local.verify_signed_delivery_app_identity_repositor_1d855f92")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setVerification(await githubChatApi.verify(endpoint.id)),
                )
              }
            >
              {l10n("local.verify_connection_7b840072")}</Button>
            <Button
              variant="outline"
              disabled={busy || !record}
              onClick={() =>
                void run(async () => {
                  if (!record) return;
                  setRecord(
                    await githubChatApi.save(endpoint.id, record.revision, {
                      ...record.configuration,
                      toolsEnabled: true,
                    }),
                  );
                  setVerification(await githubChatApi.verify(endpoint.id));
                })
              }
            >
              {l10n("local.assign_this_bot_s_github_tools_4a308425")}</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {l10n("local.tool_assignment_grants_this_agent_the_bot_app_116cdcb8")}</p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {verification?.checks.map((check) => (
              <div key={check.key} className="flex gap-3 p-4">
                {check.ok ? (
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-(--status-task-done)" />
                ) : (
                  <XCircle className="mt-1 size-4 shrink-0 text-destructive" />
                )}
                <div>
                  <p className="text-sm font-medium">{check.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {check.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <GitHubAgentTrustWarning agent={selectedAgent} />
          {footer("Continue", () => go(5), !verification?.ready)}
        </>
      )}
      {step === 5 && endpoint && (
        <>
          <p className="text-sm">
            {l10n("local.choose_your_existing_personal_github_connecti_2fef5c50")}</p>
          <div className="space-y-2">
            <Label htmlFor="github-personal-account">
              {l10n("local.your_github_connection_b6eb02e7")}</Label>
            <select
              id="github-personal-account"
              className={githubSelectClass}
              value={personalConnectionId}
              onChange={(e) => {
                setPersonalConnectionId(e.target.value);
                setIdentity(null);
              }}
            >
              <option value="">{l10n("local.choose_a_personal_connection_323b061e")}</option>
              {accounts.data?.map((account) => (
                <option
                  key={account.connectionId}
                  value={account.connectionId}
                  disabled={!account.enabled || account.status !== "active"}
                >
                  {account.name}
                  {account.login ? (" " + l10n("local._value_fa3ec8c3", {v0: (account.login)})) : ""}
                  {account.status !== "active" ? (" " + l10n("local._reconnect_required_eeb7a476")) : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {l10n("local.shared_and_agent_connections_cannot_prove_you_88560962")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!personalConnectionId || busy}
              onClick={() =>
                void run(async () =>
                  setIdentity(
                    await githubChatApi.identity(
                      endpoint.id,
                      personalConnectionId,
                    ),
                  ),
                )
              }
            >
              {l10n("local.verify_my_account_8540f4de")}</Button>
            <Button variant="ghost" onClick={() => void accounts.refetch()}>
              {l10n("local.refresh_connections_cad52835")}</Button>
            <Link className="self-center text-sm underline" to="/apps/connect?source=github">
              {l10n("local.connect_github_4027e5b2")}</Link>
          </div>
          {accounts.error && (
            <p role="alert" className="text-sm text-destructive">
              {l10n("local.could_not_load_personal_connections_9f7fb239")}</p>
          )}
          {identity && (
            <div className="rounded-lg border border-border p-4">
              <p className="font-medium">@{identity.login}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {l10n("local.github_id_13f319d7")}{" "}{identity.githubUserId}{l10n("local._confirm_that_this_is_your_account_b51d7434")}</p>
            </div>
          )}
          {footer(
            "Confirm this is my account",
            async () => {
              await githubChatApi.identity(
                endpoint.id,
                personalConnectionId,
                identity!.githubUserId,
              );
              if (identityOnly) navigate("/apps");
              else await go(6);
            },
            !identity,
          )}
        </>
      )}
      {step === 6 && endpoint && record && (
        <>
          <GitHubAccessEditor
            endpointId={endpoint.id}
            companyId={endpoint.companyId}
            configuration={record.configuration}
            onChange={(configuration) =>
              setRecord({ ...record, configuration })
            }
          />
          <GitHubPolicyEditor
            policy={record.configuration.defaults}
            onChange={(defaults) =>
              setRecord({
                ...record,
                configuration: { ...record.configuration, defaults },
              })
            }
          />
          {footer("Save behavior", async () => {
            await saveConfiguration();
            await go(7);
          })}
        </>
      )}
      {step === 7 && endpoint && (
        <>
          <p className="text-sm">
            {l10n("local.mention_the_bot_in_an_enabled_repository_the_e98898df")}{" "}
            {selectedAgent?.name ?? endpoint.assignedAgentName} {l10n("local.and_reply_on_github_2d8cdf8c")}</p>
          <div className="flex items-center gap-3 rounded-lg border border-border p-4">
            <code className="min-w-0 flex-1 break-all text-sm">{mention}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label={l10n("local.copy_test_mention_e2d09d42")}
              onClick={() =>
                void copyTextToClipboard(mention).then(() => setCopied(true))
              }
            >
              <Copy className="size-4" />
            </Button>
          </div>
          {copied && (
            <p role="status" className="text-xs text-muted-foreground">
              {l10n("local.mention_copied_84071487")}</p>
          )}
          <p role="status" className="text-sm">
            {test.data?.messageReceivedAt
              ? l10n("local.message_received_wait_for_the_agent_s_respons_3f5a8a96")
              : l10n("local.waiting_for_your_test_message_4739b5e8")}
          </p>
          <Link
            className="text-sm underline"
            to={`/apps/chat/${endpoint.id}/conversations`}
          >
            {l10n("local.open_underlying_tasks_29b288a5")}</Link>
          {footer(
            "Verify response and finish",
            async () => {
              await chatEndpointsApi.test(endpoint.id);
              navigate(`/apps/chat/${endpoint.id}/settings`);
            },
            !test.data?.messageReceivedAt,
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await chatEndpointsApi.finishSlackSetup(endpoint.id);
                  navigate(`/apps/chat/${endpoint.id}/settings`);
                })
              }
            >
              {l10n("local.finish_without_test_75641f72")}</Button>,
          )}
        </>
      )}
    </div>
  );
}
