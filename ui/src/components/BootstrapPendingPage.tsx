import { l10n } from "../i18n";
import type { ReactNode } from "react";
import { Loader2, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { BOOTSTRAP_FALLBACK_COMMAND } from "@/bootstrapSetup";
import type { AuthSession } from "@paperclipai/shared";
import { Card } from "@/components/ui/card";

type BootstrapPendingPageProps = {
  claimAvailable: boolean;
  hasActiveInvite?: boolean;
  session: AuthSession | null | undefined;
  claimState: "idle" | "claiming" | "success";
  claimError?: { status?: number; message?: string } | null;
  onClaim: () => void;
};

function CliFallback({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Terminal className="size-4 text-muted-foreground" aria-hidden />
        <span>{l10n("local.prefer_to_finish_setup_from_the_host_d29e5c6f")}</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasActiveInvite
          ? l10n("local.a_bootstrap_invite_is_already_active_check_yo_3c8fb492")
          : l10n("local.run_this_command_on_the_host_that_runs_paperc_ca2f606a")}
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

function displayIdentity(session: AuthSession) {
  return session.user.email || session.user.name || session.user.id;
}

function claimErrorCopy(error: BootstrapPendingPageProps["claimError"]) {
  if (error?.status === 409) {
    return {
      title: l10n("local.someone_else_has_already_claimed_this_instanc_e9efa2de"),
      body: "Refresh to sign in, or ask the existing admin to invite you from Settings -> Access.",
    };
  }
  if (error?.status === 401) {
    return {
      title: l10n("local.your_session_expired_sign_in_again_to_claim_t_7c6edab3"),
      body: "",
    };
  }
  return {
    title: l10n("local.we_couldn_t_reach_the_server_try_again_in_a_m_2fca89bf"),
    body: "",
  };
}

export function BootstrapPendingPage({
  claimAvailable,
  hasActiveInvite = false,
  session,
  claimState,
  claimError,
  onClaim,
}: BootstrapPendingPageProps) {
  if (!claimAvailable) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{l10n("local.this_paperclip_is_waiting_on_its_first_admin_fe4cc591")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {l10n("local.this_instance_runs_in_invite_only_mode_the_op_b781534e")}</p>
        <CliFallback hasActiveInvite={hasActiveInvite} />
        <p className="mt-4 text-xs text-muted-foreground">
          {l10n("local.browser_based_claim_is_intentionally_disabled_bbdfcda4")}</p>
      </StateChrome>
    );
  }

  if (claimState === "success") {
    return (
      <StateChrome>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{l10n("local.you_re_the_instance_admin_7b0496df")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {l10n("local.setup_is_complete_taking_you_to_onboarding_to_6e267116")}</p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-sm text-muted-foreground">{l10n("local.redirecting_cd23991b")}</span>
        </div>
        <div className="mt-5">
          <Button asChild variant="outline">
            <a href="/">{l10n("local.continue_to_dashboard_740e1ec1")}</a>
          </Button>
        </div>
      </StateChrome>
    );
  }

  if (!session) {
    return (
      <StateChrome>
        <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {l10n("local.no_admin_has_claimed_this_instance_yet_sign_i_dcabbf1b")}</p>
        <div className="mt-5">
          <Button asChild>
            <Link to="/auth?next=/">{l10n("local.sign_in_create_account_5d4f5eb1")}</Link>
          </Button>
        </div>
        <CliFallback hasActiveInvite={hasActiveInvite} />
      </StateChrome>
    );
  }

  const errorCopy = claimErrorCopy(claimError);
  const isClaiming = claimState === "claiming";
  return (
    <StateChrome>
      <h1 className="text-xl font-semibold">{l10n("local.finish_setting_up_this_paperclip_fd728e25")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {l10n("local.no_admin_has_claimed_this_instance_yet_claim_c5c1f5e4")}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={onClaim} disabled={isClaiming}>
          {isClaiming && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {isClaiming ? l10n("local.claiming_a07badb5") : l10n("local.claim_this_instance_b7c7de5d")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {l10n("local.signed_in_as_abc50e33")}{" "}<span className="font-medium text-foreground">{displayIdentity(session)}</span>
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {l10n("local.wrong_account_18c5fd3f")}{" "}
        <Link to="/auth?next=/" className="underline underline-offset-2">
          {l10n("local.switch_account_fedce010")}</Link>
        .
      </p>
      {claimError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" aria-hidden />
          <div>
            <p className="font-medium">{errorCopy.title}</p>
            {errorCopy.body && <p className="mt-1 text-destructive/90">{errorCopy.body}</p>}
          </div>
        </div>
      )}
      <CliFallback hasActiveInvite={hasActiveInvite} />
    </StateChrome>
  );
}
