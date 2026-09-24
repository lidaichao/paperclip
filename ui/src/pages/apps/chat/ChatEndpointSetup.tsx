import { l10n } from "../../../i18n";
import { SLACK_BOT_TOOL_SCOPES } from "@paperclipai/shared";
import { defaultSlackAppName, slackBotNameForAgent } from "./slack-app-name";
import { GitHubChatSetup } from "./GitHubChatSetup";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { SlackAvatarStep } from "./SlackAvatarStep";
import { useSlackAvatarProgress } from "./slack-avatar-progress";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { SlackIdentityStep } from "./SlackIdentityStep";
import { PhotonConnectStep } from "./PhotonConnectStep";
import { EmailEndpointSetup } from "./EmailEndpointSetup";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, CircleHelp, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { useNavigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCopyAction } from "@/lib/use-copy-action";
import { isAgentStatusInvokable, slackAppConfigurationSchema, type SlackAppConfiguration } from "@paperclipai/shared";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";
import {
  createGitHubPrivateKeyReadGuard,
  readGitHubPrivateKeyFile,
} from "./github-private-key-file";

const providerNames: Record<ChatProvider, string> = {
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
};

const knownProviders = new Set(Object.keys(providerNames));

function isProvider(value: string | null): value is ChatProvider {
  return value !== null && knownProviders.has(value);
}

function publicOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isChatEndpointRepairing(
  endpoint: Pick<
    ChatEndpoint,
    "provider" | "status" | "providerAccountId" | "botExternalId"
  > | null,
  resumeEndpointId: string | null,
  reconnectRequested: boolean,
): boolean {
  if (!resumeEndpointId || !endpoint) return false;
  const recoveringStatus =
    endpoint.status === "attention" || endpoint.status === "revoked";
  // A secret-only GitHub draft affected by setup trouble has no App identity
  // or reusable App credentials. It must remain first-time setup, where App ID
  // and private key are required, rather than offering a misleading reconnect.
  if (
    endpoint.provider === "github" &&
    recoveringStatus &&
    !endpoint.providerAccountId &&
    !endpoint.botExternalId
  ) {
    return false;
  }
  return (
    recoveringStatus ||
    (reconnectRequested &&
      (endpoint.status === "active" || endpoint.status === "paused"))
  );
}

function ChatConnectionPurpose({ provider, onChat, onTools }: {
  provider: ChatProvider;
  onChat: () => void;
  onTools: () => void;
}) {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: l10n("local.connectors_c3d2e79e"), href: "/apps" }, { label: l10n("local.choose_connection_e9bd8aed") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  return (
      <div className="max-w-2xl space-y-6">
        <ChatSetupNavigation labels={provider === "slack" ? ["Choose agent", "Create Slack app", "Add credentials", "Verify Slack connection", "Add avatar", "Connect your Slack account", "Try it"] : undefined} step={0} availableStep={0} onSelect={onChat} />
        <div>
          <h1 className="text-xl font-bold">{l10n("local.choose_how_to_connect_aeb54e4f")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.what_should_this_f17f11fb")}{" "}{providerNames[provider]} {l10n("local.connection_do_f600c545")}</p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onChat}
          >
            <span className="block text-sm font-semibold">
              {l10n("local.chat_with_an_agent_73adffe3")}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {l10n("local.people_in_4c1b6571")}{" "}{providerNames[provider]} {l10n("local.can_start_and_continue_paperclip_tasks_d9f0d77f")}</span>
          </button>
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onTools}
          >
            <span className="block text-sm font-semibold">
              {l10n("local.use_this_connection_as_an_agent_tool_3035ada6")}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {l10n("local.let_agents_use_0ac3fd20")}{" "}{providerNames[provider]} {l10n("local.actions_and_data_while_they_work_4ce64667")}</span>
          </button>
        </div>
      </div>
  );
}

export function ChatEndpointSetup() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  if (params.get("provider") === "github") {
    if (params.get("purpose") === "chat" || params.get("resume")) return <GitHubChatSetup />;
    return <ChatConnectionPurpose provider="github" onChat={() => {
      const next = new URLSearchParams(params);
      next.set("purpose", "chat");
      setParams(next);
    }} onTools={() => navigate(params.get("toolHref") || "/apps/connect?source=github")} />;
  }
  return params.get("provider") === "agentmail" ? <EmailEndpointSetup /> : <ChatSdkEndpointSetup />;
}

