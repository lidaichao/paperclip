import { l10n } from "../i18n";
/**
 * @fileoverview Classifies a failed skill mutation into the four visual states
 * from the Phase 3 UX spec (PAP-13865 / §9.10 Company Skill Policy Contract).
 *
 * The contract inverts the old model: **skill permissions are opt-in
 * restrictions, not opt-in capabilities.** Under the open default there is no
 * permission chrome at all — install / edit / update / test / reset / remove
 * are just live buttons. A denial notice only appears when an explicit company
 * policy (State B) or a non-configurable platform invariant (State C) actually
 * denied the action. Everything else (network, 409 conflict, 5xx) is a
 * transient error (State D) that keeps the existing toast path.
 *
 * This classifier is deliberately pure and framework-free so it can be unit
 * tested exhaustively without a DOM. `classifySkillDenial()` returns `null` for
 * State A (allowed / nothing to show) and State D (transient — let the caller
 * toast it); the UI renders a persistent banner only for B and C.
 */

import { ApiError } from "../api/client";

/** Machine-readable error codes the server attaches to skill mutation failures. */
export const SKILL_POLICY_DENIAL_CODE = "skill_policy_denied";

/**
 * Non-configurable platform-invariant failure codes (§9.10). Policy can never
 * loosen these — the remediation is always to fix the artifact/source/input,
 * never to change a permission.
 */
export const SKILL_PLATFORM_INVARIANT_CODES = [
  "skill_authentication_required",
  "skill_company_boundary_denied",
  "skill_workspace_boundary_denied",
  "skill_source_validation_failed",
  "skill_unsafe_content_blocked",
  "skill_secret_handling_blocked",
  "skill_actor_restricted",
] as const;

/**
 * Requires board-administration authority (`users:manage_permissions`). This is
 * a platform boundary — not something the current agent can self-serve — so we
 * treat it as State C but with admin-oriented remediation.
 */
export const SKILL_POLICY_ADMIN_CODE = "skill_policy_admin_required";

export type SkillDenialState = "policy" | "platform" | "platform_admin";

export interface SkillDenial {
  /** Which visual treatment applies. `policy` = State B, `platform*` = State C. */
  state: SkillDenialState;
  /** Machine-readable error code from the server, when present. */
  code: string | null;
  /** §9.10 decision `reason`, when the server surfaced the decision shape. */
  reason: string | null;
  /** Plain-language title for the banner. */
  title: string;
  /** Human remediation — never a curl/API-key snippet. */
  remediation: string;
}

const DEFAULT_POLICY_REMEDIATION = l10n("local.organization_admin_can_change_skill_policy_10300074");
const DEFAULT_ADMIN_REMEDIATION = l10n("local.organization_admin_access_required_10300075");

/** Human-readable titles for the platform-invariant codes (State C). */
const PLATFORM_TITLES: Record<string, string> = {
  skill_authentication_required: l10n("local.sign_in_to_manage_skills_10300076"),
  skill_company_boundary_denied: l10n("local.skill_belongs_to_another_organization_10300077"),
  skill_workspace_boundary_denied: l10n("local.skill_source_outside_allowed_workspace_10300078"),
  skill_source_validation_failed: l10n("local.skill_source_failed_validation_10300079"),
  skill_unsafe_content_blocked: l10n("local.skill_contains_unsafe_content_10300080"),
  skill_secret_handling_blocked: l10n("local.skill_exposes_secret_value_10300081"),
  skill_actor_restricted: l10n("local.action_unavailable_for_current_actor_10300082"),
};

/** Default remediation copy per platform-invariant code — framed as a fix, never a grant. */
const PLATFORM_REMEDIATIONS: Record<string, string> = {
  skill_authentication_required: l10n("local.sign_in_and_try_again_10300083"),
  skill_company_boundary_denied: l10n("local.open_skill_from_owning_organization_10300084"),
  skill_workspace_boundary_denied:
    l10n("local.import_from_alice_workspace_or_managed_directory_10300085"),
  skill_source_validation_failed: l10n("local.fix_flagged_source_and_retry_10300086"),
  skill_unsafe_content_blocked:
    l10n("local.remove_unsafe_pattern_before_saving_10300087"),
  skill_secret_handling_blocked: l10n("local.remove_secret_value_before_saving_10300088"),
  skill_actor_restricted: l10n("local.retry_from_account_with_access_10300089"),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Turn a caller-supplied error into a denial descriptor, or `null` when there
 * is nothing to render as a persistent notice (State A allowed / State D
 * transient). The `actionLabel` (e.g. "Installing external skills") lets the
 * caller phrase State B's title around the specific action.
 */
export function classifySkillDenial(
  error: unknown,
  actionLabel?: string,
): SkillDenial | null {
  if (!(error instanceof ApiError)) return null;

  const body = asRecord(error.body);
  const code = asString(body?.code);
  const reason = asString(body?.reason);
  const remediation = asString(body?.remediation);

  // State B — explicit company-policy denial. Resolvable by an administrator.
  const isPolicyDenial =
    code === SKILL_POLICY_DENIAL_CODE
    || reason === "explicit_rule"
    || reason === "policy_default";
  if (isPolicyDenial) {
    const title = actionLabel
      ? l10n("local.value_is_restricted_by_your_organization_poli_b6bd4373", {v0: (actionLabel)})
      : l10n("local.this_action_is_restricted_by_your_organizatio_5427af2b");
    return {
      state: "policy",
      code,
      reason,
      title,
      remediation: remediation ?? DEFAULT_POLICY_REMEDIATION,
    };
  }

  // State C — policy administration boundary (needs users:manage_permissions).
  if (code === SKILL_POLICY_ADMIN_CODE) {
    return {
      state: "platform_admin",
      code,
      reason,
      title: l10n("local.this_change_needs_administration_access_ecff0048"),
      remediation: remediation ?? DEFAULT_ADMIN_REMEDIATION,
    };
  }

  // State C — non-configurable platform-safety invariant. Never waivable.
  const isPlatformInvariant =
    (code !== null && (SKILL_PLATFORM_INVARIANT_CODES as readonly string[]).includes(code))
    || reason === "platform_invariant";
  if (isPlatformInvariant) {
    return {
      state: "platform",
      code,
      reason,
      title: (code && PLATFORM_TITLES[code]) ?? l10n("local.this_action_is_blocked_by_a_platform_safety_r_59465fd0"),
      remediation:
        remediation
        ?? (code && PLATFORM_REMEDIATIONS[code])
        ?? l10n("local.fix_flagged_issue_and_try_again_10300090"),
    };
  }

  // State D — transient (network / 409 conflict / 5xx / uncoded 4xx). Let the
  // caller keep the existing retry toast; do not render a policy banner.
  return null;
}
