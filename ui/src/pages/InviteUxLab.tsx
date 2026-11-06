import { l10n } from "../i18n";
// token-extraction: allowlisted — intentional one-off decoration (DECISION-SHEET.md B1
// user ruling). The bg-[...gradient...] / shadow-[...] literals in this demo/UX-lab page
// are deliberate one-off decoration, reverted from --gradient-extract-*/--shadow-extract-*
// tokens; the file is on the check-token-gates allowlist in ui/src/index.css.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Link2,
  Loader2,
  MailPlus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: l10n("local.viewer_678bfa6a"),
    description: l10n("local.can_view_organization_work_and_follow_along_c0074ebb"),
    gets: l10n("local.view_only_organization_membership_f5ae52ac"),
  },
  {
    value: "operator",
    label: l10n("local.operator_291101a0"),
    description: l10n("local.recommended_for_people_who_need_to_help_run_w_2090f335"),
    gets: l10n("local.can_assign_tasks_656878c3"),
  },
  {
    value: "admin",
    label: l10n("local.admin_c1c224b0"),
    description: l10n("local.recommended_for_operators_who_need_to_invite_508b27fb"),
    gets: l10n("local.can_create_agents_invite_users_assign_tasks_a_21f5dfbb"),
  },
  {
    value: "owner",
    label: l10n("local.owner_4b1b8aa3"),
    description: l10n("local.full_organization_access_including_membership_050eacd9"),
    gets: l10n("local.everything_in_admin_plus_managing_members_0064ba82"),
  },
] as const;

const inviteHistory = [
  {
    id: "invite-active",
    state: "Active",
    humanRole: "operator",
    invitedByNumber: 25,
    email: "board25@paperclip.local",
    createdAt: "2026-04-25T09:00:00+08:00",
    action: "Revoke",
    relatedLabel: "Review request",
  },
  {
    id: "invite-accepted",
    state: "Accepted",
    humanRole: "viewer",
    invitedByNumber: 24,
    email: "board24@paperclip.local",
    createdAt: "2026-04-24T08:15:00+08:00",
    action: "Inactive",
    relatedLabel: "—",
  },
  {
    id: "invite-revoked",
    state: "Revoked",
    humanRole: "admin",
    invitedByNumber: 20,
    email: "board20@paperclip.local",
    createdAt: "2026-04-20T14:45:00+08:00",
    action: "Inactive",
    relatedLabel: "—",
  },
  {
    id: "invite-expired",
    state: "Expired",
    humanRole: "owner",
    invitedByNumber: 19,
    email: "board19@paperclip.local",
    createdAt: "2026-04-19T19:10:00+08:00",
    action: "Inactive",
    relatedLabel: "—",
  },
] as const;

const fieldClassName =
  "w-full border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const panelClassName = "border border-zinc-800 bg-zinc-950/95 p-6";

const inviteStateLabels: Record<(typeof inviteHistory)[number]["state"], string> = {
  Active: l10n("local.active_96879611"),
  Accepted: l10n("local.accepted_a00fb0c5"),
  Revoked: l10n("local.revoked_f6f738d0"),
  Expired: l10n("local.expired_424a2551"),
};

function inviteRoleLabel(role: (typeof inviteHistory)[number]["humanRole"]): string {
  return inviteRoleOptions.find((option) => option.value === role)?.label ?? role;
}

