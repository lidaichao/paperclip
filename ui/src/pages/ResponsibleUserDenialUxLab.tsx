import { l10n } from "../i18n";
import type { ReactNode } from "react";
import { ResponsibleUserDenialNotice } from "@/components/ResponsibleUserDenialNotice";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/**
 * UX lab for PAP-12462 (P7): run "on behalf of {user}" surfacing + responsible-user
 * denial copy. Renders before/after of both surfaces with real design tokens so the
 * states can be captured for UX review. Route: /ux-lab/responsible-user-denial
 */

function LabSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-background/85 p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

function BeforeAfter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </div>
      <Card className="block border-border/60 p-3">{children}</Card>
    </div>
  );
}

/** A faithful copy of a run ledger row header (see IssueRunLedger.tsx). */
function RunLedgerRow({
  onBehalfOf,
  denial,
}: {
  onBehalfOf?: string | null;
  denial?: ReactNode;
}) {
  return (
    <article className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">{l10n("local.run_00d60e31")}</span>
        <span className="min-w-0 max-w-full truncate font-mono text-foreground">a1b2c3d4</span>
        <span>{l10n("local.by_codexcoder_94596b0a")}</span>
        {onBehalfOf ? (
          <span className="min-w-0 max-w-full truncate text-muted-foreground">
            {l10n("local.on_behalf_of_653bb65e")}{" "}<span className="text-foreground">{onBehalfOf}</span>
          </span>
        ) : null}
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? l10n("local.failed_031a8f0f") : l10n("local.succeeded_6d9a6f97")}
        </span>
        <span className="ml-auto shrink-0">{l10n("local.2m_ago_35abf1da")}</span>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="min-w-0">
          <span className="text-foreground">{l10n("local.elapsed_a194a68a")}</span> {l10n("local.1m_4s_0e585764")}</div>
        <div className="min-w-0">
          <span className="text-foreground">{l10n("local.last_useful_action_72876fff")}</span> {l10n("local.2m_ago_35abf1da")}</div>
        <div className="min-w-0">
          <span className="text-foreground">{l10n("local.stop_cae7d57b")}</span> {denial ? l10n("local.denied_da404deb") : l10n("local.completed_22a970d2")}
        </div>
      </div>
      {denial}
    </article>
  );
}

/** A faithful copy of the run-detail header identity block (see AgentDetail.tsx RunDetail). */
function RunDetailHeader({ onBehalfOf, denial }: { onBehalfOf?: string | null; denial?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold text-foreground">{l10n("local.run_a1b2c3d4_3ae9d7b1")}</span>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? l10n("local.failed_5d28a90f") : l10n("local.succeeded_5dceaece")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-(length:--text-micro) text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide">
          codex local
        </span>
        <span>anthropic/claude-opus-4-8</span>
      </div>
      {onBehalfOf ? (
        <div className="text-xs text-muted-foreground">
          {l10n("local.on_behalf_of_cdccf734")}{" "}<span className="text-foreground">{onBehalfOf}</span>
        </div>
      ) : null}
      {denial}
    </div>
  );
}

export function ResponsibleUserDenialUxLab() {
  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            PAP-12462 · P7
          </div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">
            {l10n("local.run_on_behalf_of_surfacing_denial_copy_7bb3b3a1")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.before_after_of_the_two_run_surfaces_and_the_a788a2b5")}</p>
        </header>

        <LabSection
          title={l10n("local.1_run_identity_on_behalf_of_user_1a747c3a")}
          description={l10n("local.a_run_acting_for_a_human_now_names_that_user_6fad7947")}
        >
          <BeforeAfter label={l10n("local.before_run_ledger_10bb7a39")}>
            <RunLedgerRow />
          </BeforeAfter>
          <BeforeAfter label={l10n("local.after_run_ledger_c6d2a4d4")}>
            <RunLedgerRow onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
          <BeforeAfter label={l10n("local.before_run_detail_5d8ed0df")}>
            <RunDetailHeader />
          </BeforeAfter>
          <BeforeAfter label={l10n("local.after_run_detail_76680a86")}>
            <RunDetailHeader onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={l10n("local.2_denial_state_responsible_user_not_authorize_e4abd6e7")}
          description={l10n("local.the_agent_is_allowed_but_the_user_the_run_act_cbbe6bd5")}
        >
          <BeforeAfter label={l10n("local.before_generic_failure_text_a50af9fe")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {l10n("local.forbidden_action_not_permitted_0d61c3bc")}</span>
              <span className="ml-1 text-muted-foreground">(RESPONSIBLE_USER_UNAUTHORIZED)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={l10n("local.after_actionable_denial_copy_c81f5479")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAUTHORIZED"
              userName="Ada Lovelace"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={l10n("local.3_denial_state_agent_lacks_permission_unchang_b7c68c5b")}
          description={l10n("local.a_denial_that_is_not_a_responsible_user_code_93ecbf25")}
        >
          <BeforeAfter label={l10n("local.agent_lacks_permission_failure_051fbeb1")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {l10n("local.forbidden_agent_is_not_permitted_to_perform_t_b7cedffe")}</span>
              <span className="ml-1 text-muted-foreground">(deny_missing_membership)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={l10n("local.no_responsible_user_notice_rendered_71693acb")}>
            <div className="text-xs text-muted-foreground">
              {l10n("local.responsible_user_denial_notice_intentionally_03c2f47e")}</div>
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={l10n("local.4_denial_state_responsible_user_unavailable_230d6a8f")}
          description={l10n("local.the_user_this_run_acts_for_was_removed_or_dea_a51ed5d7")}
        >
          <BeforeAfter label={l10n("local.before_generic_failure_text_a50af9fe")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {l10n("local.forbidden_responsible_user_unavailable_62fd54eb")}</span>
              <span className="ml-1 text-muted-foreground">(RESPONSIBLE_USER_UNAVAILABLE)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={l10n("local.after_actionable_denial_copy_c81f5479")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAVAILABLE"
              userName="Grace Hopper"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={l10n("local.in_context_denial_inside_a_failed_run_ledger_518c46bd")}
          description={l10n("local.how_the_notice_reads_within_a_run_row_on_the_c38ac684")}
        >
          <BeforeAfter label={l10n("local.unauthorized_d089c8a9")}>
            <RunLedgerRow
              onBehalfOf="Ada Lovelace"
              denial={
                <ResponsibleUserDenialNotice
                  code="RESPONSIBLE_USER_UNAUTHORIZED"
                  userName="Ada Lovelace"
                />
              }
            />
          </BeforeAfter>
          <BeforeAfter label={l10n("local.unavailable_ca184496")}>
            <RunLedgerRow
              onBehalfOf="Grace Hopper"
              denial={
                <ResponsibleUserDenialNotice
                  code="RESPONSIBLE_USER_UNAVAILABLE"
                  userName="Grace Hopper"
                />
              }
            />
          </BeforeAfter>
        </LabSection>

        <p className={cn("text-center text-(length:--text-micro) text-muted-foreground")}>
          {l10n("local.copy_is_sourced_from_the_shared_44aa1b76")}{" "}<code>describeResponsibleUserDenial</code> {l10n("local.contract_9f39446e")}</p>
      </div>
    </div>
  );
}
