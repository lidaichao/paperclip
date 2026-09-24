import { l10n } from "../../../i18n";
import { SlackToolsSettings, SlackSearchAccess } from "./SlackToolSettings";
import { defaultSlackAppName } from "./slack-app-name";
import { ChatCommunicationInstructions } from "./ChatCommunicationInstructions";
import { SlackAvatarSettings } from "./SlackAvatarStep";
import { agentsApi } from "@/api/agents";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { GitHubBotManagement, GitHubReviews } from "./GitHubBotManagement";
import { EmailEndpointSettings } from "./EmailEndpointSetup";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Check,
  Activity as ActivityIcon,
  Copy,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  chatEndpointsApi,
  type ChatActivityItem,
  type ChatEndpoint,
  type ChatEndpointResource,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { AppLogo } from "../AppLogo";
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";

const tabs = ["settings", "access", "reviews", "conversations", "activity"] as const;
type ChatTab = (typeof tabs)[number];
const tabItems = tabs.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
}));
const providerNames: Record<ChatProvider, string> = {
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
};

const providerLifecycleGuidance: Record<
  ChatProvider,
  { reconnect: string; remove: string }
> = {
  agentmail: { reconnect: "Reconnect the same email inbox.", remove: "Disconnect email and retain task history." },
  slack: {
    reconnect:
      "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved Slack credentials. It does not uninstall the Slack app: the app remains installed, and its bot remains in channels, until you remove them in Slack.",
  },
  github: {
    reconnect:
      "Reconnect verifies this same App and installation, then updates its webhook URL, secret, and secure delivery settings. It does not reinstall the App or change repository access.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved App key and webhook secret. It does not uninstall the GitHub App: the App, its installations, and its webhook settings remain until you remove or update them on GitHub.",
  },
  discord: {
    reconnect:
      "Reconnect verifies this same Discord application and server installation. It does not add or remove the bot from the server.",
    remove:
      "Paperclip archives the endpoint, stops its Paperclip Gateway connection, and retires its saved bot token. It does not uninstall the bot: the bot remains in the Discord server, and the application remains in the Developer Portal, until you remove them there.",
  },
  "microsoft-teams": {
    reconnect:
      "Reconnect verifies this same Microsoft app, tenant, and bot identity. It does not upload or reinstall the Teams app.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved client secret. It does not uninstall the Teams app: the Entra app registration, Azure Bot, custom Teams app, and Teams installations remain until you remove them in Microsoft.",
  },
  "imessage-photon": {
    reconnect: "Reconnect verifies the same Photon project and line allocation, then recovers eligible missed messages.",
    remove: "Disconnect archives this channel and removes its saved secret. Your Photon project, number, subscription, and Messages history remain in Photon.",
  },
  telegram: {
    reconnect:
      "Reconnect verifies this same BotFather bot and automatically refreshes its Paperclip webhook and command menu.",
    remove:
      "Paperclip archives the endpoint and queues durable removal of its Telegram webhook and command menu. After Telegram confirms that cleanup, Paperclip retires the saved token. The BotFather bot and its chat memberships remain until you remove them in Telegram.",
  },
};

const activityKindLabels: Record<ChatActivityItem["kind"], string> = {
  delivery: l10n("local.inbound_delivery_9ac4ff22"),
  publication: l10n("local.outbound_publication_8dcc69d5"),
  action: l10n("local.provider_action_58176e7e"),
  health: l10n("local.connection_health_883d0e5c"),
  repair: l10n("local.connection_repair_2c777c5f"),
};

const replayableFailureStates = new Set(["failed"]);
// Provider callbacks do not necessarily emit a Board activity event. Refresh
// only mounted operational views, and stop polling when the browser is hidden.
const liveChatQueryOptions = {
  staleTime: 0,
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
} as const;

export function isReplayEligible(item: ChatActivityItem): boolean {
  if (
    item.fileTransfer ||
    !item.replayable ||
    !replayableFailureStates.has(item.status)
  ) {
    return false;
  }
  if (item.kind === "delivery") return item.status === "failed";
  return item.kind === "publication";
}

