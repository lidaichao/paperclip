import { l10n } from "../i18n";
import type { ReactElement, ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type LabFixtureKey =
  | "signed-out-private"
  | "signed-in-private"
  | "claiming"
  | "claim-error"
  | "claim-success"
  | "public-invite-only";

const FIXTURE_LABELS: Record<LabFixtureKey, string> = {
  "signed-out-private": l10n("local.1_authenticated_private_signed_out_browser_cl_e1d9f7ab"),
  "signed-in-private": l10n("local.2_authenticated_private_signed_in_claim_cta_p_436fd3cb"),
  claiming: l10n("local.3_authenticated_private_claim_in_flight_7f37c6fe"),
  "claim-error": l10n("local.4_authenticated_private_claim_error_e_g_409_a_2e32b9eb"),
  "claim-success": l10n("local.5_authenticated_private_claim_succeeded_redir_58f6e32a"),
  "public-invite-only": l10n("local.6_authenticated_public_invite_only_no_browser_b7477e9c"),
};

const FIXTURE_ORDER: LabFixtureKey[] = [
  "signed-out-private",
  "signed-in-private",
  "claiming",
  "claim-error",
  "claim-success",
  "public-invite-only",
];

function CliFallback({ hasActiveInvite }: { hasActiveInvite: boolean }) {
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{l10n("local.prefer_to_finish_setup_from_the_host_d29e5c6f")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? l10n("local.a_bootstrap_invite_is_already_active_check_yo_e037b41b")
          : l10n("local.run_this_command_on_the_host_that_runs_paperc_2a01c9f3")}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
{BOOTSTRAP_FALLBACK_COMMAND}
      </pre>
    </div>
  );
}

function StateChrome({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">{children}</Card>
    </div>
  );
}

function SignedOutPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.no_admin_has_claimed_this_instance_yet_sign_i_dcabbf1b")}</p>
      <div className="mt-5">
        <Button asChild>
          <a href="/auth?next=/">{l10n("local.sign_in_create_account_5d4f5eb1")}</a>
        </Button>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function SignedInPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.no_admin_has_claimed_this_instance_yet_claim_c5c1f5e4")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{l10n("local.claim_this_instance_b7c7de5d")}</Button>
        <span className="text-sm text-muted-foreground">
          {l10n("local.signed_in_as_abc50e33")}{" "}<span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {l10n("local.wrong_account_18c5fd3f")}{" "}
        <a href="/auth?next=/" className="underline underline-offset-2">
          {l10n("local.switch_account_fedce010")}</a>
        .
      </p>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimingPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.no_admin_has_claimed_this_instance_yet_claim_c5c1f5e4")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled>
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
          {l10n("local.claiming_702f4ab2")}</Button>
        <span className="text-sm text-muted-foreground">
          {l10n("local.signed_in_as_abc50e33")}{" "}<span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimErrorPrivate() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.no_admin_has_claimed_this_instance_yet_claim_c5c1f5e4")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button>{l10n("local.claim_this_instance_b7c7de5d")}</Button>
        <span className="text-sm text-muted-foreground">
          {l10n("local.signed_in_as_abc50e33")}{" "}<span className="font-medium text-foreground">jane@appliance.local</span>
        </span>
      </div>
      <div
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{l10n("local.someone_else_has_already_claimed_this_instanc_e9efa2de")}</p>
          <p className="mt-1 text-destructive/90">
            {l10n("local.refresh_to_sign_in_or_ask_the_existing_admin_fc9a1860")}{" "}
            <span className="font-mono">{l10n("local.settings_access_aaed726a")}</span>.
          </p>
        </div>
      </div>
      <CliFallback hasActiveInvite={false} />
    </StateChrome>
  );
}

function ClaimSuccess() {
  return (
    <StateChrome>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{l10n("local.you_rsquo_re_the_instance_admin_7d8d8846")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {l10n("local.setup_is_complete_taking_you_to_onboarding_to_11fcafc7")}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">{l10n("local.redirecting_hellip_9ca1c668")}</span>
      </div>
      <div className="mt-5">
        <Button asChild variant="outline">
          <a href="/">{l10n("local.continue_to_dashboard_740e1ec1")}</a>
        </Button>
      </div>
    </StateChrome>
  );
}

function PublicInviteOnly() {
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.this_paperclip_is_waiting_on_its_first_admin_fe4cc591")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.this_instance_runs_in_invite_only_mode_the_op_3baa02b4")}</p>
      <CliFallback hasActiveInvite />
      <p className="mt-4 text-xs text-muted-foreground">
        {l10n("local.browser_based_claim_is_intentionally_disabled_2046695a")}</p>
    </StateChrome>
  );
}

const FIXTURE_BODIES: Record<LabFixtureKey, ReactElement> = {
  "signed-out-private": <SignedOutPrivate />,
  "signed-in-private": <SignedInPrivate />,
  claiming: <ClaimingPrivate />,
  "claim-error": <ClaimErrorPrivate />,
  "claim-success": <ClaimSuccess />,
  "public-invite-only": <PublicInviteOnly />,
};

export function BootstrapSetupUxLab() {
  return (
    <div className="bg-background min-h-screen pb-16">
      <header className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{l10n("local.ux_lab_ff3eaed8")}</p>
          <h1 className="mt-1 text-2xl font-semibold">{l10n("local.bootstrap_pending_setup_states_0720bb20")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {l10n("local.fixtures_for_the_bootstrap_pending_screen_in_52260e49")}{" "}<span className="font-mono">CloudAccessGate</span>{l10n("local._used_as_the_ux_spec_for_3f7eb048")}{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10113">
              PAP-10113
            </a>{" "}
            {l10n("local.and_the_implementation_reference_for_a8b9615c")}{" "}
            <a className="underline underline-offset-2" href="/PAP/issues/PAP-10114">
              PAP-10114
            </a>
            {l10n("local._the_browser_claim_cta_only_appears_when_815915c4")}{" "}
            <span className="font-mono">deploymentMode === &quot;authenticated&quot;</span> {l10n("local.and_6201111b")}{" "}
            <span className="font-mono">deploymentExposure === &quot;private&quot;</span>.
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-12 px-6 pt-10">
        {FIXTURE_ORDER.map((key) => (
          <section key={key} aria-labelledby={`lab-${key}`}>
            <h2
              id={`lab-${key}`}
              className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              {FIXTURE_LABELS[key]}
            </h2>
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 p-2">
              {FIXTURE_BODIES[key]}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
