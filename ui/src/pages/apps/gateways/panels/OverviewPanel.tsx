import { l10n } from "../../../../i18n";
import { Copy } from "lucide-react";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  activeTokenCount,
  allowedToolsLabel,
  expiringTokenCount,
  formatScope,
  type GatewayAppRow,
  gatewayAppDisplayName,
  isGatewayOn,
} from "../gateway-helpers";

export function OverviewPanel({
  gateway,
  profile,
  apps,
  agentNames,
  projectNames,
  toggleDisabled,
  onToggle,
}: {
  gateway: ToolMcpGatewayWithTokens;
  profile: ToolProfileWithDetails | undefined;
  apps: GatewayAppRow[];
  agentNames: Map<string, string>;
  projectNames: Map<string, string>;
  toggleDisabled: boolean;
  onToggle: () => void;
}) {
  const { pushToast } = useToast();
  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}${gateway.endpointPath}`;
  const active = activeTokenCount(gateway);
  const expiring = expiringTokenCount(gateway);
  const needsAttention = apps.filter((app) => app.needsAttention);
  const on = isGatewayOn(gateway);

  const snippet = [
    "{",
    '  "mcpServers": {',
    `    "paperclip-${gateway.displaySlug}": {`,
    `      "url": "${endpoint}",`,
    '      "headers": { "Authorization": "Bearer pcgw_•••_TOKEN" }',
    "    }",
    "  }",
    "}",
  ].join("\n");

  async function copy(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: l10n("local.copied_8d525e5f"), body: label, tone: "success" });
    } catch {
      pushToast({ title: l10n("local.copy_failed_5b50e7a6"), body: l10n("local.clipboard_access_is_unavailable_0899c211"), tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">{on ? l10n("local.on_13001175") : l10n("local.off_ca7981b4")}</div>
          <div className="mt-2">
            <ToggleSwitch checked={on} disabled={toggleDisabled} onCheckedChange={onToggle} aria-label={l10n("local.toggle_gateway_10748b99")} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{l10n("local.toggle_the_whole_gateway_off_here_a27be684")}</p>
        </div>
        <StatCard label={l10n("local.apps_89dd7484")}>
          {apps.length} {apps.length === 1 ? l10n("local.app_a172cedc") : l10n("local.apps_d56f6359")}
          {profile ? ` · ${allowedToolsLabel(profile)}` : ""}
        </StatCard>
        <StatCard label={l10n("local.tokens_a039dfb9")}>
          {active} {l10n("local.active_96879611")}{expiring > 0 ? (" " + l10n("local._value_expiring_2adf223a", {v0: (expiring)})) : ""}
        </StatCard>
        <StatCard label={l10n("local.health_55898449")}>
          {needsAttention.length === 0 ? l10n("local.all_green_f7836fc9") : l10n("local.value_needs_attention_325c6b11", {v0: (needsAttention.length)})}
        </StatCard>
      </div>

      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{l10n("local.who_can_use_it_82d9af69")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {l10n("local.anyone_holding_an_active_token_below_restrict_bd0cff72")}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip>{l10n("local.scope_4ecfdae5")}{" "}{formatScope(gateway, projectNames, agentNames)}</Chip>
          <Chip>{l10n("local.profile_f958f3ad")}{" "}{profile?.name ?? l10n("local.unavailable_ca184496")}</Chip>
          <Chip>{active} {l10n("local.active_96879611")}{" "}{active === 1 ? l10n("local.token_3c469e9d") : l10n("local.tokens_c51e455b")}</Chip>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">{l10n("local.apps_in_this_gateway_f79f9365")}</h3>
        {apps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {l10n("local.this_gateway_s_profile_doesn_t_include_any_ap_de912bf3")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {apps.map((app) => (
              <AppRow key={app.application.id} app={app} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{l10n("local.how_clients_connect_0b9f00af")}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(snippet, "Client config")}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {l10n("local.copy_e21f935f")}</Button>
        </div>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-xs text-muted-foreground">
          {snippet}
        </pre>
      </section>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

function AppRow({ app }: { app: GatewayAppRow }) {
  const href = app.connection
    ? `/apps/${app.connection.id}/permissions`
    : `/apps/app/${app.application.id}/permissions`;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <Link to={href} className="font-medium text-foreground hover:underline">
          {gatewayAppDisplayName(app)}
        </Link>
        <div className="text-xs text-muted-foreground">
          {app.toolCount} {app.toolCount === 1 ? l10n("local.tool_7c9bbe5e") : l10n("local.tools_f9d35d43")}
          {app.needsAttention && app.attentionReason ? ` · ${app.attentionReason}` : ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
          app.needsAttention
            ? "border-foreground bg-foreground text-background"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        {app.needsAttention ? l10n("local.needs_attention_c1ebc781") : l10n("local.healthy_7f1e323b")}
      </span>
    </li>
  );
}
