import { l10n } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, CollapsibleSection } from "./agent-config-primitives";
import {
  buildPermissionsForTrustPreset,
  clearSingleLowTrustBoundaryTarget,
  getLowTrustBoundary,
  getSingleLowTrustBoundaryTarget,
  getTrustPreset,
  isCeLowTrustBoundaryEditable,
  lowTrustBoundaryHasScope,
  setSingleLowTrustBoundaryTarget,
  summarizeLowTrustBoundaryTarget,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type LowTrustBoundaryTarget,
} from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, singular: string, plural: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return `${count} ${count === 1 ? singular : plural}`;
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", value === "-" && "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export interface LowTrustBoundaryCandidate {
  id: string;
  label: string;
}

type LowTrustBoundaryTargetType = LowTrustBoundaryTarget["type"];

const BOUNDARY_TARGET_LABELS: Record<LowTrustBoundaryTargetType, string> = {
  project: l10n("local.project_98595978"),
  root_issue: l10n("local.root_issue_9cfea50f"),
  issue: l10n("local.issue_48dc76df"),
};

export function TrustPresetSection({
  permissions,
  onChange,
  disabled,
  companyId,
  projectCandidates = [],
  issueCandidates = [],
  candidatesLoading,
  allowSingleIssue = true,
}: {
  permissions: Partial<AgentPermissions> | null | undefined;
  onChange: (permissions: Partial<AgentPermissions>) => void;
  disabled?: boolean;
  companyId?: string | null;
  projectCandidates?: LowTrustBoundaryCandidate[];
  issueCandidates?: LowTrustBoundaryCandidate[];
  candidatesLoading?: boolean;
  allowSingleIssue?: boolean;
}) {
  const [policyOpen, setPolicyOpen] = useState(false);
  const preset = getTrustPreset(permissions);
  const boundary = getLowTrustBoundary(permissions);
  const boundaryTarget = getSingleLowTrustBoundaryTarget(boundary);
  const [targetType, setTargetType] = useState<LowTrustBoundaryTargetType>(boundaryTarget?.type ?? "project");
  const lowTrust = preset === "low_trust_review";
  const hasScope = lowTrustBoundaryHasScope(boundary);
  const boundaryEditable = isCeLowTrustBoundaryEditable(boundary);
  const policy = permissions?.authorizationPolicy ?? null;
  const managedPermissions = useMemo(
    () => buildPermissionsForTrustPreset(permissions, preset),
    [permissions, preset],
  );

  useEffect(() => {
    if (boundaryTarget) setTargetType(boundaryTarget.type);
  }, [boundaryTarget?.type]);

  function handlePresetChange(value: string) {
    const nextPreset: TrustPreset = value === "low_trust_review" ? "low_trust_review" : "standard";
    onChange(buildPermissionsForTrustPreset(permissions, nextPreset));
  }

  function handleBoundaryTargetChange(targetId: string) {
    if (!companyId || !targetId) return;
    onChange(setSingleLowTrustBoundaryTarget(permissions, companyId, { type: targetType, id: targetId }));
  }

  function handleClearBoundary() {
    onChange(clearSingleLowTrustBoundaryTarget(permissions));
  }

  const targetCandidates = targetType === "project" ? projectCandidates : issueCandidates;
  const boundaryValue = boundaryTarget?.type === targetType ? boundaryTarget.id : "";

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{l10n("local.trust_ade9248e")}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label={l10n("local.trust_preset_d41e165d")} hint={l10n("local.choose_how_broadly_this_agent_can_read_and_ac_24bf54bd")}>
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{TRUST_PRESET_LABELS.standard}</option>
            <option value="low_trust_review">{TRUST_PRESET_LABELS.low_trust_review}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{TRUST_PRESET_DESCRIPTIONS[preset]}</p>

        {lowTrust ? (
          <div
            role={hasScope ? "status" : "alert"}
            aria-live="polite"
            className={cn(
              "rounded-md border px-3 py-2.5 text-sm flex gap-2",
              hasScope
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {hasScope ? (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-medium">
                  {hasScope ? l10n("local.containment_active_116032b7") : l10n("local.containment_not_configured_b5c07df6")}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? l10n("local.this_agent_can_only_read_and_mutate_work_insi_56237f23")
                    : l10n("local.this_agent_is_set_to_low_trust_review_but_no_27171347")}
                </p>
              </div>
              {boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-(--gtc-12)">
                    <Field label={l10n("local.boundary_type_61a3e610")}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{l10n("local.project_98595978")}</option>
                        <option value="root_issue">{l10n("local.root_issue_9cfea50f")}</option>
                        {allowSingleIssue && <option value="issue">{l10n("local.issue_48dc76df")}</option>}
                      </select>
                    </Field>
                    <Field label={BOUNDARY_TARGET_LABELS[targetType]}>
                      <select
                        className={inputClass}
                        value={boundaryValue}
                        onChange={(event) => handleBoundaryTargetChange(event.target.value)}
                        disabled={disabled || !companyId || candidatesLoading || targetCandidates.length === 0}
                      >
                        <option value="">
                          {candidatesLoading
                            ? l10n("local.loading_ba3bbbe1")
                            : targetCandidates.length === 0
                              ? l10n("local.no_value_available_85ce314a", {v0: (targetType === "project" ? "projects" : "issues")})
                              : l10n("local.select_boundary_5009d413")}
                        </option>
                        {targetCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {l10n("local.ce_saves_one_containment_boundary_at_a_time_s_76927e0a")}</p>
                    {boundaryTarget ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={handleClearBoundary}
                        disabled={disabled}
                      >
                        {l10n("local.clear_boundary_ebcd7119")}</Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{l10n("local.managed_by_ee_api_b028fcfe")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {l10n("local.this_policy_has_afbc2a08")}{" "}{summarizeLowTrustBoundaryTarget(boundary).toLowerCase()} {l10n("local.and_cannot_be_edited_by_the_ce_single_boundar_112a59c1")}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {l10n("local.want_to_set_more_than_one_containment_boundar_4a136265")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >
                  {l10n("local.get_paperclip_ee_601f5e6e")}</a>
              </p>
              <CollapsibleSection
                title={l10n("local.view_policy_faa39d94")}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label={l10n("local.preset_7252e7ce")} value="Low-trust review v1" />
                  <PolicyRow label={l10n("local.raw_output_f3dbf20a")} value="Quarantined from higher-trust agents" />
                  <PolicyRow label={l10n("local.projects_04e2a972")} value={formatCount(boundary?.projectIds, "project", "projects")} />
                  <PolicyRow label={l10n("local.root_issue_9cfea50f")} value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label={l10n("local.explicit_issues_5093b25d")} value={formatCount(boundary?.issueIds, "issue", "issues")} />
                  <PolicyRow label={l10n("local.allowed_agents_ab33e0e8")} value={formatCount(boundary?.allowedAgentIds, "agent", "agents")} />
                  <PolicyRow label={l10n("local.allowed_tools_73f3619d")} value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label={l10n("local.allowed_secrets_29e561fc")} value={formatCount(boundary?.allowedSecretBindingIds, "binding", "bindings")} />
                  <PolicyRow label={l10n("local.promotion_target_ac1fff63")} value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label={l10n("local.ee_fields_5cf54800")}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? "Custom advanced policy fields preserved"
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            {l10n("local.advanced_permissions_remain_editable_through_fb6b4df4")}</p>
        )}
      </div>
    </div>
  );
}
