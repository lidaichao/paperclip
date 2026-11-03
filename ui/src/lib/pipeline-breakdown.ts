import type { PipelineStage } from "../api/pipelines";
import { l10n } from "../i18n";

/**
 * UI-side reader + copy helpers for the "Break into pieces" stage primitive.
 *
 * The server stores the breakdown config on `stage.config.breakdown` (see
 * `pipelineStageBreakdownSchema`). Only the singular `pieceNoun` is persisted;
 * the plural is derived here exactly the way the server's health checks derive
 * it (`${pieceNoun}s`) so every count/banner string stays consistent.
 *
 * All copy in this module is prosumer-facing — no API terms ("case", "child",
 * "stage key") ever surface; the configured piece noun is the dominant token.
 */

export interface StageBreakdownConfig {
  targetPipelineId: string;
  targetStageKey: string;
  pieceNoun: string;
  inheritFields: string[];
  carryOverPolicy?: BreakdownCarryOverPolicy;
  advanceTo: string | null;
  waitForPieces: boolean;
  whenFinishedMoveTo: string | null;
}

export type BreakdownCarryOverMode = "all_except" | "only";

export interface BreakdownCarryOverPolicy {
  version: 1;
  mode: BreakdownCarryOverMode;
  includeFields: string[];
  excludeFields: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const key = asString(entry);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [key];
  });
}

function readCarryOverPolicy(record: Record<string, unknown>, inheritFields: string[]): BreakdownCarryOverPolicy {
  const raw = record.carryOverPolicy;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const policy = raw as Record<string, unknown>;
    const mode = policy.mode === "all_except" || policy.mode === "only" ? policy.mode : "all_except";
    return {
      version: 1,
      mode,
      includeFields: asStringList(policy.includeFields),
      excludeFields: asStringList(policy.excludeFields),
    };
  }
  return {
    version: 1,
    mode: "only",
    includeFields: inheritFields,
    excludeFields: [],
  };
}

export function isCarryOverIdentityFieldKey(key: string) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "name" ||
    normalized === "title" ||
    normalized === "casename" ||
    normalized === "casetitle";
}

export function isCarryOverFieldEnabled(policy: BreakdownCarryOverPolicy | null | undefined, key: string) {
  if (!policy) return false;
  if (isCarryOverIdentityFieldKey(key)) return false;
  if (policy.mode === "only") return policy.includeFields.includes(key);
  return !policy.excludeFields.includes(key);
}

/**
 * Returns the breakdown config when a stage has the `breakdown` block, else
 * `null`. Fields may be empty when the config is half-finished — read surfaces
 * lean on `computePipelineHealth` to flag a missing target rather than hiding
 * the stage.
 */
export function readStageBreakdown(
  stage: { config?: Record<string, unknown> | null } | null | undefined,
): StageBreakdownConfig | null {
  const raw = stage?.config?.breakdown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const inheritFields = Array.isArray(record.inheritFields)
    ? record.inheritFields.filter((field): field is string => typeof field === "string" && field.trim().length > 0).map((field) => field.trim())
    : [];
  const carryOverPolicy = readCarryOverPolicy(record, inheritFields);
  return {
    targetPipelineId: asString(record.targetPipelineId),
    targetStageKey: asString(record.targetStageKey),
    pieceNoun: asString(record.pieceNoun) || "piece",
    inheritFields,
    carryOverPolicy,
    advanceTo: asString(record.advanceTo) || null,
    waitForPieces: record.waitForPieces === true,
    whenFinishedMoveTo: asString(record.whenFinishedMoveTo) || null,
  };
}

export function hasStageBreakdown(stage: PipelineStage | null | undefined): boolean {
  return readStageBreakdown(stage) !== null;
}

/** Plural form of the piece noun, derived the same way the server does. */
export function pieceNounPlural(noun: string): string {
  const trimmed = noun.trim() || "piece";
  return `${trimmed}s`;
}

/** "a and b" / "a, b and c" — for inherited-field lists. */
export function joinWithAnd(items: string[]): string {
  const list = items.filter((item) => item.trim().length > 0);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return l10n("local.value_and_value_0d700001", { v0: list[0], v1: list[1] });
  return l10n("local.list_and_value_0d700002", {
    v0: list.slice(0, -1).join(l10n("local.list_separator_0d700003")),
    v1: list[list.length - 1],
  });
}

export interface BreakdownCopyNames {
  targetPipelineName: string;
  entryStageName: string;
  advanceToName: string | null;
  whenFinishedName: string | null;
  /** Human labels for the inherited fields, in config order. */
  inheritedFieldLabels: string[];
}

/**
 * The single generated sentence shown in the settings card footer band.
 * Returns `null` when the config is too incomplete to summarize.
 */
export function breakdownSummarySentence(
  config: StageBreakdownConfig,
  names: BreakdownCopyNames,
): string | null {
  if (!config.targetPipelineId || !config.targetStageKey || !names.targetPipelineName) {
    return null;
  }
  const noun = config.pieceNoun;
  const parts: string[] = [
    l10n("local.alice_will_create_one_value_per_item_in_value_to_value_0d700004", {
      v0: noun,
      v1: names.targetPipelineName,
      v2: names.entryStageName,
    }),
  ];
  if (names.inheritedFieldLabels.length > 0) {
    parts.push(l10n("local.carry_over_value_0d700005", { v0: joinWithAnd(names.inheritedFieldLabels) }));
  }
  if (names.advanceToName) {
    parts.push(l10n("local.move_this_case_to_value_0d700006", { v0: names.advanceToName }));
  }
  let sentence = parts.join(l10n("local.clause_separator_0d700007"));
  if (config.waitForPieces && names.whenFinishedName) {
    sentence += l10n("local.then_wait_every_value_finished_before_moving_to_value_0d700008", {
      v0: noun,
      v1: names.whenFinishedName,
    });
  }
  return l10n("local.value_sentence_0d700009", { v0: sentence });
}

/**
 * The read-only "Alice handles this" mechanics bullets, composed from the
 * config. Bullets 5 and 6 only appear when the wait gate is on.
 */
export function breakdownMechanicsBullets(
  config: StageBreakdownConfig,
  names: BreakdownCopyNames,
): string[] {
  const noun = config.pieceNoun;
  const bullets: string[] = [
    l10n("local.creates_one_value_per_returned_item_in_value_to_value_0d700010", {
      v0: noun,
      v1: names.targetPipelineName || l10n("local.destination_pipeline_0d700011"),
      v2: names.entryStageName || l10n("local.entry_step_0d700012"),
    }),
    l10n("local.links_every_value_to_case_for_progress_rollup_0d700013", { v0: noun }),
  ];
  if (names.inheritedFieldLabels.length > 0) {
    bullets.push(l10n("local.carries_over_value_from_case_to_each_value_0d700014", {
      v0: joinWithAnd(names.inheritedFieldLabels),
      v1: noun,
    }));
  }
  if (names.advanceToName) {
    bullets.push(l10n("local.moves_case_to_value_when_pieces_created_0d700015", { v0: names.advanceToName }));
  }
  if (config.waitForPieces && names.whenFinishedName) {
    bullets.push(l10n("local.waits_every_value_finished_then_moves_case_to_value_0d700016", {
      v0: noun,
      v1: names.whenFinishedName,
    }));
    bullets.push(l10n("local.empty_list_skips_case_to_value_0d700017", { v0: names.whenFinishedName }));
  }
  return bullets;
}