function ChatSdkEndpointSetup() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const provider = isProvider(params.get("provider"))
    ? (params.get("provider") as ChatProvider)
    : null;
  const toolHref = params.get("toolHref") || "/apps";
  const preselectedAgent = params.get("agentId") ?? "";
  const resumeEndpointId = params.get("resume") ?? "";
  const reconnectRequested = params.get("reconnect") === "1";
  const [purpose, setPurpose] = useState<"choice" | "chat">(
    params.get("purpose") === "chat" ? "chat" : "choice",
  );
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [slackCredentialsReady, setSlackCredentialsReady] = useState(params.get("stage") === "credentials");
  const [viewedStep, setViewedStep] = useState<number | null>(null);
  const [slackIdentityReady, setSlackIdentityReady] = useState(false);
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [generatedWebhookSecret, setGeneratedWebhookSecret] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: l10n("local.connectors_c3d2e79e"), href: "/apps" },
      { label: l10n("local.connect_chat_611395e6") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: ["chat-endpoint-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const resumeQuery = useQuery({
    queryKey: ["chat-endpoint-setup-resume", resumeEndpointId],
    queryFn: () => chatEndpointsApi.get(resumeEndpointId),
    enabled: Boolean(resumeEndpointId),
  });
  useEffect(() => {
    if (!resumeQuery.data) return;
    setEndpoint(resumeQuery.data);
    setAgentId(resumeQuery.data.assignedAgentId);
    setPurpose("chat");
  }, [resumeQuery.data]);
  const githubVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-github-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(
      provider === "github" &&
      endpoint?.id &&
      endpoint.setup?.step === "provider_setup" &&
      endpoint.setup?.webhookSecretConfigured &&
      !endpoint.setup.webhookVerifiedAt,
    ),
    refetchInterval: 1_500,
  });
  useEffect(() => {
    if (
      !githubVerificationQuery.data ||
      provider !== "github" ||
      !endpoint ||
      endpoint.id !== githubVerificationQuery.data.id ||
      endpoint.setup?.step !== "provider_setup" ||
      !endpoint.setup?.webhookSecretConfigured ||
      endpoint.setup.webhookVerifiedAt
    )
      return;
    setEndpoint(githubVerificationQuery.data);
  }, [endpoint, githubVerificationQuery.data, provider]);
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: endpoint?.setup?.step === "test",
  });
  const activeAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter((agent) =>
        isAgentStatusInvokable(agent.status),
      ),
    [agentsQuery.data],
  );
  const syncEndpointSnapshot = (
    next: ChatEndpoint,
    onlyIfStillVisible = false,
  ) => {
    setEndpoint((visible) =>
      onlyIfStillVisible && visible?.id !== next.id ? visible : next,
    );
    queryClient.setQueryData(["chat-endpoint-setup-resume", next.id], next);
    queryClient.setQueryData(queryKeys.chatEndpoints.detail(next.id), next);
    if (next.provider === "github") {
      queryClient.setQueryData(
        ["chat-endpoint-github-webhook-verification", next.id],
        next,
      );
    }
  };
  const createEndpoint = useMutation({
    mutationFn: () =>
      chatEndpointsApi.create(selectedCompanyId!, {
        provider: provider!,
        assignedAgentId: agentId,
      }),
    onSuccess: (next) => {
      setViewedStep(null);
      syncEndpointSnapshot(next);
      if (next.provider === "imessage-photon") {
        const resumed = new URLSearchParams(params);
        resumed.set("resume", next.id);
        setParams(resumed, { replace: true });
      }
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_start_setup_afa41ad7"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const setupAction = useMutation({
    mutationFn: async ({
      action,
      values,
    }: {
      action: ChatEndpointSetupAction;
      values?: Record<string, string>;
    }) => {
      const endpointId = endpoint!.id;
      try {
        return await chatEndpointsApi.setup(endpointId, provider === "imessage-photon" ? {
      action,
      ...(values?.projectSecret ? { credentials: { projectSecret: values.projectSecret } } : {}),
      ...(values?.projectId && values.allocation === "shared" ? { photon: { allocation: "shared" as const, projectId: values.projectId } } : values?.projectId && values?.lineId ? { photon: { allocation: "dedicated" as const, projectId: values.projectId, lineId: values.lineId } } : {}),
        } : { action, credentials: values });
      } catch (error) {
        // Another open tab may have completed verification, or the successful
        // response may have been lost. Read the canonical state before retrying.
        if (action === "verify") {
          const current = await chatEndpointsApi.get(endpointId).catch(() => null);
          if (current?.setup?.step === "test" || current?.setup?.step === "complete") return current;
        }
        throw error;
      }
    },
    onMutate: () => setSetupError(null),
    onSuccess: (next) => {
      setSetupError(null);
      setViewedStep(null);
      syncEndpointSnapshot(next);
      setCredentials({});
      if (next.setup?.step !== "test" && next.setup?.step !== "complete") setSlackIdentityReady(false);
    },
    onError: (error, variables) =>
      setSetupError(sanitizedSetupErrorMessage(error, variables.values)),
  });
  const generateSetupSecret = useMutation({
    mutationFn: () => chatEndpointsApi.generateSetupSecret(endpoint!.id),
    onMutate: async () => {
      const endpointId = endpoint!.id;
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-setup-resume", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: queryKeys.chatEndpoints.detail(endpointId),
          exact: true,
        }),
      ]);
      return { endpointId };
    },
    onSuccess: async ({ webhookSecret }, _variables, context) => {
      const endpointId = context.endpointId;
      const markRotated = (current: ChatEndpoint) => ({
        ...current,
        setup: {
          ...current.setup,
          step: "provider_setup" as const,
          webhookSecretConfigured: true,
          webhookVerifiedAt: null,
        },
      });

      queryClient.removeQueries({
        queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
        exact: true,
      });
      setGeneratedWebhookSecret(webhookSecret);
      setEndpoint((current) =>
        current && current.id === endpointId ? markRotated(current) : current,
      );
      queryClient.setQueryData<ChatEndpoint>(
        ["chat-endpoint-setup-resume", endpointId],
        (current) => (current ? markRotated(current) : current),
      );
      queryClient.setQueryData<ChatEndpoint>(
        queryKeys.chatEndpoints.detail(endpointId),
        (current) => (current ? markRotated(current) : current),
      );

      try {
        const current = await chatEndpointsApi.get(endpointId);
        syncEndpointSnapshot(current, true);
      } catch {
        // Keep the one-time secret copyable. Verification polling will retry the
        // canonical endpoint read without restoring a pre-rotation snapshot.
      }
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_generate_webhook_secret_4529e92e"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const testConnection = useMutation({
    mutationFn: () => provider === "slack" ? chatEndpointsApi.finishSlackSetup(endpoint!.id) : chatEndpointsApi.test(endpoint!.id),
    onSuccess: (next) => {
      syncEndpointSnapshot(next);
      if (next.status === "active") navigate(`/apps/chat/${next.id}/settings`);
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.test_not_complete_34be17f8"),
        body:
          error instanceof Error
            ? error.message
            : l10n("local.send_the_provider_message_then_try_again_9a8973a2"),
        tone: "error",
      }),
  });

  const repairing = isChatEndpointRepairing(
    endpoint,
    resumeEndpointId,
    reconnectRequested,
  );
  const isSlack = provider === "slack";
  const avatarProgress = useSlackAvatarProgress(selectedCompanyId, endpoint?.id);
  const tryStep = isSlack ? 6 : 2;
  const availableStep = endpoint
    ? !repairing &&
      (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete")
      ? isSlack && endpoint.setup?.step !== "complete"
        ? !avatarProgress.progress ? 4 : !slackIdentityReady ? 5 : tryStep
        : tryStep
      : isSlack && endpoint.providerAccountId && !repairing ? 3
      : isSlack && (slackCredentialsReady || repairing) ? 2 : 1
    : 0;
  const step = Math.min(viewedStep ?? availableStep, availableStep);
  const avatarAgent = useQuery({
    queryKey: queryKeys.agents.detail(endpoint?.assignedAgentId ?? ""),
    queryFn: () => agentsApi.get(endpoint!.assignedAgentId, endpoint!.companyId),
    enabled: Boolean(isSlack && endpoint && step === 4),
  });
  const slackVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-slack-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(isSlack && step === 3 && endpoint?.setup?.step === "provider_setup" &&
      !endpoint.setup.webhookVerifiedAt && !setupAction.isPending),
    refetchInterval: 1_500,
  });
  useEffect(() => {
    const next = slackVerificationQuery.data;
    if (!next || !endpoint || next.id !== endpoint.id || setupAction.isPending ||
      endpoint.setup?.step !== "provider_setup" || endpoint.setup.webhookVerifiedAt ||
      !next.setup?.webhookVerifiedAt) return;
    setEndpoint(next);
  }, [slackVerificationQuery.data, endpoint, setupAction.isPending]);
  const autoVerificationAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (!isSlack || step !== 3 || endpoint?.setup?.step !== "provider_setup" ||
      !endpoint.setup.webhookVerifiedAt || setupAction.isPending) return;
    const attempt = `${endpoint.id}:${endpoint.setup.webhookVerifiedAt}`;
    if (autoVerificationAttempt.current === attempt) return;
    autoVerificationAttempt.current = attempt;
    setupAction.mutate({ action: "verify" });
  }, [isSlack, step, endpoint, setupAction]);

  if (!provider)
    return (
      <p className="text-sm text-destructive">
        {l10n("local.this_chat_provider_is_not_supported_4998d8ff")}</p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        {l10n("local.select_an_organization_to_connect_chat_7bd1f24b")}</p>
    );

  if (purpose === "choice") {
    return <ChatConnectionPurpose provider={provider} onChat={() => setPurpose("chat")} onTools={() => navigate(toolHref)} />;
  }

  const selectedAgent = agentsQuery.data?.find((agent) => agent.id === agentId);
  return (
    <div className="max-w-2xl space-y-6">
      <ChatSetupNavigation
        labels={isSlack ? ["Choose agent", "Create Slack app", "Add credentials", "Verify Slack connection", "Add avatar", "Connect your Slack account", "Try it"] : undefined}
        step={step}
        availableStep={availableStep}
        disabled={createEndpoint.isPending || setupAction.isPending || generateSetupSecret.isPending || testConnection.isPending}
        onSelect={setViewedStep}
      />
      <div className="min-w-0 space-y-6">
        {step === 0 ? (
          <>
            <div>
              <h1 className="text-xl font-bold">
                {l10n("local.which_agent_do_you_want_to_chat_with_14eb4b2e")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {l10n("local.this_agent_is_permanent_for_the_connection_co_7f876458")}</p>
            </div>
            {endpoint ? (
              <Input aria-label={l10n("local.assigned_agent_f96135ac")} value={endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId} readOnly />
            ) : <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder={l10n("local.choose_an_active_agent_e6be8c7a")}
              emptyMessage={l10n("local.no_active_agents_are_available_972bd5ae")}
            />}
            {provider === "github" && <GitHubAgentTrustWarning agent={selectedAgent} />}
            <SetupWizardFooter onSaveExit={() => navigate("/apps")}>
              <Button
                disabled={!agentId || createEndpoint.isPending}
                onClick={() => endpoint ? setViewedStep(1) : createEndpoint.mutate()}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {l10n("local.continue_31fbef16")}</Button>
            </SetupWizardFooter>
          </>
        ) : null}
        {endpoint && (
          <div hidden={step !== 1 && !(isSlack && (step === 2 || step === 3))} className="space-y-6">
            {setupError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">{l10n("local.connection_failed_596c52f1")}</p>
                <p className="mt-1">{setupError}</p>
              </div>
            ) : null}
            <ProviderConnectStep
              key={`${provider}:${endpoint.id}`}
              provider={provider}
              slackStage={step === 1 ? "app" : step === 3 ? "finish" : "credentials"}
              onSlackCredentialsContinue={() => setViewedStep(3)}
              onSlackVerificationContinue={() => setViewedStep(4)}
              slackVerificationError={slackVerificationQuery.isError}
              onSlackAppCreated={() => {
                setSlackCredentialsReady(true);
                setViewedStep(2);
                const resumed = new URLSearchParams(params);
                resumed.set("resume", endpoint.id);
                resumed.set("stage", "credentials");
                setParams(resumed, { replace: true });
              }}
              agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
              endpoint={endpoint}
              onEndpointSaved={syncEndpointSnapshot}
              credentials={credentials}
              setCredentials={setCredentials}
              repairing={repairing}
              pending={setupAction.isPending}
              generatedWebhookSecret={generatedWebhookSecret}
              generatingSetupSecret={generateSetupSecret.isPending}
              onGenerateSetupSecret={() => generateSetupSecret.mutate()}
              onAction={(action, values) =>
                setupAction.mutate({ action, values })
              }
            />
          </div>
        )}
        {endpoint && isSlack && step === 4 && (
          <div className="space-y-4">
            {avatarAgent.isPending ? <p role="status" className="text-sm text-muted-foreground">{l10n("local.loading_agent_avatar_0a92b683")}</p>
              : avatarAgent.isError ? <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_t_load_the_agent_s_avatar_984c743c")}{" "}<button className="underline" onClick={() => void avatarAgent.refetch()}>{l10n("local.try_again_d8b8392e")}</button></p>
              : <SlackAvatarStep
                  agentName={avatarAgent.data?.name ?? endpoint.assignedAgentName}
                  appName={endpoint.setup?.slackApp?.appName ?? defaultSlackAppName(avatarAgent.data?.name ?? endpoint.assignedAgentName)}
                  avatarUrl={agentAvatarUrl(resolveAgentAppearance(avatarAgent.data?.appearance, endpoint.assignedAgentId), 512, 1, "rest")}
                  uploaded={avatarProgress.progress === "uploaded"}
                  onUploaded={() => { avatarProgress.save("uploaded"); setViewedStep(5); }}
                  onSkip={() => { if (!avatarProgress.progress) avatarProgress.save("skipped"); setViewedStep(5); }}
                  onSaveExit={() => navigate("/apps")}
                />}
            {(avatarAgent.isPending || avatarAgent.isError) && <SetupWizardFooter onSaveExit={() => navigate("/apps")}><Button onClick={() => { avatarProgress.save("skipped"); setViewedStep(5); }}>{l10n("local.skip_for_now_b58eb52c")}</Button></SetupWizardFooter>}
          </div>
        )}
        {endpoint && isSlack && step === 5 && (
          <SlackIdentityStep
            endpointId={endpoint.id}
            command={endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"}
            testStartedAt={endpoint.setup?.testStartedAt}
            onSaveExit={() => navigate("/apps")}
            onConnected={() => {
              setSlackIdentityReady(true);
              setViewedStep(6);
            }}
          />
        )}
        {endpoint && step === tryStep && (
          <TryStep
            endpointId={endpoint.id}
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            botLabel={endpoint.botLabel}
            botUsername={endpoint.botUsername}
            photonAllocation={endpoint.photonAllocation}
            providerUrl={endpoint.setup?.providerUrl}
            guestIsolationState={
              experimentalSettingsQuery.isPending
                ? "loading"
                : experimentalSettingsQuery.isError
                  ? "unknown"
                  : experimentalSettingsQuery.data?.enableIsolatedWorkspaces ===
                      true
                    ? "enabled"
                    : "disabled"
            }
            pending={testConnection.isPending}
            onOpenAccess={() => navigate(`/apps/chat/${endpoint.id}/access`)}
            onTest={() => testConnection.mutate()}
            onSaveExit={() => navigate("/apps")}
          />
        )}
        {step !== 0 && !(isSlack && (step === 1 || step === 2 || step === 3 || step === 4 || step === 5 || step === 6)) && <div className="flex justify-start">
          <Button className="text-muted-foreground" variant="ghost" onClick={() => navigate("/apps")}>
            {l10n("local.save_amp_exit_df456d65")}</Button>
        </div>}
      </div>
    </div>
  );
}

