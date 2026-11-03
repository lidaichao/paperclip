import { l10n } from "../../i18n";

/**
 * Whimsical gerunds for the live status pill when the label carries no real
 * signal ("Running"/"Working"). Two curated pools: Paperclip's analog-office
 * vocabulary (led by the "Clipping" brand nod) and Claude-Code-style whimsy.
 * Every word is chosen to still read sensibly after-the-fact — a settled turn
 * that once said "Collating…" shouldn't feel like a lie.
 *
 * The pick is deterministic from a seed (the run-scoped status item id) so a
 * re-render never reshuffles the word, and it rotates to the next word every
 * ~10s of elapsed run time.
 */

/** Paperclip / analog-office pool — "Clipping" is the guaranteed brand nod.
 * Board-curated round 2 (PAP-349): dropped Cataloguing / Carbon-copying /
 * Archiving, added the workshop-and-whiteboard verbs. */
export const ANALOG_OFFICE_WORDS: readonly string[] = [
  l10n("local.clipping_10300419"),
  l10n("local.organizing_10300420"),
  l10n("local.sorting_10300421"),
  l10n("local.synthesizing_10300422"),
  l10n("local.analyzing_10300423"),
  l10n("local.filing_10300424"),
  l10n("local.collating_10300425"),
  l10n("local.stapling_10300426"),
  l10n("local.indexing_10300427"),
  l10n("local.annotating_10300428"),
  l10n("local.drafting_10300429"),
  l10n("local.proofreading_10300430"),
  l10n("local.alphabetizing_10300431"),
  l10n("local.photocopying_10300432"),
  l10n("local.laminating_10300433"),
  l10n("local.hole_punching_10300434"),
  l10n("local.bookmarking_10300435"),
  l10n("local.highlighting_10300436"),
  l10n("local.typing_10300437"),
  l10n("local.trimming_10300438"),
  l10n("local.aligning_10300439"),
  l10n("local.combining_10300440"),
  l10n("local.whiteboarding_10300441"),
  l10n("local.diagramming_10300442"),
  l10n("local.sketching_10300443"),
  l10n("local.labeling_10300444"),
  l10n("local.sticky_noting_10300445"),
];

/** Claude-Code-style whimsy pool — board-curated round 2 kept only these four. */
export const CLAUDE_CODE_WORDS: readonly string[] = [
  l10n("local.brewing_10300446"),
  l10n("local.tinkering_10300447"),
  l10n("local.distilling_10300448"),
  l10n("local.deliberating_10300449"),
];

/** Interleaved so consecutive rotations alternate flavors rather than running
 * through one pool before the other. */
export const WHIMSY_WORDS: readonly string[] = (() => {
  const out: string[] = [];
  const max = Math.max(ANALOG_OFFICE_WORDS.length, CLAUDE_CODE_WORDS.length);
  for (let i = 0; i < max; i++) {
    if (i < ANALOG_OFFICE_WORDS.length) out.push(ANALOG_OFFICE_WORDS[i]);
    if (i < CLAUDE_CODE_WORDS.length) out.push(CLAUDE_CODE_WORDS[i]);
  }
  return out;
})();

/** How long each word holds before rotating to the next. */
export const WHIMSY_ROTATE_MS = 10_000;

/**
 * Labels that carry no tool identity, where a whimsical word fills the gap.
 * Informative labels (taxonomy verbs, "Thinking", "Responding", "Queued")
 * always keep their copy — whimsy never replaces signal.
 */
export function isGenericStatusLabel(label: string | undefined | null): boolean {
  const raw = (label ?? "").trim().toLocaleLowerCase();
  return new Set([
    "running",
    "working",
    l10n("local.running_f4ccae29").toLocaleLowerCase(),
    l10n("local.working_a92f0449").toLocaleLowerCase(),
  ]).has(raw);
}

/** FNV-1a 32-bit — stable, dependency-free string hash for the seed. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic whimsical word: the seed fixes the starting offset into the
 * pool and each elapsed `WHIMSY_ROTATE_MS` advances one word. Same seed and
 * elapsed always yield the same word.
 */
export function whimsyWord(seed: string, elapsedMs = 0): string {
  const tick = Math.floor(Math.max(0, elapsedMs) / WHIMSY_ROTATE_MS);
  return WHIMSY_WORDS[(fnv1a(seed) + tick) % WHIMSY_WORDS.length];
}
