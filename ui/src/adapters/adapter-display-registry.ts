import { l10n } from "../i18n";
/**
 * Single source of truth for adapter display metadata.
 *
 * Built-in adapters have entries in `adapterDisplayMap`. External (plugin)
 * adapters get sensible defaults derived from their type string via
 * `getAdapterDisplay()`.
 */
import type { ComponentType } from "react";
import {
  Bot,
  Code,
  Gem,
  Moon,
  MousePointer2,
  Sparkles,
  Terminal,
  Cpu,
} from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";

// ---------------------------------------------------------------------------
// Type suffix parsing
// ---------------------------------------------------------------------------

// Suffixes stripped from type ids when deriving a human-readable label for
// unknown (plugin) adapter types. "_local" is a legacy qualifier from before
// first-class Environments and is never displayed; "_gateway" is re-appended
// as " (gateway)" to disambiguate gateway variants. Known adapters in
// `adapterDisplayMap` have final labels and never get a derived suffix.
const STRIPPED_TYPE_SUFFIXES = ["_local", "_gateway"] as const;

const DISPLAY_SUFFIXES: Record<string, string> = {
  _gateway: "gateway",
};

function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(DISPLAY_SUFFIXES)) {
    if (type.endsWith(suffix)) return mode;
  }
  return null;
}

function withSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label} (${suffix})` : label;
}

// ---------------------------------------------------------------------------
// Display metadata per adapter type
// ---------------------------------------------------------------------------

export interface AdapterDisplayInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  acpx_local: {
    label: l10n("local.acpx_retired_8b657a53"),
    description: l10n("local.retired_standalone_acpx_adapter_b063be3d"),
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Use Claude Code or Codex with the ACP engine",
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: l10n("local.claude_code_246ef8c1"),
    description: l10n("local.claude_code_cli_harness_8ef9af1e"),
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: l10n("local.codex_cli_harness_8544dfe5"),
    icon: Code,
    recommended: true,
  },
  paperclip_runner: {
    label: l10n("local.paperclip_runner_aacfc564"),
    description: l10n("local.experimental_rust_runner_with_a_codex_provide_98edf62e"),
    icon: Cpu,
    experimental: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: l10n("local.gemini_cli_harness_f87585b2"),
    icon: Gem,
  },
  grok_local: {
    label: l10n("local.grok_build_fd3bf01a"),
    description: l10n("local.grok_build_harness_916ba19a"),
    icon: Bot,
  },
  kimi_local: {
    label: l10n("local.kimi_code_0c486180"),
    description: l10n("local.kimi_code_cli_harness_92db38e8"),
    icon: Moon,
  },
  hermes_gateway: {
    label: l10n("local.hermes_gateway_10ea67a0"),
    description: l10n("local.remote_hermes_api_server_120e74ee"),
    icon: Bot,
    hideFromVisualSelection: true,
  },
  hermes_local: {
    label: "Hermes",
    description: l10n("local.hermes_harness_1709feea"),
    icon: Bot,
  },
  opencode_local: {
    label: "OpenCode",
    description: l10n("local.opencode_multi_provider_harness_b8f8e337"),
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    label: "Pi",
    description: l10n("local.pi_harness_19e155b1"),
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    description: l10n("local.cursor_cli_harness_473f101c"),
    icon: MousePointer2,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    description: l10n("local.managed_remote_cursor_agent_201c0c40"),
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: l10n("local.openclaw_gateway_b0371788"),
    description: l10n("local.external_gateway_adapter_73f25264"),
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Invite external agents from the add-agent modal",
    hideFromVisualSelection: true,
  },
  process: {
    label: l10n("local.process_e083bd83"),
    description: l10n("local.internal_process_adapter_485c4b0a"),
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    description: l10n("local.internal_http_adapter_6036685c"),
    icon: Cpu,
    comingSoon: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function humanizeType(type: string): string {
  // Strip known type suffixes so "droid_local" → "Droid", not "Droid Local"
  let base = type;
  for (const suffix of STRIPPED_TYPE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  // Known labels are final — only unknown (plugin) types get a derived
  // suffix, so labels like "OpenClaw Gateway" don't become
  // "OpenClaw Gateway (gateway)".
  const known = adapterDisplayMap[type];
  if (known) return known.label;
  return withSuffix(humanizeType(type), getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [type, info] of Object.entries(adapterDisplayMap)) {
    labels[type] = info.label;
  }
  return labels;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix ? l10n("local.external_value_adapter_d6e40c7d", {v0: (suffix)}) : l10n("local.external_adapter_0ff88083"),
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
