import { l10n } from "../../../i18n";
/** Presentation metadata only. Each provider will have its own catalog entry and connection. */
export type RemoteMcpProviderId = "zapier" | "arcade" | "composio" | "executor";

export interface RemoteMcpProvider {
  id: RemoteMcpProviderId;
  name: string;
  description: string;
  instructions: string[];
  setupUrl: string;
  dashboardUrl: string;
  defaultUrl: string;
  placeholder: string;
  urlHelp: string;
  authHelp: string;
  supportsBrowserAuth: boolean;
}

export const remoteMcpProviders: Record<RemoteMcpProviderId, RemoteMcpProvider> = {
  zapier: {
    id: "zapier", name: "Zapier", supportsBrowserAuth: false,
    description: l10n("local.use_the_apps_and_actions_on_your_zapier_mcp_s_81a62210"),
    instructions: [
      l10n("local.zapier_create_mcp_server_0c910101"),
      l10n("local.zapier_connect_apps_actions_0c910102"),
      l10n("local.zapier_generate_token_copy_address_0c910103"),
    ],
    setupUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    dashboardUrl: "https://mcp.zapier.com",
    defaultUrl: "", placeholder: l10n("local.paste_the_full_url_from_zapier_2b71b0cf"),
    urlHelp: l10n("local.zapier_server_address_secret_token_0c910104"),
    authHelp: l10n("local.zapier_separate_bearer_token_0c910105", {
      v0: "https://mcp.zapier.com/api/v1/connect",
    }),
  },
  arcade: {
    id: "arcade", name: "Arcade", supportsBrowserAuth: true,
    description: l10n("local.use_the_tools_exposed_by_your_arcade_gateway_081210c3"),
    instructions: [
      l10n("local.arcade_create_gateway_tools_0c910106"),
      l10n("local.arcade_choose_user_source_address_0c910107"),
      l10n("local.arcade_paste_address_sign_in_0c910108"),
    ],
    setupUrl: "https://docs.arcade.dev/en/operate/governance/mcp-gateways",
    dashboardUrl: "https://app.arcade.dev",
    defaultUrl: "", placeholder: "https://api.arcade.dev/mcp/your-gateway",
    urlHelp: l10n("local.arcade_copy_gateway_address_0c910109"),
    authHelp: l10n("local.arcade_headers_bearer_user_id_0c910110"),
  },
  composio: {
    id: "composio", name: "Composio", supportsBrowserAuth: true,
    description: l10n("local.discover_and_use_your_apps_through_composio_c_8b7285b9"),
    instructions: [
      l10n("local.composio_connect_sign_in_0c910111"),
      l10n("local.composio_connect_apps_0c910112"),
    ],
    setupUrl: "https://docs.composio.dev/docs/composio-connect",
    dashboardUrl: "https://dashboard.composio.dev",
    defaultUrl: "https://connect.composio.dev/mcp", placeholder: "https://connect.composio.dev/mcp",
    urlHelp: l10n("local.composio_prefilled_external_session_0c910113"),
    authHelp: l10n("local.composio_session_address_headers_0c910114"),
  },
  executor: {
    id: "executor", name: "Executor", supportsBrowserAuth: true,
    description: l10n("local.run_tools_through_your_executor_workspace_b7bfda4a"),
    instructions: [
      l10n("local.executor_connect_apps_policies_0c910115"),
      l10n("local.executor_copy_agent_address_0c910116"),
      l10n("local.executor_paste_sign_in_0c910117"),
    ],
    setupUrl: "https://executor.sh/docs/mcp-proxy",
    dashboardUrl: "https://executor.sh",
    defaultUrl: "", placeholder: l10n("local.paste_your_executor_workspace_mcp_url_aa2d8df3"),
    urlHelp: l10n("local.executor_workspace_address_reachable_alice_0c910118"),
    authHelp: l10n("local.executor_keep_options_user_key_0c910119"),
  },
};
