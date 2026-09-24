import { l10n } from "../../../i18n";
import { Link } from "react-router-dom";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  SlackSearchStatus,
  SlackToolCapabilities,
} from "@paperclipai/shared";
import { slackToolsApi } from "@/api/slackTools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SlackCapabilitiesView({
  capabilities,
  error,
}: {
  capabilities?: SlackToolCapabilities;
  error?: string;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{l10n("local.slack_tools_192c2528")}</h3>
      <p className="text-sm">
        {l10n("local.invite_the_bot_to_a_channel_then_ask_it_to_re_b6286a43")}</p>
      <p className="text-sm text-muted-foreground">
        {l10n("local.the_agent_can_read_channels_shared_by_the_bot_deea995a")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!capabilities && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {l10n("local.checking_slack_permissions_d85521cb")}</p>
      )}
      {capabilities && (
        <>
          <ul className="space-y-2 text-sm">
            <li>
              {l10n("local.read_channels_threads_messages_files_and_sour_9ab0409c")}</li>
            <li>
              {l10n("local.send_messages_and_files_react_pin_bookmark_an_64d0b04e")}</li>
            <li>
              {l10n("local.creating_channels_inviting_people_and_destruc_a8caa471")}</li>
          </ul>
          {capabilities.missingScopes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">
                {l10n("local.add_permissions_to_unlock_more_tools_a716eb3e")}</p>
              <p className="text-sm">
                {l10n("local.your_existing_connection_still_works_in_090a1069")}{" "}
                <a
                  className="underline underline-offset-4"
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                >
                  {l10n("local.slack_app_settings_d811efd5")}</a>
                {l10n("local._choose_your_app_open_oauth_amp_permissions_a_33f91f01")}</p>
              <p className="text-xs font-mono break-words">
                {capabilities.missingScopes.join(", ")}
              </p>
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {l10n("local.tool_permissions_and_availability_c1e8c898")}</summary>
            <ul className="mt-3 divide-y divide-border">
              {capabilities.tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span>
                    {tool.name.replace(/^slack_/, "").replaceAll("_", " ")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tool.available === false
                      ? l10n("local.needs_permissions_fa8dc2e4")
                      : tool.available === null
                        ? l10n("local.not_verified_15133907")
                        : tool.risk === "approval"
                          ? l10n("local.ask_first_4a9e8cf3")
                          : l10n("local.available_e6744473")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-muted-foreground">
            {l10n("local.slack_plan_membership_and_per_action_permissi_1b5d79b2")}</p>
        </>
      )}
    </section>
  );
}

export function SlackSearchView({
  status,
  onConnect,
  onDisconnect,
  onConfigure,
}: {
  status: SlackSearchStatus;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onConfigure: (input: {
    clientId: string;
    clientSecret: string;
  }) => Promise<void>;
}) {
  const id = useId();
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to update Slack search",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{l10n("local.your_slack_search_access_c49a014b")}</h3>
      <p className="text-sm text-muted-foreground">
        {l10n("local.optional_personal_authorization_enables_priva_5d5b66af")}</p>
      {!status.nativeSearchAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {status.limitation}
        </p>
      )}
      {status.connected ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{l10n("local.slack_search_connected_7ce7998d")}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void perform(onDisconnect)}
          >
            {l10n("local.disconnect_search_1ae29196")}</Button>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !status.configured}
          onClick={() => void perform(onConnect)}
        >
          {l10n("local.connect_slack_search_e8b57c08")}</Button>
      )}
      {!status.configured && (
        <p className="text-sm text-muted-foreground">
          {l10n("local.a_connection_manager_needs_to_configure_your_c83c4076")}</p>
      )}
      {status.canConfigure && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {l10n("local.oauth_app_configuration_for_connection_manage_ee4c0f2a")}</summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await onConfigure({ clientId, clientSecret });
                setClientSecret("");
              });
            }}
          >
            <p className="text-sm">
              {l10n("local.in_slack_app_settings_add_this_redirect_url_u_4b664522")}{" "}<code>search:read.public</code>,{" "}
              <code>search:read.private</code> {l10n("local.and_6201111b")}{" "}
              <code>search:read.files</code>{l10n("local._find_client_id_and_client_secret_under_basic_43c6d5ed")}</p>
            <p className="text-xs font-mono break-all">
              {status.redirectUri ?? l10n("local.configure_a_public_https_url_first_a5716c99")}
            </p>
            <div className="space-y-2">
              <label htmlFor={`${id}-client`}>{l10n("local.client_id_8726db01")}</label>
              <Input
                id={`${id}-client`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-secret`}>{l10n("local.client_secret_ae21cf6d")}</label>
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              <Button
                type="submit"
                size="sm"
                disabled={pending || !clientId || !clientSecret}
              >
                {l10n("local.save_oauth_configuration_37b14848")}</Button>
            </div>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
export function SlackToolsSettings({
  companyId,
  endpointId,
  connectionId,
}: {
  companyId: string;
  endpointId: string;
  connectionId?: string | null;
}) {
  const query = useQuery({
    queryKey: ["slack-capabilities", companyId, endpointId],
    queryFn: () => slackToolsApi.capabilities(companyId, endpointId),
    staleTime: 60_000,
  });
  return (
    <div className="space-y-3">
      <SlackCapabilitiesView
        capabilities={query.data}
        error={query.error?.message}
      />
      {connectionId && (
        <Link
          className="text-sm underline underline-offset-4"
          to={`/apps/${connectionId}/permissions`}
        >
          {l10n("local.manage_action_permissions_94d9b7f3")}</Link>
      )}
    </div>
  );
}
export function SlackSearchAccess({
  companyId,
  endpointId,
}: {
  companyId: string;
  endpointId: string;
}) {
  const query = useQuery({
    queryKey: ["slack-search", companyId, endpointId],
    queryFn: () => slackToolsApi.search(companyId, endpointId),
  });
  if (query.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error.message}
      </p>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {l10n("local.loading_search_access_20c6a028")}</p>
    );
  return (
    <SlackSearchView
      status={query.data}
      onConnect={async () => {
        const result = await slackToolsApi.connect(companyId, endpointId);
        window.location.assign(result.url);
      }}
      onDisconnect={async () => {
        await slackToolsApi.disconnect(companyId, endpointId);
        await query.refetch();
      }}
      onConfigure={async (input) => {
        await slackToolsApi.configure(companyId, endpointId, input);
        await query.refetch();
      }}
    />
  );
}