export function activityResolutionActions(item: ChatActivityItem) {
  const offered = item.resolutionActions ?? [];
  if (!item.fileTransfer) return offered;
  if (
    item.kind !== "publication" ||
    !Number.isSafeInteger(item.fileTransfer.version) ||
    item.fileTransfer.version < 1
  )
    return [];
  if (
    ![
      "consent_unknown",
      "upload_unknown",
      "file_info_unknown",
      "conflict",
    ].includes(item.fileTransfer.phase)
  )
    return [];
  // Only the file-info stage can use ordinary visible-delivery resolution.
  // Earlier consent/upload evidence must not be fabricated by these buttons.
  return item.fileTransfer.phase === "file_info_unknown"
    ? offered
    : offered.filter((action) => action === "cancel");
}

export function activityResolutionDescription(item: ChatActivityItem): string {
  const phase = item.fileTransfer?.phase;
  if (phase === "file_info_unknown")
    return l10n("local.the_file_upload_was_confirmed_but_its_teams_n_cf8db300");
  if (phase === "consent_unknown")
    return l10n("local.the_consent_card_may_have_reached_teams_file_267408f1");
  if (phase)
    return l10n("local.the_file_may_already_exist_in_onedrive_cancel_b4025bda");
  return l10n("local.paperclip_lost_confirmation_after_sending_che_1a7e11bb");
}

export function isResolutionEligible(item: ChatActivityItem): boolean {
  return (
    (item.kind === "publication" || item.kind === "action") &&
    item.status === "delivery_unknown" &&
    activityResolutionActions(item).length > 0
  );
}

export function isIndividuallyToggleableResource(
  provider: ChatProvider,
  resourceType: string,
): boolean {
  return !(
    provider === "microsoft-teams" &&
    (resourceType === "direct_message" || resourceType === "group_chat")
  );
}

function activityDetailLabel(item: ChatActivityItem): string {
  return replayableFailureStates.has(item.status) ? "Reason" : "Details";
}

export function connectionHealthPresentation(
  endpoint: Pick<ChatEndpoint, "status" | "healthMessage" | "lastError">,
) {
  // Health events outlive pause/removal. They are history, not lifecycle state.
  const lifecycleMessages = {
    draft: "Connection setup is incomplete.",
    verifying: "Connection verification is in progress.",
    paused: "Connection is paused. Resume it to receive new messages.",
    attention: "Connection needs attention.",
    revoked: "Connection access is revoked. Reconnect to verify access.",
    archived: "Connection has been removed from Paperclip.",
  };
  const lifecycleMessage =
    endpoint.status === "active" ? null : lifecycleMessages[endpoint.status];
  return {
    message: lifecycleMessage ?? endpoint.healthMessage ?? null,
    previousHealth: lifecycleMessage ? (endpoint.healthMessage ?? null) : null,
    error: endpoint.lastError ?? null,
    errorLabel: ["active", "attention", "revoked"].includes(endpoint.status)
      ? "Reason"
      : "Last reported error",
  };
}