function ProviderConnectStep({
  provider,
  slackStage,
  onSlackCredentialsContinue,
  onSlackVerificationContinue,
  slackVerificationError,
  onSlackAppCreated,
  agentName,
  endpoint,
  credentials,
  setCredentials,
  repairing,
  pending,
  onEndpointSaved,
  generatedWebhookSecret,
  generatingSetupSecret,
  onGenerateSetupSecret,
  onAction,
}: {
  provider: ChatProvider;
  slackStage: "app" | "credentials" | "finish";
  onSlackCredentialsContinue: () => void;
  onSlackVerificationContinue: () => void;
  slackVerificationError: boolean;
  onSlackAppCreated: () => void;
  agentName: string;
  endpoint: ChatEndpoint;
  credentials: Record<string, string>;
  setCredentials: Dispatch<SetStateAction<Record<string, string>>>;
  repairing: boolean;
  pending: boolean;
  onEndpointSaved: (endpoint: ChatEndpoint) => void;
  generatedWebhookSecret: string;
  generatingSetupSecret: boolean;
  onGenerateSetupSecret: () => void;
  onAction: (
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ) => void;
}) {
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const slackBotToken = (credentials.botToken ?? "").trim();
  const slackBotTokenInvalid = provider === "slack" && slackBotToken.length > 0 &&
    !slackBotToken.startsWith("xoxb-");
  const slackSigningSecretHasTokenPrefix = provider === "slack" &&
    /^x[a-z0-9]*-/i.test((credentials.signingSecret ?? "").trim());
  const slackCredentialsSaved = provider === "slack" && Boolean(endpoint.providerAccountId);
  const continueWithSavedSlackCredentials = slackCredentialsSaved && !repairing &&
    !slackBotToken && !credentials.signingSecret?.trim();
  const reportCopyFailure = () =>
    pushToast({
      title: l10n("local.couldn_t_copy_to_clipboard_72ff542b"),
      body: l10n("local.select_and_copy_the_value_manually_d630d482"),
      tone: "error",
    });
  const field = (key: string, label: string, type = "password") => (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <Input
        type={type}
        value={credentials[key] ?? ""}
        onChange={(event) =>
          setCredentials({ ...credentials, [key]: event.target.value })
        }
      />
    </label>
  );
  const openProviderSetup = (fallback: string) =>
    window.open(
      endpoint.setup?.authorizationUrl ??
        endpoint.setup?.providerUrl ??
        fallback,
      "_blank",
      "noopener,noreferrer",
    );
  const endpointValue = (label: string, value: string | null | undefined) => (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="rounded-lg border border-border bg-muted p-3 font-mono text-xs break-all">
        {value ??
          l10n("local.this_endpoint_is_unavailable_check_the_server_b7497006")}
      </div>
    </div>
  );
  const [manifestCopied, setManifestCopied] = useState(false);
  // A hook rather than a sticky boolean: this step stays mounted when the
  // secret is regenerated, so a latched "copied" would keep vouching for a
  // value the reader never copied. The status resets itself, and a refused
  // clipboard reads as a failure instead of a success.
  const webhookSecretCopy = useCopyAction();
  const [openingSlackApp, setOpeningSlackApp] = useState(false);
  const slackAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setOpeningSlackApp(false);
    return () => {
      if (slackAdvanceTimer.current !== null) {
        clearTimeout(slackAdvanceTimer.current);
        slackAdvanceTimer.current = null;
      }
    };
  }, [slackStage]);
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [privateKeyFileError, setPrivateKeyFileError] = useState<string | null>(
    null,
  );
  const [privateKeyFileLoaded, setPrivateKeyFileLoaded] = useState(false);
  const [privateKeyFileLoading, setPrivateKeyFileLoading] = useState(false);
  const privateKeyFileInputRef = useRef<HTMLInputElement>(null);
  const privateKeyReadGuard = useRef(createGitHubPrivateKeyReadGuard()).current;
  useEffect(
    () => () => {
      privateKeyReadGuard.invalidate();
    },
    [privateKeyReadGuard],
  );
  const loadPrivateKeyFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const readRevision = privateKeyReadGuard.start();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(true);
    try {
      const privateKey = await readGitHubPrivateKeyFile(file);
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setCredentials((current) => ({ ...current, privateKey }));
      setPrivateKeyVisible(false);
      setPrivateKeyFileLoaded(true);
    } catch (error) {
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setPrivateKeyFileError(
        error instanceof Error
          ? error.message
          : "Paperclip couldn't read that file. Choose the .pem file again or paste the private key.",
      );
    } finally {
      if (privateKeyReadGuard.isCurrent(readRevision)) {
        setPrivateKeyFileLoading(false);
      }
    }
  };
  const replacePrivateKey = (privateKey: string) => {
    privateKeyReadGuard.invalidate();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(false);
    setCredentials((current) => ({ ...current, privateKey }));
  };
  const defaultSlackCommand =
    endpoint.setup?.command ??
    `/${
      agentName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "paperclip"
    }`;
  const defaultSlackBotName = slackBotNameForAgent(agentName);
  const [slackApp, setSlackApp] = useState<SlackAppConfiguration>(() =>
    endpoint.setup?.slackApp ?? {
      appName: defaultSlackAppName(agentName),
      botName: defaultSlackBotName,
      command: defaultSlackCommand,
    },
  );
  const slackDetailsEditable = endpoint.status === "draft" && !endpoint.botExternalId;
  const slackValidation = slackAppConfigurationSchema.safeParse(slackApp);
  const saveSlackApp = useMutation({
    scope: { id: `slack-app-details:${endpoint.id}` },
    mutationFn: (details: SlackAppConfiguration) =>
      chatEndpointsApi.update(endpoint.id, { slackApp: details }),
    onSuccess: onEndpointSaved,
  });
  const persistSlackApp = () => {
    if (!slackDetailsEditable || !slackValidation.success) return;
    if (JSON.stringify(slackValidation.data) === JSON.stringify(endpoint.setup?.slackApp)) return;
    saveSlackApp.mutate(slackValidation.data);
  };
  const slackAppName = slackApp.appName.trim();
  const slackBotName = slackApp.botName.trim();
  const slackCommand = slackApp.command.trim();
  const slackWebhookUrl =
    endpoint.setup?.webhookUrl ?? "<paperclip-webhook-url>";
  const slackManifest = `display_information:
  name: ${JSON.stringify(slackAppName)}
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  agent_view:
    agent_description: "Work with a Paperclip agent in a task-backed conversation."
  bot_user:
    display_name: ${JSON.stringify(slackBotName)}
  slash_commands:
    - command: ${JSON.stringify(slackCommand)}
      description: ${JSON.stringify(`Start or manage work with ${agentName}`)}
      usage_hint: ${JSON.stringify("status | new | close | <task>")}
      should_escape: false
      url: ${JSON.stringify(slackWebhookUrl)}
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
${SLACK_BOT_TOOL_SCOPES.map(scope => `      - ${scope}`).join("\n")}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: ${JSON.stringify(slackWebhookUrl)}
    bot_events:
      - agent_session_stopped
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
      - member_left_channel
      - channel_left
      - group_left
      - reaction_added
      - reaction_removed
      - channel_archive
      - group_archive
      - channel_unarchive
      - group_unarchive
      - channel_deleted
      - channel_rename
      - group_rename
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: ${JSON.stringify(slackWebhookUrl)}`;
  // Slack's documented creation link accepts a URL-encoded YAML manifest.
  const slackCreateUrl = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(slackManifest)}`;
  useEffect(() => setManifestCopied(false), [slackManifest]);
  const teamsClientId =
    credentials.clientId?.trim() || "<application-client-id>";
  const teamsManifestSettings = JSON.stringify(
    {
      bots: [
        {
          botId: teamsClientId,
          scopes: ["personal", "team", "groupChat"],
          supportsFiles: true,
          isNotificationOnly: false,
          commandLists: [
            {
              scopes: ["personal", "groupChat"],
              commands: [
                {
                  title: "/status",
                  description: "Show the active Paperclip task status",
                },
                {
                  title: "/new",
                  description: "Start a new Paperclip task in this chat",
                },
                {
                  title: "/close",
                  description: "Close the active chat conversation",
                },
              ],
            },
          ],
        },
      ],
      webApplicationInfo: {
        id: teamsClientId,
        resource: "https://paperclip.ing",
      },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: "ChannelMessage.Read.Group", type: "Application" },
            { name: "ChatMessage.Read.Chat", type: "Application" },
          ],
        },
      },
    },
    null,
    2,
  );
  if (provider === "imessage-photon") return <PhotonConnectStep endpoint={endpoint} agentName={agentName} repairing={repairing} pending={pending} onAction={onAction} />;
  if (provider === "discord") {
    const applicationId = credentials.applicationId?.trim() ?? "";
    const guildId = credentials.guildId?.trim() ?? "";
    const installUrl = applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=309237763136&scope=bot${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ""}`
      : null;
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{l10n("local.connect_1a2303ed")}{" "}{agentName} {l10n("local.to_discord_3bd0fc6a")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? l10n("local.reconnect_verifies_this_same_discord_applicat_526a3c18")
              : l10n("local.create_one_dedicated_discord_application_and_addb1ae3")}
          </p>
        </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {l10n("local.in_discord_developer_portal_create_an_applica_c64fd948")}</li>
          <li>
            {l10n("local.open_bot_create_the_bot_enable_message_conten_de4d6d6f")}</li>
          <li>
            {l10n("local.enable_developer_mode_in_discord_right_click_65acc2a7")}</li>
          <li>
            {l10n("local.enter_those_values_below_then_use_the_generat_552ecc34")}</li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        >
          {l10n("local.open_discord_developer_portal_090b2a59")}{" "}<ExternalLink />
        </Button>
        {field("applicationId", "Application ID", "text")}
        {field("guildId", "Server ID", "text")}
        {field("botToken", "Bot token")}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer">
              {l10n("local.install_bot_in_this_server_8f6e4fbe")}{" "}<ExternalLink />
            </a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          {l10n("local.the_install_link_grants_only_view_channels_se_1f80c95a")}</p>
        <Button
          disabled={
            (!repairing &&
              (!credentials.applicationId ||
                !credentials.guildId ||
                !credentials.botToken)) ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? l10n("local.reconnect_discord_bot_5abd85c1") : l10n("local.connect_discord_bot_e2cc4408")}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{l10n("local.create_4759498a")}{" "}{agentName} {l10n("local.in_telegram_df102afb")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? l10n("local.reconnect_verifies_this_same_botfather_bot_an_ac88d22b")
              : l10n("local.create_a_bot_with_botfather_then_paste_the_to_e7cbd41e")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {l10n("local.open_botfather_and_send_42448eca")}{" "}<code>/newbot</code>.
          </li>
          <li>{l10n("local.enter_the_bot_display_name_4feda679")}</li>
          <li>
            {l10n("local.choose_an_available_username_ending_in_07917390")}{" "}<code>bot</code>.
          </li>
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {l10n("local.paperclip_works_with_telegram_apos_s_default_bbe81b70")}{" "}
          <code>/task@bot_username &lt;request&gt;</code>{l10n("local._or_reply_directly_to_a_message_from_the_bot_56c4e6eb")}</p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        >
          {l10n("local.open_botfather_a099b632")}{" "}<ExternalLink />
        </Button>
        {field("botToken", "Bot token")}
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            {l10n("local.configure_a_public_https_url_for_this_papercl_be61462c")}</p>
        )}
        <Button
          disabled={
            (!repairing && !credentials.botToken) ||
            !endpoint.setup?.webhookUrl ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? l10n("local.reconnect_bot_56693e2e") : l10n("local.connect_bot_301e4243")}
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {l10n("local.connect_1a2303ed")}{" "}{agentName} {l10n("local.to_microsoft_teams_75550de6")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? l10n("local.reconnect_verifies_this_same_microsoft_app_te_328b17aa")
              : l10n("local.use_your_own_microsoft_app_credentials_for_th_556108c3")}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {l10n("local.this_setup_requires_a_microsoft_365_work_or_s_ec9dc0bc")}</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {l10n("local.in_microsoft_entra_create_a_single_tenant_app_4a2aace3")}</li>
          <li>
            {l10n("local.in_azure_create_an_azure_bot_choose_single_te_cf68483b")}</li>
          <li>
            {l10n("local.in_teams_developer_portal_create_an_app_add_a_d8d35edd")}</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            >
              {l10n("local.open_microsoft_entra_f23b82e1")}{" "}<ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            >
              {l10n("local.create_azure_bot_adaaf3ae")}{" "}<ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              {l10n("local.open_teams_developer_portal_8606db85")}{" "}<ExternalLink />
            </a>
          </Button>
        </div>
        {endpointValue(
          "Paperclip messaging endpoint",
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", "Application / Client ID", "text")}
        {field("tenantId", "Directory / Tenant ID", "text")}
        {field("clientSecret", "Client secret value")}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">
              {l10n("local.microsoft_portal_field_map_6a0f1431")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {l10n("local.use_these_exact_portal_sections_and_reuse_the_8bea8509")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <strong>{l10n("local.microsoft_entra_admin_center_app_registration_b4935613")}</strong>{l10n("local._select_597e831f")}{" "}<strong>{l10n("local.new_registration_5c35cd89")}</strong>{l10n("local._choose_b27b9718")}{" "}
              <strong>
                {l10n("local.accounts_in_this_organizational_directory_onl_5c39323e")}</strong>
              {l10n("local._then_select_6dc948aa")}{" "}<strong>{l10n("local.register_bb7234ec")}</strong>{l10n("local._copy_4e44ac9a")}{" "}
              <strong>{l10n("local.application_client_id_576111a7")}</strong> {l10n("local.and_6201111b")}{" "}
              <strong>{l10n("local.directory_tenant_id_1dc4abe2")}</strong>{l10n("local._under_a408a6c3")}{" "}
              <strong>{l10n("local.certificates_amp_secrets_client_secrets_0a5426c1")}</strong>{l10n("local._select_ed6fac98")}{" "}<strong>{l10n("local.new_client_secret_02aac1d8")}</strong> {l10n("local.and_copy_its_dda8c2c1")}{" "}
              <strong>{l10n("local.value_8e37953d")}</strong>{l10n("local._not_its_secret_id_98bac72b")}</li>
            <li>
              <strong>{l10n("local.azure_create_azure_bot_24528727")}</strong>{l10n("local._set_b28d625a")}{" "}
              <strong>{l10n("local.microsoft_app_id_689f79d2")}</strong> {l10n("local.to_663ea1bf")}{" "}
              <strong>{l10n("local.single_tenant_32517762")}</strong>{l10n("local._set_1a7f496d")}{" "}<strong>{l10n("local.creation_type_a90668db")}</strong>{" "}
              {l10n("local.to_663ea1bf")}{" "}<strong>{l10n("local.use_existing_app_registration_e7a8befd")}</strong>{l10n("local._and_enter_the_application_id_and_tenant_id_a_6e689f27")}{" "}
              <strong>{l10n("local.settings_configuration_15674b2b")}</strong> {l10n("local.and_paste_the_paperclip_480442a4")}{" "}
              <strong>{l10n("local.messaging_endpoint_8dcb943d")}</strong>{l10n("local._then_open_df051281")}{" "}
              <strong>{l10n("local.settings_channels_010583e2")}</strong> {l10n("local.and_enable_e3adc622")}{" "}
              <strong>{l10n("local.microsoft_teams_a7b52b26")}</strong>.
            </li>
            <li>
              <strong>{l10n("local.teams_developer_portal_apps_ee4c150d")}</strong>{l10n("local._select_597e831f")}{" "}
              <strong>{l10n("local.new_app_747f1473")}</strong>{l10n("local._under_a408a6c3")}{" "}
              <strong>{l10n("local.configure_app_features_bot_e7d5d293")}</strong>{l10n("local._add_an_existing_bot_using_the_same_applicati_84e44cfc")}{" "}
              <strong>{l10n("local.personal_845f9286")}</strong>, <strong>{l10n("local.team_5985039f")}</strong>{l10n("local._and_4aa9bfd2")}{" "}
              <strong>{l10n("local.group_chat_28c7d3f8")}</strong> {l10n("local.scopes_plus_file_support_under_9fae582a")}{" "}
              <strong>{l10n("local.configure_permissions_f45a200a")}</strong>{l10n("local._add_the_two_rsc_d615211f")}{" "}
              <strong>{l10n("local.application_e7ad522e")}</strong> {l10n("local.permissions_shown_below_complete_the_required_48996c48")}</li>
            <li>
              <strong>{l10n("local.microsoft_teams_apps_manage_your_apps_97fd174b")}</strong>{l10n("local._select_597e831f")}{" "}
              <strong>{l10n("local.upload_an_app_upload_a_custom_app_08d248a0")}</strong>{l10n("local._choose_the_downloaded_package_and_install_it_d0490600")}</li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">
          {l10n("local.required_teams_app_manifest_block_55ea4fc3")}<Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={teamsManifestSettings}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!credentials.clientId?.trim()}
            onClick={() => {
              void copyTextToClipboard(teamsManifestSettings).then(
                () => setManifestCopied(true),
                reportCopyFailure,
              );
            }}
          >
            {manifestCopied
              ? l10n("local.manifest_settings_copied_c8f17ea3")
              : l10n("local.copy_manifest_settings_b0b424ee")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {l10n("local.enter_the_application_client_id_above_before_bb8a73b9")}</p>
        <p className="text-sm text-muted-foreground">
          {l10n("local.paperclip_does_not_use_teams_single_sign_on_i_3f37c908")}{" "}<code>webApplicationInfo</code> {l10n("local.entry_only_associates_the_rsc_permissions_wit_797eed85")}</p>
        <p className="text-sm text-muted-foreground">
          {l10n("local.the_two_application_rsc_permissions_let_the_b_7578d067")}</p>
        <p className="text-sm text-muted-foreground">
          {l10n("local.this_release_supports_personal_chats_group_ch_96f2af1e")}{" "}<code>supportsFiles: true</code>{" "}
          {l10n("local.enables_native_file_receipt_and_consent_based_57ef82b7")}</p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">
            {l10n("local.configure_a_public_https_url_for_this_papercl_64624ace")}</p>
        )}
        <Button
          disabled={
            (!repairing &&
              (!credentials.clientId ||
                !credentials.tenantId ||
                !credentials.clientSecret)) ||
            !endpoint.setup?.messagingEndpoint ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing
            ? l10n("local.reconnect_microsoft_app_c3748cd7")
            : l10n("local.verify_microsoft_credentials_716e44d2")}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {repairing
              ? l10n("local.reconnect_github_app_39ee43bf")
              : l10n("local.create_or_connect_a_github_app_2ede47af")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? l10n("local.reconnect_verifies_this_same_app_and_installa_e9a6cd4e")
              : l10n("local.configure_its_webhook_and_permissions_then_ve_42a6576f")}
          </p>
        </div>
        {!repairing && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              {l10n("local.under_the_target_user_or_organization_create_d17f40b3")}</li>
            <li>
              {l10n("local.keep_183f00f4")}{" "}<strong>{l10n("local.webhooks_active_dde916ab")}</strong> {l10n("local.on_enter_the_paperclip_webhook_url_and_the_pa_5804a582")}{" "}<strong>{l10n("local.enable_ssl_verification_b817ccfb")}</strong> {l10n("local.selected_a1260b5d")}</li>
            <li>
              {l10n("local.under_repository_permissions_set_6874414a")}{" "}<strong>{l10n("local.issues_666067dd")}</strong> {l10n("local.and_6201111b")}{" "}
              <strong>{l10n("local.pull_requests_d9e3f260")}</strong> {l10n("local.to_663ea1bf")}{" "}
              <strong>{l10n("local.read_amp_write_1cf85447")}</strong>{l10n("local._leave_every_other_permission_at_its_default_5e953a8a")}</li>
            <li>
              {l10n("local.subscribe_to_a067f416")}{" "}<strong>{l10n("local.issue_comment_b58fb193")}</strong> (
              <code>issue_comment</code>),{" "}
              <strong>{l10n("local.pull_request_review_comment_a480a0e1")}</strong> (
              <code>pull_request_review_comment</code>{l10n("local._github_sends_c85ce75b")}{" "}
              <code>installation</code> {l10n("local.and_6201111b")}{" "}
              <code>installation_repositories</code> {l10n("local.to_every_github_app_automatically_they_are_no_688aa7ac")}</li>
            <li>
              {l10n("local.choose_c7f93783")}{" "}<strong>{l10n("local.only_on_this_account_bc291e52")}</strong>{l10n("local._create_the_app_copy_its_app_id_generate_one_2c651456")}</li>
          </ol>
        )}
        {endpointValue(
          "Paperclip homepage URL",
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue("Paperclip webhook URL", endpoint.setup?.webhookUrl)}
        <Button
          variant="outline"
          onClick={() =>
            window.open(
              repairing
                ? "https://github.com/settings/apps"
                : (endpoint.setup?.authorizationUrl ??
                    "https://github.com/settings/apps/new"),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          {repairing ? l10n("local.open_github_app_settings_1395525a") : l10n("local.open_new_github_app_form_09512a8d")}{" "}
          <ExternalLink />
        </Button>
        {field("appId", "GitHub App ID", "text")}
        <div className="grid gap-2 text-sm font-medium">
          <label htmlFor="github-private-key">{l10n("local.private_key_pem_1a5ad986")}</label>
          <div className="relative">
            {privateKeyVisible ? (
              <Textarea
                id="github-private-key"
                className="min-h-24 pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
              />
            ) : (
              <Input
                id="github-private-key"
                type="password"
                className="pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  replacePrivateKey(event.clipboardData.getData("text"));
                }}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1"
              aria-label={
                privateKeyVisible ? l10n("local.hide_private_key_6ffb67bc") : l10n("local.show_private_key_adde31d8")
              }
              onClick={() => setPrivateKeyVisible((visible) => !visible)}
            >
              {privateKeyVisible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <input
            ref={privateKeyFileInputRef}
            type="file"
            accept=".pem,.key,application/x-pem-file,application/pkcs8,text/plain"
            className="hidden"
            aria-label={l10n("local.choose_github_app_private_key_file_67623763")}
            onChange={loadPrivateKeyFile}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => privateKeyFileInputRef.current?.click()}
            >
              {l10n("local.choose_pem_file_bd08402e")}</Button>
          </div>
          {privateKeyFileError ? (
            <p role="alert" className="text-sm text-destructive">
              {privateKeyFileError}
            </p>
          ) : null}
          {privateKeyFileLoading ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {l10n("local.reading_private_key_file_c5c9855e")}</p>
          ) : privateKeyFileLoaded ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {l10n("local.private_key_loaded_it_stays_in_this_form_unti_13a97342")}</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{l10n("local.webhook_secret_342da972")}</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label={l10n("local.generated_webhook_secret_90e15bc0")}
                className="font-mono text-xs"
                readOnly
                value={generatedWebhookSecret}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    // Both signals, and each covers the other's blind spot.
                    // The toast is the loud one, the way this step's other two
                    // copy buttons report failure — but the provider dedupes an
                    // identical toast inside 3.5s, so a reader who clicks twice
                    // on a blocked clipboard would see nothing the second time.
                    // The inline state answers every click.
                    void webhookSecretCopy
                      .copy(generatedWebhookSecret)
                      .then((status) => {
                        if (status === "failed") reportCopyFailure();
                      });
                  }}
                >
                  {webhookSecretCopy.copied
                    ? l10n("local.webhook_secret_copied_444c369d")
                    : webhookSecretCopy.failed
                      ? l10n("local.couldn_t_copy_select_it_manually_368f602d")
                      : l10n("local.copy_webhook_secret_a6635b8c")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {l10n("local.copy_this_value_now_paperclip_will_not_show_i_32126b2c")}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? l10n("local.a_webhook_secret_is_configured_and_cannot_be_60ae9090")
                : l10n("local.generate_the_secret_in_paperclip_then_paste_i_7651731d")}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={generatingSetupSecret}
              onClick={onGenerateSetupSecret}
            >
              {generatingSetupSecret && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {endpoint.setup?.webhookSecretConfigured
                ? l10n("local.regenerate_webhook_secret_8256661f")
                : l10n("local.generate_webhook_secret_cfbc14de")}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? l10n("local.regenerating_immediately_invalidates_github_w_ca9e3b5f")
                : l10n("local.generating_another_secret_replaces_the_previo_7ac93157")}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? l10n("local.github_has_verified_this_webhook_f7c4fecf")
                : l10n("local.waiting_for_github_to_deliver_its_signed_webh_4255e14b")}
            </p>
          )}
        </div>
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            {l10n("local.configure_a_public_https_url_for_this_papercl_54b7183f")}</p>
        )}
        <Button
          disabled={
            (!repairing && (!credentials.appId || !credentials.privateKey)) ||
            !endpoint.setup?.webhookSecretConfigured ||
            !endpoint.setup?.webhookVerifiedAt ||
            !endpoint.setup?.webhookUrl ||
            privateKeyFileLoading ||
            generatingSetupSecret ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? l10n("local.reconnect_and_verify_9487232d") : l10n("local.connect_and_verify_a2bfc0e2")}
        </Button>
      </div>
    );
  if (slackStage === "finish")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{l10n("local.verify_slack_connection_f64c0a1d")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.slack_needs_to_confirm_that_it_can_reach_your_a2c02d93")}</p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li><a className="underline underline-offset-4" href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">{l10n("local.open_slack_app_settings_30cfde1e")}{" "}<ExternalLink className="inline size-3" /></a> {l10n("local.and_choose_566c1f30")}{" "}<strong>{slackApp.appName}</strong>.</li>
          <li>{l10n("local.choose_c7f93783")}{" "}<strong>{l10n("local.event_subscriptions_66432617")}</strong>.</li>
          <li>{l10n("local.beside_the_prefilled_3b8a3f4a")}{" "}<strong>{l10n("local.request_url_dafbe40c")}</strong>{l10n("local._click_254b3f7a")}{" "}<strong>{l10n("local.retry_942087cc")}</strong> {l10n("local.if_it_isn_apos_t_verified_save_changes_if_sla_e294b3ff")}</li>
        </ol>
        {endpoint.setup?.webhookVerifiedAt ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-(--status-task-done)" />
            {l10n("local.slack_verified_your_connection_5bb1e424")}{pending ? (" " + l10n("local.opening_the_message_test_42e9485b")) : ""}
          </p>
        ) : slackVerificationError ? (
          <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_check_verification_we_apos_ll_k_5ea66d54")}</p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {l10n("local.waiting_for_slack_to_verify_we_apos_ll_contin_c488145d")}</p>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{l10n("local.troubleshooting_c3af076f")}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">{l10n("local.if_the_request_url_is_missing_or_different_pa_f35fe901")}</p>
            {endpointValue("Paperclip webhook URL", endpoint.setup?.webhookUrl)}
          </div>
        </details>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{l10n("local.save_amp_exit_df456d65")}</Button>
          <Button disabled={pending || !endpoint.setup?.webhookVerifiedAt} onClick={() =>
            endpoint.setup?.step === "provider_setup" ? onAction("verify") : onSlackVerificationContinue()
          }>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {l10n("local.continue_31fbef16")}</Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-5">
      {!endpoint.setup?.webhookUrl && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{l10n("local.public_https_url_required_e211fdbd")}</p>
            <p className="text-sm">
              {l10n("local.slack_needs_a_public_https_url_to_send_messag_4d8a53f1")}</p>
            <a
              href="https://docs.paperclip.ing/reference/deploy/https/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              {l10n("local.learn_how_to_set_up_https_d73f790b")}</a>
          </div>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold">{slackStage === "app" ? l10n("local.create_a_slack_app_80a0f951") : l10n("local.add_slack_credentials_eafbd79f")}</h1>
        {repairing && (
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.reconnect_verifies_or_replaces_credentials_fo_c4328e46")}</p>
        )}
      </div>
      <div hidden={slackStage !== "app"} className="space-y-5">
        <div className="space-y-3 text-sm">
          {([
            ["appName", "Slack app name", 35, "The name of your app in Slack’s app directory and settings."],
            ["botName", "Bot display name", 80, "The name people see when your bot sends a message. Use lowercase letters, numbers, periods, hyphens, or underscores."],
            ["command", "Slash command", 32, "The command people type in Slack to talk to this agent. Start with /, followed by lowercase letters, numbers, hyphens, or underscores."],
          ] as const).map(([key, label, maxLength, help]) => (
            <div key={key} className="grid items-center gap-2 sm:grid-cols-2">
              <div className="flex items-center gap-1.5">
                <label htmlFor={`slack-${key}`}>{label}</label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={l10n("local.help_with_value_99385c23", {v0: (label.toLowerCase())})}
                      className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CircleHelp className="size-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{help}</TooltipContent>
                </Tooltip>
              </div>
              <Input
                id={`slack-${key}`}
                className="bg-background text-foreground dark:bg-background"
                value={slackApp[key]}
                maxLength={maxLength}
                readOnly={!slackDetailsEditable}
                aria-invalid={!slackValidation.success && slackValidation.error.issues.some((issue) => issue.path[0] === key)}
                onChange={(event) => setSlackApp({ ...slackApp, [key]: event.target.value })}
                onBlur={persistSlackApp}
              />
            </div>
          ))}
          {!slackValidation.success && (
            <p role="alert" className="text-sm text-destructive">{slackValidation.error.issues[0].message}</p>
          )}
          {saveSlackApp.isError && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{l10n("local.couldn_apos_t_save_the_slack_app_details_try_714de83b")}</p>
              <Button variant="outline" size="sm" onClick={persistSlackApp}>{l10n("local.retry_saving_3adee60b")}</Button>
            </div>
          )}
          <div className="flex justify-end">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="link" className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-4">
                  {l10n("local.view_slack_app_manifest_d0918c4c")}</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{l10n("local.slack_app_manifest_3d57b605")}</DialogTitle>
                  <DialogDescription>
                    {l10n("local.generated_from_your_app_name_bot_name_and_sla_1feb775e")}</DialogDescription>
                </DialogHeader>
                <Textarea
                  aria-label={l10n("local.slack_app_manifest_3d57b605")}
                  className="h-80 font-mono text-xs"
                  readOnly
                  value={slackManifest}
                />
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={!slackValidation.success}
                    onClick={() => {
                      void copyTextToClipboard(slackManifest).then(
                        () => setManifestCopied(true),
                        reportCopyFailure,
                      );
                    }}
                  >
                    {manifestCopied ? l10n("local.manifest_copied_64e6431b") : l10n("local.copy_manifest_415f928f")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>
            {l10n("local.save_amp_exit_df456d65")}</Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success || saveSlackApp.isPending || saveSlackApp.isError} onClick={onSlackAppCreated}>
              {l10n("local.i_already_created_the_app_b71ded6b")}</Button>
            {!repairing && (
              <Button
                disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success || saveSlackApp.isPending || saveSlackApp.isError}
                onClick={() => {
                  window.open(slackCreateUrl, "_blank", "noopener,noreferrer");
                  setOpeningSlackApp(true);
                  // Let Slack open before changing the step behind its new tab.
                  slackAdvanceTimer.current = setTimeout(() => {
                    slackAdvanceTimer.current = null;
                    setOpeningSlackApp(false);
                    onSlackAppCreated();
                  }, 1000);
                }}
              >
                {l10n("local.create_slack_app_7e043d9f")}{" "}<ExternalLink />
              </Button>
            )}
          </div>
        </div>
      </div>
      <div hidden={slackStage !== "credentials"} className="space-y-5">
        <p className="text-sm">
          {l10n("local.now_you_need_to_find_two_secrets_they_are_in_6aa5da60")}</p>
        {slackCredentialsSaved && !repairing && (
          <p className="text-sm text-muted-foreground">{l10n("local.your_credentials_are_saved_leave_the_fields_b_817aa6e7")}</p>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-bot-token">{l10n("local.bot_user_oauth_token_d6b64bf5")}</label></h2>
          <ul id="slack-bot-token-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {l10n("local.open_slack_app_settings_30cfde1e")}{" "}<ExternalLink className="inline size-3" />
              </a> {l10n("local.and_choose_566c1f30")}{" "}<strong>{slackApp.appName}</strong>.
            </li>
            <li>{l10n("local.choose_c7f93783")}{" "}<strong>{l10n("local.oauth_amp_permissions_d4caa96c")}</strong></li>
            <li>{l10n("local.copy_and_paste_your_ef79f937")}{" "}<strong>{l10n("local.bot_oauth_token_9d89851e")}</strong></li>
          </ul>
          <Input
            id="slack-bot-token"
            type="password"
            placeholder={slackCredentialsSaved ? l10n("local.saved_leave_blank_to_keep_f1a85f6b") : undefined}
            value={credentials.botToken ?? ""}
            aria-invalid={slackBotTokenInvalid || undefined}
            aria-describedby={`slack-bot-token-help${slackBotTokenInvalid ? " slack-bot-token-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, botToken: event.target.value })}
          />
          {slackBotTokenInvalid && (
            <p id="slack-bot-token-warning" role="alert" className="text-sm text-destructive">
              {l10n("local.your_bot_user_oauth_token_must_start_with_80bd918b")}{" "}<code>xoxb-</code>{l10n("local._copy_it_from_3312ef29")}{" "}<strong>{l10n("local.oauth_amp_permissions_d4caa96c")}</strong>.
            </p>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-signing-secret">{l10n("local.signing_secret_f5e81453")}</label></h2>
          <ul id="slack-signing-secret-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {l10n("local.open_slack_app_settings_30cfde1e")}{" "}<ExternalLink className="inline size-3" />
              </a> {l10n("local.and_choose_566c1f30")}{" "}<strong>{slackApp.appName}</strong>.
            </li>
            <li>{l10n("local.choose_c7f93783")}{" "}<strong>{l10n("local.basic_information_d094b334")}</strong></li>
            <li>{l10n("local.copy_and_paste_your_ef79f937")}{" "}<strong>{l10n("local.signing_secret_f5e81453")}</strong></li>
          </ul>
          <Input
            id="slack-signing-secret"
            type="password"
            placeholder={slackCredentialsSaved ? l10n("local.saved_leave_blank_to_keep_f1a85f6b") : undefined}
            value={credentials.signingSecret ?? ""}
            aria-invalid={slackSigningSecretHasTokenPrefix || undefined}
            aria-describedby={`slack-signing-secret-help${slackSigningSecretHasTokenPrefix ? " slack-signing-secret-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, signingSecret: event.target.value })}
          />
          {slackSigningSecretHasTokenPrefix && (
            <p id="slack-signing-secret-warning" role="alert" className="text-sm text-destructive">
              {l10n("local.use_the_3ffa30fb")}{" "}<strong>{l10n("local.signing_secret_f5e81453")}</strong>{l10n("local._not_an_app_or_bot_token_the_signing_secret_h_1c2ae082")}</p>
          )}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>
            {l10n("local.save_amp_exit_df456d65")}</Button>
          <Button
            className="ml-auto"
            disabled={
              (!repairing && !slackCredentialsSaved && (!slackBotToken || !credentials.signingSecret?.trim())) ||
              !endpoint.setup?.webhookUrl || !slackValidation.success ||
              saveSlackApp.isPending || saveSlackApp.isError || pending || slackSigningSecretHasTokenPrefix || slackBotTokenInvalid
            }
            onClick={() => continueWithSavedSlackCredentials
              ? onSlackCredentialsContinue()
              : onAction(repairing || slackCredentialsSaved ? "reconnect" : "configure", credentials)}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {continueWithSavedSlackCredentials ? l10n("local.continue_31fbef16") : repairing || slackCredentialsSaved ? l10n("local.reconnect_slack_app_dcbcb32c") : l10n("local.connect_slack_app_db03affc")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TryStep({
  endpointId,
  provider,
  agentName,
  botLabel,
  botUsername,
  photonAllocation,
  providerUrl,
  guestIsolationState,
  pending,
  onOpenAccess,
  onTest,
  onSaveExit,
}: {
  endpointId: string;
  provider: ChatProvider;
  agentName: string;
  botLabel?: string | null;
  botUsername?: string | null;
  photonAllocation?: "dedicated" | "shared";
  providerUrl?: string | null;
  guestIsolationState: "loading" | "enabled" | "disabled" | "unknown";
  pending: boolean;
  onOpenAccess: () => void;
  onTest: () => void;
  onSaveExit: () => void;
}) {
  const messageStatus = useQuery({
    queryKey: ["chat-endpoint-setup-test-status", endpointId],
    queryFn: () => chatEndpointsApi.setupTestStatus(endpointId),
    enabled: provider === "slack", refetchInterval: 1_500,
  });
  const [commandCopied, setCommandCopied] = useState(false);
  const [commandCopyError, setCommandCopyError] = useState(false);
  const principalsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const [numberCopied, setNumberCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const identities = principalsQuery.data ?? [];
  const unlinkedIdentities = identities.filter(
    (identity) => identity.status !== "linked",
  );
  const freshConversationInstruction =
    provider === "imessage-photon" ? "send a fresh message to your Photon number" : provider === "telegram"
      ? "start a fresh conversation with /new and send the test message again"
      : provider === "github"
        ? "start a new issue or pull request conversation and mention the agent again"
        : provider === "microsoft-teams"
          ? "start a new channel post and mention the agent again"
          : "send a new root mention to the agent";
  const identityGuidance = provider === "slack" ? null : provider === "imessage-photon" && principalsQuery.isSuccess && (identities.length === 0 || unlinkedIdentities.length > 0)
    ? { tone: "info" as const, title: l10n("local.link_your_messages_identity_6f8fceda"), body: "Send one message to discover your phone number or Apple account address, then link that exact identity in Access. Send a fresh request after linking; earlier messages do not start work." }
    : principalsQuery.isError
    ? {
        tone: "warning" as const,
        title: l10n("local.identity_readiness_could_not_be_checked_eadefdc5"),
        body: `Review Access before expecting an agent reply. After linking the account you are testing, ${freshConversationInstruction}.`,
      }
    : !principalsQuery.isSuccess || guestIsolationState === "loading"
      ? null
      : identities.length === 0
        ? guestIsolationState === "disabled"
          ? {
              tone: "warning" as const,
              title: l10n("local.link_the_account_you_re_testing_8e3ed069"),
              body:
                provider === "telegram"
                  ? "Tap Start in Telegram to discover your account; the welcome does not start an agent run. Link the account privately in Access, then return and send the test message."
                  : `Your first ${providerNames[provider]} message discovers the external account, but isolated guest work is off, so it cannot safely start ${agentName}. Send it once, link that account privately in Access, then ${freshConversationInstruction}.`,
            }
          : {
              tone: "info" as const,
              title: l10n("local.your_first_message_identifies_your_account_c6aabd33"),
              body:
                provider === "telegram"
                  ? "Tap Start in Telegram to discover your account. Until linked, it is a restricted guest and still needs a sandbox-backed isolated run; test that path intentionally, or link it in Access and then send the test message."
                  : `Until linked, the account is a restricted guest and still needs a sandbox-backed isolated run. Test that guest path intentionally, or link the account in Access and then ${freshConversationInstruction}.`,
            }
        : unlinkedIdentities.length > 0
          ? guestIsolationState === "disabled"
            ? {
                tone: "warning" as const,
                title: l10n("local.link_the_account_you_re_testing_8e3ed069"),
                body: `An observed external account is unlinked, and isolated guest work is off, so it cannot safely start ${agentName}. Link the account in Access, then ${freshConversationInstruction}; Paperclip does not replay the refused request.`,
              }
            : {
                tone: "info" as const,
                title: l10n("local.unlinked_identity_detected_f9a121ab"),
                body: `An unlinked account is a restricted guest and still needs a sandbox-backed isolated run. Test guest access intentionally, or link the account in Access and then ${freshConversationInstruction}.`,
              }
          : null;
  const providerBotUsername = botUsername?.replace(/^@/, "");
  const normalizedBotUsername =
    provider === "github"
      ? providerBotUsername?.replace(/\[bot\]$/i, "")
      : providerBotUsername;
  const botMention = normalizedBotUsername
    ? `@${normalizedBotUsername}`
    : (botLabel ?? agentName);
  const slackTestMessage = l10n("local.value_you_there_7f8577e4", {v0: (botMention.startsWith("@") ? botMention : `@${botMention}`)});
  const instructions =
    provider === "imessage-photon" ? [
      photonAllocation === "shared" ? "In your Photon project, enroll your sender in Users and find its assigned number in Get started. Send a fresh message to that number from Apple Messages." : `Open Apple Messages and send a fresh message to ${botUsername ?? botLabel ?? "the dedicated number"}.`,
      "Link the discovered sender to a Paperclip person in Access, then send a fresh request.",
      "Wait for the agent’s actual reply. Setup completes after that reply is delivered.",
      ...(photonAllocation === "shared" ? ["This Pro-compatible channel supports DMs only. Group messages cannot start work."] : ["For a group: add the number in Messages, send a message, enable the discovered group in Settings, then send a fresh request."]),
    ] : provider === "discord"
      ? [
          "Open a text channel where the bot is installed.",
          `Mention ${botMention} in a new root message.`,
          `Reply once inside ${agentName}'s new Discord thread.`,
        ]
      : provider === "telegram"
        ? [
            "Open the bot's private chat.",
            "Tap Start.",
            "Send “Help me test this”.",
          ]
        : provider === "github"
          ? [
              "Open an installed issue or pull request.",
              `Mention ${botMention} in a comment.`,
              "Add another comment to continue the same task.",
            ]
          : provider === "microsoft-teams"
            ? [
                "Open an installed channel and start a new post.",
                `Mention ${botMention} in the post.`,
                "Reply once beneath the post.",
              ]
            : [
                `Open a channel and invite ${botMention} if needed.`,
                `Mention ${botMention} in a new channel message.`,
                `Reply once in ${agentName}'s thread.`,
              ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {l10n("local.try_85d6c071")}{" "}{agentName} {l10n("local.in_58296753")}{" "}{providerNames[provider]}
        </h1>
        {provider !== "slack" && <p className="mt-1 text-sm text-muted-foreground">
          {l10n("local.complete_this_real_conversation_to_finish_set_fae6c477")}</p>}
      </div>
      {(!principalsQuery.isSuccess || guestIsolationState === "loading") &&
      !principalsQuery.isError ? (
        <p role="status" className="text-sm text-muted-foreground">
          {l10n("local.checking_identity_and_guest_readiness_572f064e")}</p>
      ) : null}
      {identityGuidance ? (
        <div
          role={identityGuidance.tone === "warning" ? "alert" : "status"}
          className={
            identityGuidance.tone === "warning"
              ? "rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
              : "rounded-lg border border-border bg-muted/30 p-4 text-sm"
          }
        >
          <h2 className="font-medium">{identityGuidance.title}</h2>
          <p className="mt-1 text-muted-foreground">{identityGuidance.body}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onOpenAccess}
          >
            {l10n("local.review_identity_access_31688e7e")}</Button>
        </div>
      ) : null}
      {provider === "imessage-photon" && botUsername && <div className="space-y-2"><Button variant="outline" onClick={() => { void copyTextToClipboard(botUsername).then(() => { setNumberCopied(true); setCopyError(null); }, () => setCopyError(l10n("local.could_not_copy_the_number_select_it_in_the_in_9bb7a51c"))); }}>{numberCopied ? l10n("local.number_copied_4bf3f054") : l10n("local.copy_value_3f3ebff4", {v0: (botUsername)})}</Button>{copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}</div>}
      {provider === "slack" ? (
        <>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>{l10n("local.open_a_channel_and_invite_8ef53ea7")}{" "}{botMention} {l10n("local.if_needed_80b41565")}</li>
            <li>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{slackTestMessage}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(slackTestMessage).then(() => { setCommandCopied(true); setCommandCopyError(false); }, () => setCommandCopyError(true));
                }}><Copy className="size-4" />{commandCopied ? l10n("local.copied_8d525e5f") : l10n("local.copy_message_457efe53")}</Button>
              </div>
              <p className="mt-2 text-muted-foreground">{l10n("local.select_the_bot_from_slack_s_mention_suggestio_dc432c93")}</p>
            </li>
            <li>{l10n("local.continue_the_conversation_in_the_thread_88bf894f")}</li>
          </ol>
          {commandCopyError && <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_apos_t_copy_select_and_copy_the_comman_740049f1")}</p>}
          {messageStatus.data?.messageReceivedAt ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-(--status-task-done)" />{l10n("local.received_your_slack_message_5fa101ce")}</p>
            : <p role={messageStatus.isError ? "alert" : "status"} className="text-sm text-muted-foreground">{messageStatus.isError ? l10n("local.couldn_t_check_for_your_message_you_can_still_cf8b24f3") : l10n("local.we_ll_check_for_your_message_automatically_th_e7c6f966")}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" className="text-muted-foreground" onClick={onSaveExit}>{l10n("local.save_amp_exit_df456d65")}</Button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" disabled={pending} onClick={onTest}>{l10n("local.skip_test_and_finish_d41475fa")}</Button>
              <Button disabled={pending} onClick={onTest}>{pending && <Loader2 className="size-4 animate-spin" />}{l10n("local.i_apos_ve_sent_the_test_message_70207c68")}</Button>
            </div>
          </div>
        </>
      ) : <>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => <li key={item}>{item}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {providerUrl && (
          <Button asChild variant="outline">
            <a href={providerUrl} target="_blank" rel="noopener noreferrer">
              {l10n("local.open_ed077f3d")}{" "}{providerNames[provider]} <ExternalLink />
            </a>
          </Button>
        )}
        <Button disabled={pending} onClick={onTest}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {l10n("local.i_ve_sent_the_test_message_a3c904fc")}</Button>
      </div>
      </>}
    </div>
  );
}
