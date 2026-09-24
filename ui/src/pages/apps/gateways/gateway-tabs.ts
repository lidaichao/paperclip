import { l10n } from "../../../i18n";
import { Activity, LayoutGrid, KeyRound, Wrench, Boxes } from "lucide-react";

/**
 * Gateway detail tabs (PAP-11200). Terminology is locked by the approved
 * PAP-11178 design of record: Overview · Apps & tools · Tokens · Activity ·
 * Advanced. Raw protocol / JSON / transport details live under Advanced.
 */
export const GATEWAY_TABS = [
  { key: "overview", label: l10n("local.overview_d4b1ea57"), icon: LayoutGrid },
  { key: "apps", label: l10n("local.apps_tools_b10a5c44"), icon: Boxes },
  { key: "tokens", label: l10n("local.tokens_a039dfb9"), icon: KeyRound },
  { key: "activity", label: l10n("local.activity_38da1505"), icon: Activity },
  { key: "advanced", label: l10n("local.advanced_9f088dbe"), icon: Wrench },
] as const;

export type GatewayTabKey = (typeof GATEWAY_TABS)[number]["key"];

export function gatewayTabHref(gatewayId: string, tab: GatewayTabKey): string {
  return `/apps/gateways/${gatewayId}/${tab}`;
}

export function isGatewayTabKey(value: string | undefined): value is GatewayTabKey {
  return GATEWAY_TABS.some((tab) => tab.key === value);
}

export function gatewayTabLabel(tabKey: GatewayTabKey): string {
  return GATEWAY_TABS.find((tab) => tab.key === tabKey)?.label ?? "Overview";
}