export function ChatEndpointDetail() {
  const { endpointId = "", tab = "settings" } = useParams<{
    endpointId: string;
    tab?: string;
  }>();
  const activeTab = tabs.includes(tab as ChatTab) ? (tab as ChatTab) : null;
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const endpointQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId && activeTab),
    ...liveChatQueryOptions,
    refetchInterval:
      activeTab === "activity" || activeTab === "conversations"
        ? liveChatQueryOptions.refetchInterval
        : false,
  });
  const endpoint = endpointQuery.data;
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!endpoint || !activeTab) return;
    setBreadcrumbs([
      { label: l10n("local.connectors_c3d2e79e"), href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      {
        label:
          tabItems.find((item) => item.value === activeTab)?.label ??
          l10n("local.settings_74a883a0"),
      },
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, setBreadcrumbs]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {l10n("local.loading_connection_ca5b56e4")}</div>
    );
  if (endpointQuery.isError || !endpoint)
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">
          {l10n("local.this_chat_connection_could_not_be_loaded_89a518ff")}</p>
        <Button variant="outline" onClick={() => endpointQuery.refetch()}>
          {l10n("local.try_again_d8b8392e")}</Button>
      </div>
    );
  if (endpoint.provider === "agentmail") return <EmailEndpointSettings endpointId={endpoint.id} companyId={endpoint.companyId} />;
  const setupIncomplete =
    endpoint.setup?.step !== "complete" &&
    ["draft", "verifying", "attention", "revoked"].includes(endpoint.status);

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">
            {endpoint.assignedAgentName} {l10n("local.in_58296753")}{" "}{providerNames[endpoint.provider]}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {endpoint.providerAccountLabel ?? l10n("local.chat_connection_c3b314ec")}
          </p>
          {endpoint.provider === "imessage-photon" && endpoint.botExternalId && endpoint.photonAllocation !== "shared" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{endpoint.botExternalId}</span>
              <Button variant="ghost" size="sm" aria-label={l10n("local.copy_dedicated_number_0a559caf")} onClick={async () => {
                try { await copyTextToClipboard(endpoint.botExternalId!); setCopyStatus("Number copied"); }
                catch { setCopyStatus("Could not copy the number. Select and copy it manually."); }
              }}><Copy className="size-4" />{l10n("local.copy_number_f35c40de")}</Button>
              <span role="status" className="text-muted-foreground">{copyStatus}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {setupIncomplete ? (
            <Button
              variant="outline"
              onClick={() =>
                navigate(
                  `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`,
                )
              }
            >
              {l10n("local.continue_setup_c5702c19")}</Button>
          ) : null}
          {endpoint.status !== "active" && <StatusBadge status={endpoint.status} />}
        </div>
      </header>
      {activeTab === "settings" && (
        <>
{endpoint.provider === "github" && <GitHubBotManagement endpoint={endpoint} view="settings" />}
{endpoint.provider !== "github" && <Settings endpointId={endpoint.id} endpoint={endpoint} />}
</>
      )}
      {activeTab === "reviews" && endpoint.provider === "github" && <GitHubReviews endpointId={endpoint.id} />}
{activeTab === "access" && endpoint.provider === "github" && <GitHubBotManagement endpoint={endpoint} view="access" />}
{activeTab === "access" && endpoint.provider !== "github" && (
        <Access
          endpointId={endpoint.id}
          allowUnlinked={endpoint.allowUnlinkedPeople}
          endpoint={endpoint}
        />
      )}
      {activeTab === "conversations" && (
        <Conversations endpointId={endpoint.id} provider={endpoint.provider} />
      )}
      {activeTab === "activity" && (
        <Activity endpointId={endpoint.id} endpoint={endpoint} />
      )}
    </div>
  );
}