function LabSection({
  eyebrow,
  title,
  description,
  accentClassName,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-(--rad-28) border border-border/70 bg-background/80 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-5",
        accentClassName,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function StatusCard({
  icon,
  title,
  body,
  tone = "default",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone?: "default" | "warn" | "success" | "error";
}) {
  const toneClassName = {
    default: "border-border/70 bg-background/85",
    warn: "border-amber-400/40 bg-amber-500/[0.08]",
    success: "border-emerald-400/40 bg-emerald-500/[0.08]",
    error: "border-rose-400/40 bg-rose-500/[0.08]",
  }[tone];

  return (
    <Card className={cn("rounded-(--rad-24) shadow-none", toneClassName)}>
      <CardHeader className="space-y-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-current/10 bg-background/70 text-muted-foreground">
          {icon}
        </div>
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="mt-2 text-sm leading-6">{body}</CardDescription>
        </div>
      </CardHeader>
    </Card>
  );
}

function InviteLandingShell({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-zinc-800 bg-zinc-950 shadow-[0_30px_80px_rgba(2,6,23,0.55)]">
      <div className="grid gap-px bg-zinc-800 lg:grid-cols-(--gtc-37)">
        <section className={cn(panelClassName, "space-y-6 bg-zinc-950")}>{left}</section>
        <section className={cn(panelClassName, "h-full bg-zinc-950")}>{right}</section>
      </div>
    </div>
  );
}

function InviteSummaryPanel({
  title,
  description,
  inviteMessage,
  requestedAccess,
  signedInLabel,
}: {
  title: string;
  description: string;
  inviteMessage?: string;
  requestedAccess: string;
  signedInLabel?: string;
}) {
  return (
    <>
      <div className="flex items-start gap-4">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-16 w-16 rounded-none border border-zinc-800"
        />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{l10n("local.you_apos_ve_been_invited_to_join_paperclip_1b4757e7")}</p>
          <h3 className="mt-2 text-2xl font-semibold text-zinc-100">{title}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">{description}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetaCard label={l10n("local.organization_d764d425")} value="Acme Robotics" />
        <MetaCard label={l10n("local.invited_by_c7a6f156")} value={l10n("local.board_user_10300714")} />
        <MetaCard label={l10n("local.requested_access_82303475")} value={requestedAccess} />
        <MetaCard
          label={l10n("local.invite_expires_2a91147e")}
          value={formatDate("2027-03-07T00:00:00+08:00")}
        />
      </div>

      {inviteMessage ? (
        <div className="border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="text-xs uppercase tracking-(--tracking-caps) text-amber-200/80">{l10n("local.message_from_inviter_7a1ef687")}</div>
          <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
        </div>
      ) : null}

      {signedInLabel ? (
        <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50">
          {l10n("local.signed_in_as_abc50e33")}{" "}<span className="font-medium">{signedInLabel}</span>.
        </div>
      ) : null}
    </>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 p-3">
      <div className="text-xs uppercase tracking-(--tracking-caps) text-zinc-500">{label}</div>
      <div className="mt-1 text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function InlineAuthPreview({
  mode,
  feedback,
  working,
}: {
  mode: "sign_up" | "sign_in";
  feedback?: { tone: "info" | "error"; text: string };
  working?: boolean;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">
          {mode === "sign_up" ? l10n("local.create_your_account_9e709348") : l10n("local.sign_in_to_continue_607a8012")}
        </h3>
        <p className="mt-1 text-sm text-zinc-400">
          {mode === "sign_up"
            ? l10n("local.invite_create_alice_account_demo")
            : l10n("local.use_the_paperclip_account_that_already_matche_9e291057")}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_up"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >
          {l10n("local.create_account_798ca2ce")}</button>
        <button
          type="button"
          className={cn(
            "flex-1 border px-3 py-2 text-sm transition-colors",
            mode === "sign_in"
              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
              : "border-zinc-800 text-zinc-300 hover:border-zinc-600",
          )}
        >
          {l10n("local.i_already_have_an_account_86975132")}</button>
      </div>

      <form className="space-y-4">
        {mode === "sign_up" ? (
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">{l10n("local.name_dcd1d522")}</span>
            <input
              name="name"
              className={fieldClassName}
              defaultValue={l10n("local.jane_example_eea33f8b")}
              readOnly
            />
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{l10n("local.email_969ccbd3")}</span>
          <input name="email" type="email" className={fieldClassName} defaultValue="jane@example.com" readOnly />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{l10n("local.password_e7cf3ef4")}</span>
          <input name="password" type="password" className={fieldClassName} defaultValue="supersecret" readOnly />
        </label>
        {feedback ? (
          <p className={cn("text-xs", feedback.tone === "info" ? "text-amber-300" : "text-red-400")}>
            {feedback.text}
          </p>
        ) : null}
        <Button type="button" className="w-full rounded-none" disabled={working}>
          {working ? l10n("local.working_b93900bd") : mode === "sign_in" ? l10n("local.sign_in_and_continue_a3f73fb5") : l10n("local.create_account_and_continue_b0864af3")}
        </Button>
      </form>

      <p className="text-xs leading-5 text-zinc-500">
        {mode === "sign_up"
          ? l10n("local.already_signed_up_before_use_the_existing_acc_7dca18c0")
          : l10n("local.no_account_yet_switch_back_to_create_account_de9f7996")}
      </p>
    </div>
  );
}

function AgentRequestPreview() {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{l10n("local.submit_agent_details_aeeee10b")}</h3>
        <p className="mt-1 text-sm text-zinc-400">
          {l10n("local.this_invite_will_create_an_approval_request_f_5d33053d")}</p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{l10n("local.agent_name_1cfb2187")}</span>
        <input
          className={fieldClassName}
          defaultValue={l10n("local.acme_ops_agent_10300715")}
          readOnly
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{l10n("local.adapter_type_03298f66")}</span>
        <select className={fieldClassName} defaultValue="codex_local" disabled>
          <option value="codex_local">Codex</option>
          <option value="claude_local">{l10n("local.claude_code_246ef8c1")}</option>
          <option value="cursor">Cursor</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{l10n("local.capabilities_9460f16a")}</span>
        <textarea
          className={fieldClassName}
          rows={4}
          defaultValue={l10n("local.reviews_invites_triages_requests_10300716")}
          readOnly
        />
      </label>
      <Button type="button" className="w-full rounded-none">
        {l10n("local.submit_request_917e144e")}</Button>
    </div>
  );
}

function AcceptInvitePreview({
  autoAccept,
  isCurrentMember,
  error,
}: {
  autoAccept?: boolean;
  isCurrentMember?: boolean;
  error?: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">{l10n("local.accept_organization_invite_6bc71342")}</h3>
        <p className="mt-1 text-sm text-zinc-400">
          {autoAccept
            ? l10n("local.granting_your_access_to_acme_robotics_206aa543")
            : isCurrentMember
              ? l10n("local.this_account_already_belongs_to_acme_robotics_c4f155c2")
              : l10n("local.this_will_grant_or_complete_your_access_to_ac_aaf163cc")}
        </p>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {autoAccept ? (
        <div className="text-sm text-zinc-400">{l10n("local.submitting_request_20eef59e")}</div>
      ) : (
        <Button type="button" className="w-full rounded-none" disabled={isCurrentMember}>
          {l10n("local.accept_invite_5e3f840e")}</Button>
      )}
    </div>
  );
}

function InviteResultPreview({
  title,
  description,
  claimSecret,
  onboardingTextUrl,
  joinedNow = false,
}: {
  title: string;
  description: string;
  claimSecret?: string;
  onboardingTextUrl?: string;
  joinedNow?: boolean;
}) {
  return (
    <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
      <div className="flex items-center gap-3">
        <CompanyPatternIcon
          companyName="Acme Robotics"
          logoUrl="/api/invites/pcp_invite_test/logo"
          className="h-12 w-12 rounded-none border border-zinc-800"
        />
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="mt-4 space-y-3">
        <p className="text-sm text-zinc-400">{description}</p>
        {joinedNow ? (
          <Button type="button" className="w-full rounded-none">
            {l10n("local.open_board_673ae824")}</Button>
        ) : (
          <>
            <div className="border border-zinc-800 p-3">
              <p className="mb-1 text-xs text-zinc-500">{l10n("local.approval_page_ea630b31")}</p>
              <a className="text-sm text-zinc-200 underline underline-offset-2" href="/company/settings/members">
                {l10n("local.settings_members_790e2ba9")}</a>
            </div>
            <p className="text-xs text-zinc-500">
              {l10n("local.refresh_this_page_after_you_apos_ve_been_appr_c4b2b6a1")}</p>
          </>
        )}
        {claimSecret ? (
          <div className="space-y-1 border border-zinc-800 p-3 text-xs text-zinc-400">
            <div className="text-zinc-200">{l10n("local.claim_secret_97a5b1cd")}</div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">POST /api/agents/claim-api-key</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="text-xs text-zinc-400">
            {l10n("local.onboarding_0746afad")}{" "}<span className="font-mono break-all">{onboardingTextUrl}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AuthScreenPreview({ mode, error }: { mode: "sign_in" | "sign_up"; error?: string }) {
  return (
    <div className="overflow-hidden rounded-(--rad-28) border border-border/70 bg-background shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
      <div className="grid gap-px bg-border/60 md:grid-cols-2">
        <div className="flex min-h-(--sz-420px) flex-col justify-center bg-background px-8 py-10">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-8 flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Alice</span>
            </div>
            <h3 className="text-xl font-semibold">
              {mode === "sign_in" ? l10n("local.sign_in_to_paperclip_315a9e5c") : l10n("local.create_your_paperclip_account_f6c4b1d0")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "sign_in"
                ? l10n("local.use_your_email_and_password_to_access_this_in_7665f3a5")
                : l10n("local.create_an_account_for_this_instance_email_con_fa7492f5")}
            </p>
            <div className="mt-6 space-y-4">
              {mode === "sign_up" ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{l10n("local.name_dcd1d522")}</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    defaultValue="Jane Example"
                    readOnly
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{l10n("local.email_969ccbd3")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="jane@example.com"
                  readOnly
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">{l10n("local.password_e7cf3ef4")}</span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  defaultValue="supersecret"
                  readOnly
                />
              </label>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <Button type="button" className="w-full">
                {mode === "sign_in" ? l10n("local.sign_in_bcc0bcc9") : l10n("local.create_account_0dffe234")}
              </Button>
            </div>
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? l10n("local.need_an_account_d24daaf3") : l10n("local.already_have_an_account_e77fea93")}{" "}
              <span className="font-medium text-foreground underline underline-offset-2">
                {mode === "sign_in" ? l10n("local.create_one_b6ab95ea") : l10n("local.sign_in_bfd402b2")}
              </span>
            </div>
          </div>
        </div>
        <div className="hidden min-h-(--sz-420px) items-center justify-center bg-[radial-gradient(circle_at_top,rgba(8,145,178,0.18),transparent_48%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,1))] px-8 py-10 md:flex">
          <div className="max-w-sm space-y-4 text-zinc-200">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-cyan-200">
              {l10n("local.auth_preview_cd8d229e")}</div>
            <div className="text-2xl font-semibold">{l10n("local.side_by_side_signup_styling_review_452317df")}</div>
            <p className="text-sm leading-6 text-zinc-400">
              {l10n("local.this_frame_mirrors_the_production_auth_surfac_69b54ce9")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompanyInvitesPreview() {
  return (
    <div className="grid gap-5 xl:grid-cols-(--gtc-38)">
      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MailPlus className="h-4 w-4" />
            {l10n("local.organization_invites_9a3fb1f8")}</div>
          <div>
            <CardTitle>{l10n("local.create_invite_9f395b8f")}</CardTitle>
            <CardDescription className="mt-2">
              {l10n("local.generate_a_human_invite_link_and_choose_the_d_dd31c56f")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{l10n("local.choose_a_role_a49c49b0")}</legend>
            <div className="rounded-2xl border border-border">
              {inviteRoleOptions.map((option, index) => (
                <label
                  key={option.value}
                  className={cn("flex cursor-default gap-3 px-4 py-4", index > 0 && "border-t border-border")}
                >
                  <input
                    type="radio"
                    readOnly
                    checked={option.value === "operator"}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {l10n("local.default_21b111cb")}</Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            {l10n("local.each_invite_link_is_single_use_human_invitees_87964037")}</div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button">{l10n("local.create_invite_9f395b8f")}</Button>
            <span className="text-sm text-muted-foreground">{l10n("local.invite_history_below_keeps_the_audit_trail_03076923")}</span>
          </div>

          <div className="space-y-3 rounded-2xl border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{l10n("local.latest_invite_link_ee47fab1")}</div>
                <div className="text-sm text-muted-foreground">
                  {l10n("local.this_url_includes_the_current_paperclip_domai_3bad0330")}</div>
              </div>
              <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                <Check className="h-3.5 w-3.5" />
                {l10n("local.copied_8d525e5f")}</div>
            </div>
            <button
              type="button"
              className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-left text-sm break-all"
            >
              https://paperclip.local/invite/new-token
            </button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline">
                <ExternalLink className="h-4 w-4" />
                {l10n("local.open_invite_f2018a34")}</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-(--rad-28) shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{l10n("local.invite_history_0269fea6")}</CardTitle>
              <CardDescription className="mt-2">
                {l10n("local.review_invite_status_role_inviter_and_any_lin_5844b5da")}</CardDescription>
            </div>
            <a href="/inbox/requests" className="text-sm underline underline-offset-4">
              {l10n("local.open_join_request_queue_3f3aa696")}</a>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.state_a3b50c47")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.role_14736a2e")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.invited_by_c7a6f156")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.created_d70b9e24")}</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">{l10n("local.join_request_d7d9cd19")}</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">{l10n("local.action_64cff131")}</th>
                </tr>
              </thead>
              <tbody>
                {inviteHistory.map((invite) => (
                  <tr key={invite.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-3 align-top">
                      <Badge variant="outline" className="border-border text-muted-foreground">
                        {inviteStateLabels[invite.state]}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 align-top">{inviteRoleLabel(invite.humanRole)}</td>
                    <td className="px-5 py-3 align-top">
                      <div>{l10n("local.board_user_number_10300713", { v0: invite.invitedByNumber })}</div>
                      <div className="text-xs text-muted-foreground">{invite.email}</div>
                    </td>
                    <td className="px-5 py-3 align-top text-muted-foreground">
                      {formatDateTime(invite.createdAt)}
                    </td>
                    <td className="px-5 py-3 align-top">
                      {invite.relatedLabel === "Review request" ? (
                        <a href="/inbox/requests" className="underline underline-offset-4">
                          {l10n("local.review_request_dcea8abb")}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{invite.relatedLabel}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      {invite.action === "Revoke" ? (
                        <Button type="button" size="sm" variant="outline">
                          {l10n("local.revoke_87e6d00b")}</Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{l10n("local.inactive_ac7c949f")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-border p-4">
              <div className="text-sm font-medium">{l10n("local.empty_history_state_4639af99")}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {l10n("local.no_invites_have_been_created_for_this_organiz_c20447f4")}</div>
            </div>
            <div className="rounded-2xl border border-rose-400/40 bg-rose-500/[0.07] p-4">
              <div className="text-sm font-medium text-foreground">{l10n("local.permission_error_56ac4aeb")}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {l10n("local.you_do_not_have_permission_to_manage_organiza_e61b9719")}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function InviteUxLab() {
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-(--rad-32) border border-border/70 bg-[linear-gradient(135deg,rgba(8,145,178,0.10),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.10),transparent_44%),var(--background)] shadow-[0_30px_80px_rgba(15,23,42,0.10)]">
        <div className="grid gap-6 lg:grid-cols-(--gtc-39)">
          <div className="p-6 sm:p-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-cyan-700 dark:text-cyan-300">
              <FlaskConical className="h-3.5 w-3.5" />
              {l10n("local.invite_ux_lab_0e9b88f6")}</div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{l10n("local.invite_and_signup_ux_review_surface_13f14e40")}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {l10n("local.this_page_collects_the_current_invite_landing_dc4a122d")}</p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                /tests/ux/invites
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {l10n("local.signup_invite_states_bef464b7")}</Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1 text-(length:--text-nano) uppercase tracking-(--tracking-caps)">
                {l10n("local.fixture_backed_preview_b57c2288")}</Badge>
            </div>
          </div>

          <aside className="border-t border-border/60 bg-background/70 p-6 lg:border-l lg:border-t-0">
            <div className="mb-4 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              {l10n("local.covered_states_0e6b1d07")}</div>
            <div className="space-y-3">
              {[
                l10n("local.invite_loading_access_check_states_10300717"),
                l10n("local.inline_account_creation_variants_10300718"),
                l10n("local.human_accept_agent_request_transitions_10300719"),
                l10n("local.pending_approval_joined_now_screens_10300720"),
                l10n("local.organization_invite_creation_states_10300721"),
              ].map((highlight) => (
                <div
                  key={highlight}
                  className="rounded-2xl border border-border/70 bg-background/85 px-4 py-3 text-sm text-muted-foreground"
                >
                  {highlight}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <LabSection
        eyebrow={l10n("local.top_level_states_10300722")}
        title={l10n("local.landing_state_coverage_a1f8df69")}
        description={l10n("local.small_cards_for_the_fast_return_invite_states_268cf5ee")}
        accentClassName="bg-[linear-gradient(180deg,rgba(59,130,246,0.05),transparent_30%),var(--background)]"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatusCard
            icon={<Loader2 className="h-4 w-4 animate-spin" />}
            title={l10n("local.loading_invite_bf6ade87")}
            body={l10n("local.shown_while_invite_summary_deployment_mode_or_b603cfe2")}
          />
          <StatusCard
            icon={<Clock3 className="h-4 w-4" />}
            title={l10n("local.checking_your_access_d788caa3")}
            body={l10n("local.shown_after_sign_in_while_the_app_verifies_wh_0b6beda1")}
          />
          <StatusCard
            icon={<KeyRound className="h-4 w-4" />}
            title={l10n("local.invalid_invite_token_1bc93e4d")}
            body={l10n("local.the_token_is_missing_entirely_so_the_page_sho_c25dc503")}
            tone="error"
          />
          <StatusCard
            icon={<Link2 className="h-4 w-4" />}
            title={l10n("local.invite_not_available_87b8d3c0")}
            body={l10n("local.used_for_expired_revoked_already_consumed_or_2e7dc227")}
            tone="warn"
          />
          <StatusCard
            icon={<ShieldCheck className="h-4 w-4" />}
            title={l10n("local.bootstrap_complete_51f233e3")}
            body={l10n("local.result_screen_for_bootstrap_ceo_invites_after_39b0bfaa")}
            tone="success"
          />
          <StatusCard
            icon={<ArrowRight className="h-4 w-4" />}
            title={l10n("local.auto_accept_in_progress_3c5e9c76")}
            body={l10n("local.signed_in_human_users_skip_the_extra_button_c_93f9e67a")}
          />
          <StatusCard
            icon={<Users className="h-4 w-4" />}
            title={l10n("local.already_a_member_1739ed7c")}
            body={l10n("local.acceptance_stays_disabled_and_the_page_redire_8c1f60a9")}
          />
          <StatusCard
            icon={<UserPlus className="h-4 w-4" />}
            title={l10n("local.invite_result_surfaces_2e75b962")}
            body={l10n("local.both_pending_approval_and_joined_now_confirma_832994b4")}
            tone="success"
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={l10n("local.invite_landing_10300723")}
        title={l10n("local.split_screen_invite_flows_3d088c51")}
        description={l10n("local.these_frames_mirror_the_production_invite_sur_a0ef3ab2")}
        accentClassName="bg-[linear-gradient(180deg,rgba(234,179,8,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={l10n("local.join_acme_robotics_c811b50d")}
                description={l10n("local.create_your_paperclip_account_first_if_you_al_9a84bdf6")}
                inviteMessage={l10n("local.welcome_aboard_0d7f4488")}
                requestedAccess={l10n("local.operator_291101a0")}
              />
            }
            right={<InlineAuthPreview mode="sign_up" />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={l10n("local.join_acme_robotics_c811b50d")}
                description={l10n("local.create_your_paperclip_account_first_if_you_al_9a84bdf6")}
                inviteMessage={l10n("local.welcome_aboard_0d7f4488")}
                requestedAccess={l10n("local.operator_291101a0")}
              />
            }
            right={
              <InlineAuthPreview
                mode="sign_in"
                feedback={{
                  tone: "info",
                  text: l10n("local.account_exists_sign_in_to_continue_10300724"),
                }}
              />
            }
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={l10n("local.join_acme_robotics_c811b50d")}
                description={l10n("local.your_account_is_ready_review_the_invite_detai_08185f11")}
                inviteMessage={l10n("local.welcome_aboard_0d7f4488")}
                requestedAccess={l10n("local.operator_291101a0")}
                signedInLabel={l10n("local.jane_example_eea33f8b")}
              />
            }
            right={<AcceptInvitePreview autoAccept />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={l10n("local.join_acme_robotics_c811b50d")}
                description={l10n("local.review_the_invite_details_then_submit_the_age_98fb0b9b")}
                requestedAccess={l10n("local.agent_join_request_b6d6c8b8")}
              />
            }
            right={<AgentRequestPreview />}
          />

          <InviteLandingShell
            left={
              <InviteSummaryPanel
                title={l10n("local.join_acme_robotics_c811b50d")}
                description={l10n("local.your_account_is_ready_review_the_invite_detai_08185f11")}
                requestedAccess={l10n("local.operator_291101a0")}
                signedInLabel={l10n("local.jane_example_eea33f8b")}
              />
            }
            right={
              <AcceptInvitePreview
                error={l10n("local.account_already_belongs_to_organization_10300725")}
                isCurrentMember
              />
            }
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={l10n("local.result_states_10300726")}
        title={l10n("local.approval_and_completion_screens_fc337f81")}
        description={l10n("local.these_are_the_post_submit_states_returned_fro_79b2fa7d")}
        accentClassName="bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent_30%),var(--background)]"
      >
        <div className="grid gap-5 xl:grid-cols-3">
          <InviteResultPreview
            title={l10n("local.request_to_join_acme_robotics_814dff95")}
            description={l10n("local.board_user_must_approve_your_request_to_join_c0d47428")}
            claimSecret="pcp_claim_secret_demo"
            onboardingTextUrl="/api/invites/pcp_invite_test/onboarding.txt"
          />
          <InviteResultPreview
            title={l10n("local.you_joined_the_organization_f7f8d22c")}
            description={l10n("local.your_account_already_matched_the_approved_inv_45ec6ed1")}
            joinedNow
          />
          <InviteResultPreview
            title={l10n("local.request_to_join_acme_robotics_814dff95")}
            description={l10n("local.ask_them_to_visit_settings_members_to_approve_cc6d6cd4")}
          />
        </div>
      </LabSection>

      <LabSection
        eyebrow={l10n("local.standalone_auth_10300727")}
        title={l10n("local.auth_page_states_56ab5f04")}
        description={l10n("local.the_general_auth_page_uses_a_different_compos_1b78eeba")}
        accentClassName="bg-[linear-gradient(180deg,rgba(168,85,247,0.06),transparent_28%),var(--background)]"
      >
        <div className="space-y-5">
          <AuthScreenPreview
            mode="sign_in"
            error={l10n("local.invalid_email_or_password_10300728")}
          />
          <AuthScreenPreview mode="sign_up" />
        </div>
      </LabSection>

      <LabSection
        eyebrow={l10n("local.settings_74a883a0")}
        title={l10n("local.organization_invite_management_bfc76b32")}
        description={l10n("local.this_section_captures_the_board_side_invite_c_9034f5ba")}
        accentClassName="bg-[linear-gradient(180deg,rgba(244,114,182,0.06),transparent_28%),var(--background)]"
      >
        <CompanyInvitesPreview />
      </LabSection>
    </div>
  );
}
