import { l10n } from "../i18n";
import type { ToastInput } from "@/context/ToastContext";

export interface BuiltInAgentPausedToastOptions {
  /** Display name of the paused built-in agent, e.g. "Briefs Agent". */
  displayName: string;
  /** Deep link to the agent page (from `agentUrl(agent)`). */
  agentHref: string;
  /** Noun for the feature item, e.g. "brief". */
  featureNoun?: string;
}

/**
 * Build the "use-while-paused" toast payload (ux-spec §5 / D9).
 *
 * `ToastAction` supports a single `href` link only, so v1 carries one
 * "View agent" link and Resume happens on the agent page. Deduped so repeated
 * feature actions don't stack duplicate toasts.
 */
export function buildBuiltInAgentPausedToast(options: BuiltInAgentPausedToastOptions): ToastInput {
  const noun = options.featureNoun ?? l10n("local.item_4a33eacd");
  return {
    dedupeKey: `built-in-agent-paused:${options.displayName}`,
    title: l10n("local.value_is_paused_67721e07", {v0: (options.displayName)}),
    body: l10n("local.resume_agent_generate_noun_10301358", { v0: noun }),
    tone: "warn",
    action: { label: l10n("local.view_agent_7ce7832e"), href: options.agentHref },
  };
}
