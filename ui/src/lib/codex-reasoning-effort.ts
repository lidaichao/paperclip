import { l10n } from "../i18n";
import {
  codexLocalReasoningEffortsForModel,
  type CodexLocalReasoningEffort,
} from "@paperclipai/adapter-codex-local";

const CODEX_REASONING_EFFORT_LABELS: Record<CodexLocalReasoningEffort, string> = {
  minimal: l10n("local.minimal_057b5de4"),
  low: l10n("local.low_f793de20"),
  medium: l10n("local.medium_8e588cd1"),
  high: l10n("local.high_c4ebc6d4"),
  xhigh: l10n("local.x_high_393d3e4b"),
  max: l10n("local.max_a1a5936d"),
  ultra: l10n("local.ultra_ac364e1a"),
};

export function codexReasoningEffortOptions(
  model: string | null | undefined,
  defaultLabel = "Default",
) {
  return [
    { value: "", label: defaultLabel },
    ...codexLocalReasoningEffortsForModel(model).map((value) => ({
      value,
      label: CODEX_REASONING_EFFORT_LABELS[value],
    })),
  ];
}