function Settings({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [messageCopied, setMessageCopied] = useState(false);
  const avatarAgent = useQuery({
    queryKey: queryKeys.agents.detail(endpoint.assignedAgentId),
    queryFn: () => agentsApi.get(endpoint.assignedAgentId, endpoint.companyId),
    enabled: endpoint.provider === "slack",
  });
  const mentionMessage = l10n("local._value_you_there_e7d90d4d", {v0: ((endpoint.botUsername ?? endpoint.botLabel ?? endpoint.assignedAgentName).replace(/^@/, ""))});
  const resourcesQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.resources(endpointId),
    queryFn: () => chatEndpointsApi.listResources(endpointId),
  });
  const saveResources = useMutation({
    mutationFn: (resource: Pick<ChatEndpointResource, "id" | "enabled">) =>
      chatEndpointsApi.updateResources(endpointId, [resource]),
    onSuccess: (resources) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.resources(endpointId),
        resources,
      ),
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_update_destination_f23b38cd"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const updateEndpoint = useMutation({
    mutationFn: chatEndpointsApi.update.bind(null, endpointId),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_update_settings_522457db"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const resources = resourcesQuery.data ?? [];
  const destinationResources = resources.filter((resource) =>
    isIndividuallyToggleableResource(endpoint.provider, resource.type),
  );
  const toggleResource = (resource: ChatEndpointResource, enabled: boolean) =>
    // A cached inventory must not overwrite another operator's unrelated edits.
    saveResources.mutate({ id: resource.id, enabled });
  return (
    <section className="max-w-3xl space-y-7">
      {endpoint.provider === "imessage-photon" && <p className="text-sm text-muted-foreground">{endpoint.photonAllocation === "shared" ? l10n("local.shared_photon_project_direct_messages_only_en_bdbec108") : l10n("local.enable_each_group_individually_agent_replies_ade4297c")}</p>}
      {endpoint.provider === "slack" && (
        <div className="space-y-2 text-sm">
          <h2 className="text-lg font-semibold">{l10n("local.chat_in_slack_4d7c0afa")}</h2>
          <p>{l10n("local.invite_the_bot_to_a_channel_then_mention_it_t_ec7e38b6")}</p>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <code>{mentionMessage}</code>
            <Button size="icon" variant="ghost" aria-label={messageCopied ? l10n("local.message_copied_ed112278") : l10n("local.copy_message_457efe53")} onClick={() => {
              void copyTextToClipboard(mentionMessage).then(() => setMessageCopied(true), () => pushToast({ title: l10n("local.couldn_t_copy_the_message_31ae0785"), body: l10n("local.select_and_copy_it_manually_0edc1f0c"), tone: "error" }));
            }}>{messageCopied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
          </div>
        </div>
      )}
      {endpoint.provider === "slack" && (
        avatarAgent.isPending ? <p role="status" className="text-sm text-muted-foreground">{l10n("local.loading_agent_avatar_0a92b683")}</p>
          : avatarAgent.isError ? <p role="alert" className="text-sm text-destructive">{l10n("local.couldn_t_load_the_agent_s_avatar_984c743c")}{" "}<button className="underline" onClick={() => void avatarAgent.refetch()}>{l10n("local.try_again_d8b8392e")}</button></p>
          : <SlackAvatarSettings
              agentName={avatarAgent.data?.name ?? endpoint.assignedAgentName}
              appName={endpoint.setup?.slackApp?.appName ?? defaultSlackAppName(avatarAgent.data?.name ?? endpoint.assignedAgentName)}
              avatarUrl={agentAvatarUrl(resolveAgentAppearance(avatarAgent.data?.appearance, endpoint.assignedAgentId), 512, 1, "rest")}
            />
      )}
      {endpoint.provider === "slack" && <SlackToolsSettings companyId={endpoint.companyId} endpointId={endpointId} connectionId={endpoint.connectionId} />}
      {endpoint.provider === "slack" && <ChatCommunicationInstructions
        key={endpoint.id}
        value={endpoint.communicationInstructions ?? ""}
        onSave={async (communicationInstructions) => {
          const next = await chatEndpointsApi.update(endpointId, { communicationInstructions });
          queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpointId), next);
        }}
      />}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{l10n("local.telegram_group_command_a2c515a4")}</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">
              {l10n("local.telegram_apos_s_default_privacy_mode_does_not_f763116f")}</p>
          </div>
        </div>
      )}
      <div>
        <h2 className="text-lg font-semibold">{l10n("local.where_this_agent_can_work_b3257820")}</h2>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{endpoint.provider === "slack" ? l10n("local.allowed_channels_e57f04d7") : l10n("local.destinations_72eb63f0")}</h3>
        {resourcesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{l10n("local.loading_destinations_b78eda5f")}</p>
        ) : destinationResources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {l10n("local.no_provider_destinations_have_been_discovered_44663dff")}</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {destinationResources.map((resource) => (
              <div key={resource.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {resource.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {resource.availability === "available"
                      ? (resource.detail ?? resource.type)
                      : l10n("local.unavailable_at_the_provider_b0c0c15c")}
                  </p>
                  {resource.participants?.length ? <p className="mt-1 break-words text-xs text-muted-foreground">{l10n("local.participants_92ac4b95")}{" "}{resource.participants.join(", ")}</p> : null}
                </div>
                <ToggleSwitch
                  aria-label={l10n("local.enable_value_e24182f2", {v0: (resource.label)})}
                  checked={resource.enabled}
                  disabled={
                    endpoint.photonAllocation === "shared" ||
                    resource.availability !== "available" ||
                    saveResources.isPending
                  }
                  onCheckedChange={(enabled) =>
                    toggleResource(resource, enabled)
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{l10n("local.private_conversations_65f20ef7")}</h3>
          <SettingToggle
            label={l10n("local.allow_direct_messages_e2f7f14d")}
            detail={
              endpoint.provider === "discord"
                ? l10n("local.people_must_also_enable_direct_messages_in_th_f78465c5")
                : l10n("local.people_can_start_or_continue_a_task_in_a_dire_4464bb78")
            }
            checked={endpoint.allowDirectMessages ?? false}
            pending={updateEndpoint.isPending}
            onChange={(allowDirectMessages) =>
              updateEndpoint.mutate({ allowDirectMessages })
            }
          />
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label={l10n("local.allow_group_chats_5fabb08f")}
              detail={l10n("local.the_bot_may_participate_in_group_chats_where_a815e4ff")}
              checked={endpoint.allowGroupChats ?? false}
              pending={updateEndpoint.isPending}
              onChange={(allowGroupChats) =>
                updateEndpoint.mutate({ allowGroupChats })
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

function SettingToggle({
  label,
  detail,
  checked,
  pending,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-y border-border py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function Access({
  endpointId,
  allowUnlinked,
  endpoint,
}: {
  endpointId: string;
  allowUnlinked: boolean;
  endpoint: ChatEndpoint;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const [joinCommandCopied, setJoinCommandCopied] = useState(false);
  const joinCommand = `${endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"} connect`;
  const linksQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const updatePolicy = useMutation({
    mutationFn: (value: boolean) =>
      chatEndpointsApi.update(endpointId, { allowUnlinkedPeople: value }),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) => pushToast({ title: l10n("local.couldn_t_update_access_14797075"), body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"), tone: "error" }),
  });
  const createIntent = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.createLinkIntent(endpointId, principalId),
    onSuccess: ({ confirmationUrl }) => {
      setConfirmationUrl(
        new URL(confirmationUrl, window.location.origin).toString(),
      );
      pushToast({
        title: l10n("local.private_identity_link_url_created_ec92b406"),
        body: l10n("local.send_it_only_to_the_person_whose_provider_ide_c0b6f302"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_create_identity_link_619b3ffe"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.principals(endpointId),
      }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div>
        <h2 className="text-lg font-semibold">{l10n("local.external_identity_access_742bdfc3")}</h2>
      </div>
      {endpoint.provider === "slack" && <SlackSearchAccess companyId={endpoint.companyId} endpointId={endpointId} />}
      {endpoint.provider === "slack" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{l10n("local.invite_others_to_connect_their_slack_accounts_a7e76666")}</h3>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              {l10n("local.ask_them_to_send_this_command_in_your_slack_w_7fb4fb01")}<div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{joinCommand}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(joinCommand).then(() => setJoinCommandCopied(true), () => pushToast({ title: l10n("local.couldn_t_copy_the_command_f3a00b9a"), body: l10n("local.select_and_copy_it_manually_0edc1f0c"), tone: "error" }));
                }}><Copy className="size-4" />{joinCommandCopied ? l10n("local.copied_8d525e5f") : l10n("local.copy_command_9a01feec")}</Button>
              </div>
            </li>
            <li>{l10n("local.open_the_private_link_from_the_bot_sign_into_16dc3980")}</li>
            <li>{l10n("local.if_they_aren_t_a_member_of_this_organization_bb882d5f")}{" "}<strong>{l10n("local.request_access_b06f1662")}</strong>{l10n("local._an_admin_must_approve_their_request_before_t_3ad41e92")}</li>
          </ol>
          <p className="text-sm text-muted-foreground">{l10n("local.each_person_links_their_own_account_and_uses_3bc0efc6")}</p>
        </div>
      )}
      <SettingToggle
        label={l10n("local.allow_unlinked_people_b61e32fc")}
        detail={l10n("local.they_are_restricted_guests_their_tasks_run_on_89e4d44d")}
        checked={allowUnlinked}
        pending={updatePolicy.isPending}
        onChange={(value) => updatePolicy.mutate(value)}
      />
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">{l10n("local.private_confirmation_link_a3503780")}</p>
          <p className="break-all text-xs text-muted-foreground">
            {confirmationUrl}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void copyTextToClipboard(confirmationUrl).then(
                () =>
                  pushToast({
                    title: l10n("local.confirmation_link_copied_715f6111"),
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: l10n("local.couldn_t_copy_the_link_6bad7bdb"),
                    body: l10n("local.select_and_copy_it_manually_0edc1f0c"),
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />
            {l10n("local.copy_link_dbf362d4")}</Button>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{l10n("local.identity_links_d0150db9")}</h3>
        {links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {l10n("local.external_people_appear_here_after_they_messag_9c471103")}</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {links.map((link) => (
              <div
                key={link.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{link.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {link.paperclipUserLabel
                      ? l10n("local.linked_to_value_0ade31da", {v0: (link.paperclipUserLabel)})
                      : (link.externalDetail ?? l10n("local.not_linked_1e31d959"))}
                  </p>
                </div>
                {link.status === "linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.principalId)}
                  >
                    <Unlink />
                    {l10n("local.revoke_87e6d00b")}</Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => createIntent.mutate(link.principalId)}
                  >
                    {l10n("local.create_private_link_d972bf78")}</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Conversations({
  endpointId,
  provider,
}: {
  endpointId: string;
  provider: ChatProvider;
}) {
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
    ...liveChatQueryOptions,
  });
  const rows = query.data ?? [];
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{l10n("local.conversations_1d432f58")}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {l10n("local.no_conversations_yet_address_the_agent_in_an_1c773a3d")}</p>
      ) : (
        <ul aria-label={l10n("local.conversations_1d432f58")} className="divide-y divide-border overflow-x-auto border-y border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-xl items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-accent/50">
              <AppLogo name={providerNames[provider]} brandKey={provider} compact className="size-5! rounded-sm bg-transparent" />
              <div className="flex min-w-0 max-w-56 items-center gap-2">
                <span className="truncate font-medium" title={row.externalLabel}>{row.externalLabel}</span>
                {row.externalUrl && <a href={row.externalUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">{l10n("local.open_ed077f3d")}{" "}{providerNames[provider]}<ExternalLink className="size-3" /></a>}
              </div>
              <span aria-hidden="true" className="text-muted-foreground">·</span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate" title={row.issueTitle ?? undefined}>{row.issueTitle ?? l10n("local.waiting_for_task_2d3edb93")}</span>
                {row.issueId && <Link to={`/issues/${row.issueId}`} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">{l10n("local.open_task_6b5c9394")}<ExternalLink className="size-3" /></Link>}
              </div>
              <span className="hidden shrink-0 text-xs text-muted-foreground xl:inline">{row.issueIdentifier}</span>
              {row.state !== "active" && <StatusBadge status={row.state} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Activity({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resolutionItem, setResolutionItem] = useState<ChatActivityItem | null>(
    null,
  );
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => setCursors([undefined]), [endpointId]);
  const query = useQuery({
    queryKey: [...queryKeys.chatEndpoints.activity(endpointId), cursor ?? null],
    queryFn: () => chatEndpointsApi.listActivityPage(endpointId, cursor),
    ...liveChatQueryOptions,
    refetchInterval: cursor ? false : liveChatQueryOptions.refetchInterval,
  });
  const replay = useMutation({
    mutationFn: (item: ChatActivityItem) =>
      item.kind === "publication"
        ? chatEndpointsApi.replayPublication(endpointId, item.id)
        : chatEndpointsApi.replayDelivery(endpointId, item.id),
    onSuccess: async (_result, item) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title: l10n("local.value_queued_for_replay_5eb4f5e1", {v0: (item.kind === "publication" ? "Publication" : "Delivery")}),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_replay_activity_e3eb4a33"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const resolveActivity = useMutation({
    mutationFn: (input: {
      item: ChatActivityItem;
      action: "mark_delivered" | "retry_anyway" | "cancel";
    }) => {
      if (input.item.kind === "publication") {
        return chatEndpointsApi.resolvePublication(
          endpointId,
          input.item.id,
          input.action,
          input.item.fileTransfer
            ? {
                phase: input.item.fileTransfer.phase,
                version: input.item.fileTransfer.version,
              }
            : undefined,
        );
      }
      return chatEndpointsApi.resolveAction(
        endpointId,
        input.item.id,
        input.action,
      );
    },
    onSuccess: async (_result, input) => {
      setResolutionItem(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title:
          input.item.actionType === "slash_task_start" &&
          input.action === "retry_anyway"
            ? l10n("local.task_start_retried_bd8d39d8")
            : input.item.actionType === "slash_task_start"
              ? l10n("local.task_start_cancelled_7153d36a")
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? l10n("local.provider_reply_marked_delivered_44de899e")
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? l10n("local.provider_reply_retried_989eb240")
                  : input.item.actionType === "provider_effect"
                    ? l10n("local.provider_reply_cancelled_91ea1f91")
                    : input.action === "mark_delivered"
                      ? l10n("local.publication_marked_delivered_ac3242eb")
                      : input.action === "retry_anyway"
                        ? l10n("local.publication_queued_for_retry_f9100c1e")
                        : l10n("local.publication_cancelled_67f02b0a"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_resolve_activity_fce6f023"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const lifecycle = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      chatEndpointsApi.setup(endpointId, { action }),
    onSuccess: async (next, action) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(next.companyId),
      });
      if (action === "remove") {
        navigate("/apps");
        return;
      }
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      );
      pushToast({
        title: action === "pause" ? l10n("local.connection_paused_8870a331") : l10n("local.connection_resumed_e1032417"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: l10n("local.couldn_t_update_connection_a99084d8"),
        body: error instanceof Error ? error.message : l10n("local.try_again_a0c2cc13"),
        tone: "error",
      }),
  });
  const rows = query.data?.items ?? [];
  const { status } = endpoint;
  const health = connectionHealthPresentation(endpoint);
  const lifecycleAction = lifecycle.variables;
  const callbackSurfaceRows = endpoint.setup?.callbackSurfaces
    ? ([
        ["Events API", endpoint.setup.callbackSurfaces.events],
        ["Interactivity", endpoint.setup.callbackSurfaces.interactivity],
        ["Slash command", endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">{l10n("local.connection_activity_52520f2f")}</h2>
      {((status !== "active" && health.message) || health.error) && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${status === "attention" || status === "revoked" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-muted/30 text-foreground"}`}
        >
          {(status === "attention" || status === "revoked") && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            {health.message && <p>{health.message}</p>}
            {health.previousHealth && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">{l10n("local.last_reported_health_1b2bf64e")}</span>{" "}
                {health.previousHealth}
              </p>
            )}
            {health.error && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">{health.errorLabel}:</span>{" "}
                {health.error}
              </p>
            )}
          </div>
        </div>
      )}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium chat-connection-health-summary">
          <span>{l10n("local.connection_health_and_controls_de3243d4")}</span>
          <span className="flex items-center gap-2">
            {endpoint.setup?.callbacksNeedUpdate && <span className="text-xs text-(--status-task-blocked)">{l10n("local.callback_urls_need_attention_081c6ae8")}</span>}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-5 border-t border-border p-4">
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className="space-y-3 text-sm"
        >
          <p className="font-medium">{l10n("local.slack_callback_health_035e2b30")}</p>
          <p className="text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? l10n("local.slack_callback_urls_need_an_update_save_the_c_05d99d55")
              : l10n("local.paperclip_records_each_callback_surface_indep_b49180a2")}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? l10n("local.current_e0d1b682")
                    : surface.status === "stale"
                      ? l10n("local.stale_url_b095f498")
                      : l10n("local.not_observed_1d3efcd6")}
                </p>
                {surface.observedAt && (
                  <p className="text-xs text-muted-foreground">
                    {l10n("local.last_observed_ff418896")}{" "}
                    <time
                      dateTime={surface.observedAt}
                      title={surface.observedAt}
                      className="font-mono"
                    >
                      {formatDateTime(surface.observedAt, {
                        includeSeconds: true,
                      })}
                    </time>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {status !== "archived" && (
        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            {status === "active" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("pause")}
              >
                {lifecycle.isPending && lifecycleAction === "pause" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pause />
                )}
                {l10n("local.pause_858e4ba7")}</Button>
            )}
            {status === "paused" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("resume")}
              >
                {lifecycle.isPending && lifecycleAction === "resume" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                {l10n("local.resume_d640c742")}</Button>
            )}
            {[
              "active",
              "paused",
              "attention",
              "revoked",
              "draft",
              "verifying",
            ].includes(status) && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() =>
                  navigate(
                    `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}${status === "draft" || status === "verifying" ? "" : "&reconnect=1"}`,
                  )
                }
              >
                <RefreshCw />
                {status === "draft" || status === "verifying"
                  ? l10n("local.finish_setup_bc01ae77")
                  : l10n("local.reconnect_bf8a9eab")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              {l10n("local.remove_connection_e9e9e26c")}</Button>
          </div>
          {status !== "draft" && status !== "verifying" && (
            <p className="text-xs text-muted-foreground">
              {providerLifecycleGuidance[endpoint.provider].reconnect}
            </p>
          )}
        </div>
      )}
        </div>
      </details>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {l10n("local.recent_activity_6cb44b56")}</h3>
        <div className="divide-y divide-border border-y border-border">
          {query.isLoading && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {l10n("local.loading_activity_a389c395")}</div>
          )}
          {query.isError && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm text-destructive" role="alert">
                {l10n("local.connection_activity_could_not_be_loaded_65047eb0")}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => query.refetch()}
              >
                {l10n("local.try_again_d8b8392e")}</Button>
            </div>
          )}
          {!query.isLoading &&
            !query.isError &&
            rows.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 px-2 py-3 transition-colors hover:bg-accent/50"
              >
                <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
                  {item.kind === "delivery" ? <ArrowDownLeft className="size-4" /> : item.kind === "publication" ? <ArrowUpRight className="size-4" /> : <ActivityIcon className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 text-sm font-medium">{item.summary}</p>
                    <StatusBadge status={item.status} />
                    <time dateTime={item.createdAt} title={item.createdAt} className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(item.createdAt, { includeSeconds: true })}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{activityKindLabels[item.kind]}</p>
                  {item.fileTransfer && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.fileTransfer.filename} —{" "}
                      {item.fileTransfer.phase.replaceAll("_", " ")}
                    </p>
                  )}
                  {item.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {activityDetailLabel(item)}:
                      </span>{" "}
                      {item.detail}
                    </p>
                  )}
                </div>
                {isReplayEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={l10n("local.replay_failed_value_c4981b33", {v0: (item.kind)})}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {l10n("local.replay_c8dae637")}</Button>
                )}
                {isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >
                    {l10n("local.resolve_c8f193b3")}</Button>
                )}
              </div>
            ))}
          {!query.isLoading && !query.isError && rows.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              {l10n("local.no_connection_activity_yet_3ba50fcd")}</p>
          )}
        </div>
      </div>
      <nav aria-label={l10n("local.activity_pagination_02756493")} className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{l10n("local.page_0a30a815")}{" "}{cursors.length}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((pages) => pages.slice(0, -1))}>{l10n("local.previous_a57b08a4")}</Button>
          <Button size="sm" variant="outline" disabled={!query.data?.nextCursor || query.isFetching || query.isError} onClick={() => { if (query.data?.nextCursor) setCursors((pages) => [...pages, query.data.nextCursor!]); }}>{l10n("local.next_1ff57a29")}</Button>
        </div>
      </nav>
      <AlertDialog
        open={resolutionItem !== null}
        onOpenChange={(open) => !open && setResolutionItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resolutionItem?.actionType === "slash_task_start"
                ? l10n("local.resolve_unconfirmed_task_start_24ac2c20")
                : resolutionItem?.actionType === "provider_effect"
                  ? l10n("local.resolve_unconfirmed_provider_reply_51da03a7")
                  : l10n("local.resolve_unconfirmed_delivery_a1666eb3")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? l10n("local.paperclip_lost_confirmation_after_asking_slac_b30cde4a")
                : resolutionItem?.actionType === "provider_effect"
                  ? l10n("local.paperclip_lost_confirmation_after_sending_thi_cfdcf622")
                  : resolutionItem
                    ? activityResolutionDescription(resolutionItem)
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>
              {l10n("local.keep_unresolved_0de1079d")}</AlertDialogCancel>
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes("cancel") && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "cancel",
                    })
                  }
                >
                  {resolutionItem.actionType === "slash_task_start"
                    ? l10n("local.cancel_task_start_a2029d82")
                    : resolutionItem.actionType === "provider_effect"
                      ? l10n("local.cancel_provider_reply_7cb71ee3")
                      : resolutionItem.fileTransfer
                        ? l10n("local.cancel_file_transfer_ad463f14")
                        : l10n("local.cancel_publication_43d32931")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "retry_anyway",
              ) && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "retry_anyway",
                    })
                  }
                >
                  {resolutionItem.fileTransfer
                    ? l10n("local.retry_file_notification_a2a1662f")
                    : l10n("local.retry_anyway_de469560")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "mark_delivered",
              ) && (
                <AlertDialogAction
                  disabled={resolveActivity.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    if (resolutionItem) {
                      resolveActivity.mutate({
                        item: resolutionItem,
                        action: "mark_delivered",
                      });
                    }
                  }}
                >
                  {l10n("local.mark_delivered_3a47653e")}</AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{l10n("local.remove_this_connection_e91e08c0")}</AlertDialogTitle>
            <AlertDialogDescription>
              {endpoint.assignedAgentName} {l10n("local.will_stop_receiving_new_work_from_b875c1b5")}{` ${providerNames[endpoint.provider]}`}{l10n("local._existing_paperclip_tasks_remain_available_74fb6a98")}{" "}
              {providerLifecycleGuidance[endpoint.provider].remove}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{l10n("local.cancel_19766ed6")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {l10n("local.remove_connection_e9e9e26c")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
