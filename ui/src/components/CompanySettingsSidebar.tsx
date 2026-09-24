import { l10n } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Cpu,
  Download,
  FlaskConical,
  KeyRound,
  MonitorCog,
  Puzzle,
  Shield,
  SlidersHorizontal,
  Upload,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { PluginRecord } from "@paperclipai/shared";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { NavLink } from "@/lib/router";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { usePluginSlots } from "@/plugins/slots";
import { SidebarNavItem } from "./SidebarNavItem";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { primarySidebarStyles } from "./primary-sidebar-styles";

/**
 * Sandbox-provider-only plugins (e.g. E2B, exe.dev, Modal) have no per-plugin
 * settings page, so a sidebar entry would lead nowhere useful. Filter them out
 * here. Plugins that mix a sandbox provider with other contributions still
 * appear.
 */
function isSandboxProviderOnly(plugin: PluginRecord): boolean {
  const drivers = plugin.manifestJson.environmentDrivers ?? [];
  if (drivers.length === 0) return false;
  return drivers.every((d) => d.kind === "sandbox_provider");
}

export function CompanySettingsSidebar() {
  const { selectedCompanyId } = useCompany();
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showPage = (pageKey: string) => !hiddenSettings.has(pageKey);
  const showPlugins = showPage("instance.plugins");
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // nav entry is hidden rather than dead-ending. Export stays available.
  const isCloud = Boolean(useCloudInstance());
  const { slots: companySettingsPluginSlots } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });
  const { data: badges } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.sidebarBadges(selectedCompanyId)
      : ["sidebar-badges", "__disabled__"] as const,
    queryFn: async () => {
      try {
        return await sidebarBadgesApi.get(selectedCompanyId!);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 15_000,
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    // The listing only feeds the per-plugin subtree below; skip it when the
    // operator hides the Plugins surface.
    enabled: showPlugins,
  });
  const sidebarPlugins = (plugins ?? []).filter((plugin) => !isSandboxProviderOnly(plugin));

  return (
    <ContextualSidebarFrame
      surface="settings"
      title={l10n("local.settings_74a883a0")}
      showHeader={false}
      className={primarySidebarStyles.surface}
    >
      <div
        data-slot="settings-sidebar-header"
        className="flex h-(--sz-60px) shrink-0 items-center px-3"
      >
        <div data-slot="settings-back-group" className={`${primarySidebarStyles.group} w-full`}>
          <SidebarNavItem to="/dashboard" label={l10n("local.back_to_app_a6989680")} icon={ArrowLeft} />
        </div>
      </div>
      <nav
        aria-label={l10n("local.settings_74a883a0")}
        data-slot="contextual-sidebar-nav"
        className={primarySidebarStyles.nav}
      >
        <div data-slot="contextual-sidebar-group" className={primarySidebarStyles.group}>
          <SidebarNavItem to="/company/settings" label={l10n("local.general_c910d474")} icon={SlidersHorizontal} end />
          {showPage("instance.profile") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`}
              label={l10n("local.profile_d696a35b")}
              icon={UserRoundPen}
              end
            />
          )}
          {showPage("company.members") && (
            <SidebarNavItem
              to="/company/settings/members"
              label={l10n("local.members_1044a4c0")}
              icon={Users}
              badge={badges?.joinRequests ?? 0}
              end
            />
          )}
          {companySettingsPluginSlots
            .filter((slot) => slot.routePath)
            .map((slot) => (
              <SidebarNavItem
                key={`${slot.pluginKey}:${slot.id}`}
                to={`/company/settings/${slot.routePath}`}
                label={slot.displayName}
                icon={Puzzle}
                end
              />
            ))}
          {showPage("company.secrets") && (
            <SidebarNavItem to="/company/settings/secrets" label={l10n("local.secrets_d8707d41")} icon={KeyRound} end />
          )}
          {showPage("instance.environments") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`}
              label={l10n("local.environments_07437cd6")}
              icon={MonitorCog}
              end
            />
          )}
          {showPage("instance.access") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/access`}
              label={l10n("local.access_ec5ba0ab")}
              icon={Shield}
              end
            />
          )}
          {showPage("company.export") && (
            <SidebarNavItem to="/company/export" label={l10n("local.export_36648955")} icon={Download} />
          )}
          {!isCloud && showPage("company.import") && (
            <SidebarNavItem to="/company/import" label={l10n("local.import_2cff9baa")} icon={Upload} end />
          )}
          {showPage("instance.experimental") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`}
              label={l10n("local.experimental_3dc9f569")}
              icon={FlaskConical}
            />
          )}
          {showPlugins && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`}
              label={l10n("local.plugins_9514b7ff")}
              icon={Puzzle}
            />
          )}
          {showPlugins && sidebarPlugins.length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
              {sidebarPlugins.map((plugin) => (
                <NavLink
                  key={plugin.id}
                  to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins/${plugin.id}`}
                  state={SIDEBAR_SCROLL_RESET_STATE}
                  className={({ isActive }) =>
                    [
                      "rounded-md px-2 py-1.5 text-xs transition-colors",
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    ].join(" ")
                  }
                >
                  {plugin.manifestJson.displayName ?? plugin.packageName}
                </NavLink>
              ))}
            </div>
          ) : null}
          {showPage("instance.adapters") && (
            <SidebarNavItem
              to={`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`}
              label={l10n("local.adapters_d20547a8")}
              icon={Cpu}
            />
          )}
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}
