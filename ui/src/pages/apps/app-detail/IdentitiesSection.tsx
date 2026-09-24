import { l10n } from "../../../i18n";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Loader2, Lock, RefreshCw, TriangleAlert, UserRound } from "lucide-react";
import type {
  ConnectionAudienceMember,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/Identity";
import { GithubIcon } from "@/components/icons/github-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineBanner } from "@/components/InlineBanner";
import { MemberMultiSelect } from "@/components/MemberMultiSelect";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "@/lib/router";
import { brandBanner, brandChipBadge } from "@/lib/status-colors";
import { agentUrl, cn } from "@/lib/utils";
import {
  audienceUserIds,
  grantAccountLabel,
  grantStatusLabel,
  grantStatusTone,
  memberLabel,
  organizationGrant,
  personalGrantFor,
  type GrantStatusTone,
} from "../connection-identity";

const STATUS_CHIP: Record<GrantStatusTone, string> = {
  connected: brandChipBadge.green,
  attention: brandChipBadge.amber,
  inactive: brandChipBadge.gray,
  missing: brandChipBadge.gray,
};

function StatusText({ status }: { status: ConnectionGrant["status"] | null }) {
  const tone = grantStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_CHIP[tone],
      )}
    >
      {grantStatusLabel(status)}
    </span>
  );
}

/**
 * Fixed identity for the connection Setup tab.
 *
 * The chosen personal/organization type comes from the connection policy and
 * the alternative is not rendered after setup. Every action is rendered from
 * a server capability — a policy-forbidden action is absent rather than
 * disabled, so a viewer sees the same legible state with no controls at all.
 */
export function IdentitiesSection({
  appName,
  credentialPolicy,
  ownerUserId,
  connectedUser,
  dedicatedAgent,
  grantsQuery,
  loading,
  error,
  onConnectAsMe,
  onConnectOrganization,
  onConnectAgent,
  onRefreshAccess,
  refreshAccessPending = false,
  onReplaceAudience,
  connectPending,
  audiencePending,
  audienceError,
  audienceGrantId,
  onOpenAudience,
  onCloseAudience,
}: {
  appName: string;
  credentialPolicy: ToolConnectionCredentialPolicy;
  ownerUserId: string | null;
  connectedUser: { label: string; image: string | null } | null;
  dedicatedAgent: { id: string; name: string; urlKey?: string | null } | null;
  grantsQuery: ConnectionGrantsResponse | undefined;
  loading: boolean;
  error: boolean;
  onConnectAsMe: () => void;
  onConnectOrganization: () => void;
  onConnectAgent: (agentId: string) => void;
  onRefreshAccess?: () => void;
  refreshAccessPending?: boolean;
  onReplaceAudience: (grant: ConnectionGrant, memberUserIds: string[]) => void;
  connectPending: boolean;
  audiencePending: boolean;
  audienceError: string | null;
  /**
   * The audience dialog is controlled by the page, not this section: a save that
   * the server rejects has to keep the dialog open with the selection intact,
   * which only the mutation's outcome knows.
   */
  audienceGrantId: string | null;
  onOpenAudience: (grantId: string) => void;
  onCloseAudience: () => void;
}) {
  const grants = grantsQuery?.grants ?? [];
  const capabilities = grantsQuery?.capabilities;
  const currentUserId = grantsQuery?.currentUserId ?? null;
  const members = grantsQuery?.members ?? [];
  const orgGrant = useMemo(() => organizationGrant(grants), [grants]);
  const myGrant = useMemo(() => personalGrantFor(grants, currentUserId), [grants, currentUserId]);
  const personalGrant = useMemo(() => {
    const personalGrants = grants.filter((grant) => grant.kind === "user");
    return personalGrants.find((grant) => grant.subjectUserId === ownerUserId)
      ?? myGrant
      ?? personalGrants.find((grant) => grant.status === "active")
      ?? personalGrants[0]
      ?? null;
  }, [grants, myGrant, ownerUserId]);
  const agentGrant = useMemo(
    () => grants.find((grant) => grant.kind === "agent" && grant.subjectAgentId === dedicatedAgent?.id)
      ?? grants.find((grant) => grant.kind === "agent")
      ?? null,
    [dedicatedAgent?.id, grants],
  );
  const personalSubjectLabel = memberLabel(
    members,
    personalGrant?.subjectUserId ?? ownerUserId ?? currentUserId,
  );
  const usesPersonalIdentity = credentialPolicy === "per_user"
    || (credentialPolicy === "per_user_with_fallback" && Boolean(myGrant));
  const audienceGrant = audienceGrantId
    ? grants.find((grant) => grant.id === audienceGrantId) ?? null
    : null;

  if (loading) {
    return (
      <section className="space-y-5" aria-busy="true">
        <IdentitiesHeading />
        <Skeleton className="h-14 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-5">
        <IdentitiesHeading />
        <InlineBanner tone="warning" compact>
          {l10n("local.we_couldn_t_load_who_this_connection_acts_as_8d0b5a1b")}</InlineBanner>
      </section>
    );
  }

  if (credentialPolicy === "per_agent") {
    const github = agentGrant?.providerTenant?.github;
    return (
      <section className="space-y-5">
        <h2 className="text-sm font-semibold text-foreground">{l10n("local.github_identity_c043831d")}</h2>
        <p className="text-sm text-muted-foreground">{l10n("local.this_agent_uses_this_github_account_for_every_a47d6599")}</p>
        <IdentityRow
          title={github ? `@${github.login}` : l10n("local.dedicated_github_account_55fb115c")}
          status={agentGrant?.status ?? null}
          detail={dedicatedAgent ? (
            <Link
              to={agentUrl(dedicatedAgent)}
              className="transition-colors hover:text-foreground hover:underline"
            >
              {l10n("local.used_only_by_81d77064")}{" "}{dedicatedAgent.name}
            </Link>
          ) : l10n("local.dedicated_to_one_agent_9c261451")}
          actions={!agentGrant && dedicatedAgent && capabilities?.canConfigure ? (
            <Button size="sm" disabled={connectPending} onClick={() => onConnectAgent(dedicatedAgent.id)}>
              {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {l10n("local.connect_dedicated_account_c566d2da")}</Button>
          ) : null}
        />
        {github ? <GitHubConnectionSummary grant={agentGrant} onRefreshAccess={onRefreshAccess} refreshPending={refreshAccessPending} /> : null}
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <IdentitiesHeading />

      <HumanAccessCards
        personal={usesPersonalIdentity}
        restricted={!usesPersonalIdentity && Boolean(orgGrant?.members?.length)}
        connectedName={usesPersonalIdentity ? personalSubjectLabel ?? connectedUser?.label ?? null : null}
        connectedImage={usesPersonalIdentity ? connectedUser?.image ?? null : null}
        status={(usesPersonalIdentity ? personalGrant : orgGrant)?.status ?? null}
        canEditAudience={orgGrant?.capabilities?.canEditAudience ?? false}
        onChooseAll={() => {
          if (orgGrant) onReplaceAudience(orgGrant, []);
        }}
        onChooseSelected={() => {
          if (orgGrant) onOpenAudience(orgGrant.id);
        }}
      />

      {(usesPersonalIdentity ? personalGrant : orgGrant)?.providerTenant?.github ? (
        <GitHubConnectionSummary
          grant={(usesPersonalIdentity ? personalGrant : orgGrant)!}
          onRefreshAccess={onRefreshAccess}
          refreshPending={refreshAccessPending}
        />
      ) : null}

      <div>
        {usesPersonalIdentity ? (
          personalGrant ? null : (
            <IdentityRow
              id="personal-identity"
              title={l10n("local.personal_account_96c55b36")}
              status={null}
              detail={l10n("local.personal_identity_dfb32054")}
              actions={capabilities?.canConnectAsCurrentUser ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectAsMe}>
                    {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {l10n("local.connect_as_me_806b4164")}</Button>
                ) : null}
            />
          )
        ) : (
          orgGrant ? (
            orgGrant.capabilities?.canEditAudience ? (
              <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => onOpenAudience(orgGrant.id)}>
                    {l10n("local.manage_access_a90527b6")}</Button>
              </div>
            ) : null
          ) : (
            <IdentityRow
              title={l10n("local.organization_account_d2056993")}
              status={null}
              detail={l10n("local.organization_identity_4f644c74")}
              actions={capabilities?.canCreateOrganizationGrant ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectOrganization}>
                    {l10n("local.connect_organization_identity_dfa1d1c8")}</Button>
                ) : null}
            />
          )
        )}
      </div>

      {audienceGrant ? (
        <AudienceDialog
          appName={appName}
          grant={audienceGrant}
          members={members}
          pending={audiencePending}
          error={audienceError}
          onCancel={onCloseAudience}
          onSave={(memberUserIds) => onReplaceAudience(audienceGrant, memberUserIds)}
        />
      ) : null}

    </section>
  );
}

function GitHubConnectionSummary({
  grant,
  onRefreshAccess,
  refreshPending,
}: {
  grant: ConnectionGrant;
  onRefreshAccess?: () => void;
  refreshPending: boolean;
}) {
  const github = grant.providerTenant?.github;
  if (!github) return null;
  const configurationUrl = github.appSlug
    ? `https://github.com/apps/${encodeURIComponent(github.appSlug)}/installations/new`
    : /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(github.installationUrl ?? "")
      ? github.installationUrl
      : null;
  const repositoryWarning = github.repositorySelection === "all"
    ? "All current and future repositories"
    : github.repositorySelection === "mixed"
      ? "Mixed access; scope varies by installation"
      : null;
  const repositorySummary = github.repositorySelection === "none"
    ? l10n("local.no_repositories_selected_cfc95621")
    : l10n("local.value_selected_value_c372c5aa", {v0: (github.repositoryCount), v1: (github.repositoryCount === 1 ? "repository" : "repositories")});
  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="py-3">
        <div className="text-sm font-medium text-foreground">{l10n("local.github_account_d686f873")}</div>
        <a className="text-sm text-muted-foreground hover:underline" href={`https://github.com/${encodeURIComponent(github.login)}`} target="_blank" rel="noreferrer">
          @{github.login}
        </a>
      </div>
      <div className="space-y-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{l10n("local.repositories_1e32af87")}</div>
            {repositoryWarning ? (
              <div
                role="note"
                className={cn(
                  "mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  brandBanner.warning,
                )}
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {repositoryWarning}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{repositorySummary}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onRefreshAccess && configurationUrl ? (
              <Button size="icon-sm" variant="outline" aria-label={l10n("local.refresh_access_0df81b58")} title={l10n("local.refresh_access_0df81b58")} disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              </Button>
            ) : null}
            {configurationUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={configurationUrl} target="_blank" rel="noreferrer">{l10n("local.add_more_repos_on_github_c7c688ec")}</a>
              </Button>
            ) : onRefreshAccess ? (
              <Button size="sm" variant="outline" disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {l10n("local.load_github_configuration_075ef318")}</Button>
            ) : null}
          </div>
        </div>
        {github.repositories ? (
          github.repositories.length ? <ul aria-label={l10n("local.accessible_github_repositories_8aec55c7")} tabIndex={0} className="max-h-(--sz-github-repository-list) space-y-2 overflow-y-auto text-sm">
            {github.repositories.map((repository) => (
              <li key={repository.id}>
                <a className="flex items-center gap-2 text-muted-foreground hover:underline" href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">
                  <GithubIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-all">{repository.fullName}</span>
                  {repository.private === true ? <Lock className="h-3 w-3 shrink-0" role="img" aria-label={l10n("local.private_repository_6ab5ea78")} /> : null}
                </a>
              </li>
            ))}
          </ul> : <p role="status" className="text-sm text-muted-foreground">
            {l10n("local.no_accessible_repositories_ecffe2f5")}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{l10n("local.refresh_access_to_load_the_current_repository_6011831a")}</p>
        )}
        {configurationUrl ? <p className="text-xs text-muted-foreground">
          {l10n("local.missing_an_organization_or_repository_e1a19618")}{" "}<a href={configurationUrl} target="_blank" rel="noreferrer" className="text-foreground hover:underline">{l10n("local.configure_access_on_github_e9f56cc3")}</a>{l10n("local._then_refresh_this_list_7d86d67b")}</p> : null}
      </div>
    </div>
  );
}

function IdentitiesHeading() {
  return <h2 className="text-sm font-semibold text-foreground">{l10n("local.which_humans_can_use_this_credential_df3c5fa3")}</h2>;
}

function HumanAccessCards({
  personal,
  restricted,
  connectedName,
  connectedImage,
  status,
  canEditAudience,
  onChooseAll,
  onChooseSelected,
}: {
  personal: boolean;
  restricted: boolean;
  connectedName: string | null;
  connectedImage: string | null;
  status: ConnectionGrant["status"] | null;
  canEditAudience: boolean;
  onChooseAll: () => void;
  onChooseSelected: () => void;
}) {
  return (
    <div className="space-y-3">
      <RadioCardGroup
        ariaLabel={l10n("local.which_humans_can_use_this_credential_e68f7a3e")}
        value={personal ? "personal" : restricted ? "selected" : "company"}
        className="sm:grid-cols-2"
        onValueChange={(next) => {
          if (!canEditAudience || personal) return;
          if (next === "company") onChooseAll();
          if (next === "selected") onChooseSelected();
        }}
        options={personal ? [
          {
            value: "personal",
            title: l10n("local.just_me_3a4b4df8"),
            description: l10n("local.only_you_can_use_this_connection_7fb35f12"),
            icon: <UserRound className="h-4 w-4" />,
          },
        ] : [
          {
            value: "selected",
            title: l10n("local.humans_i_pick_733eda8b"),
            description: l10n("local.only_selected_people_in_your_company_c4dd628b"),
            icon: <UserRound className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
          {
            value: "company",
            title: l10n("local.any_human_in_the_company_4b923619"),
            description: l10n("local.anyone_in_your_company_can_use_this_connectio_06637667"),
            icon: <Building2 className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
        ]}
      />
      {connectedName && status !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Identity name={connectedName} avatarUrl={connectedImage} />
          {status === "active" ? null : <StatusText status={status} />}
        </div>
      ) : null}
    </div>
  );
}

function IdentityRow({
  id,
  title,
  status,
  detail,
  actions,
}: {
  id?: string;
  title: string;
  status: ConnectionGrant["status"] | null;
  detail: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {status === "active" ? null : <StatusText status={status} />}
        </div>
        {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/**
 * "Who can use this identity" (PAP-17835 Surface C). Scope is a two-option
 * radio: all organization members, persisted as no audience members, or a
 * selected set. The dialog stays open on a denial so the selection survives.
 */
export function AudienceDialog({
  appName,
  grant,
  members,
  pending,
  error,
  onCancel,
  onSave,
}: {
  appName: string;
  grant: ConnectionGrant;
  members: ConnectionAudienceMember[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (memberUserIds: string[]) => void;
}) {
  const initialSelection = useMemo(() => audienceUserIds(grant), [grant]);
  const [scope, setScope] = useState<"all" | "selected">(initialSelection.size === 0 ? "all" : "selected");
  const [selected, setSelected] = useState<Set<string>>(initialSelection);

  useEffect(() => {
    setSelected(initialSelection);
    setScope(initialSelection.size === 0 ? "all" : "selected");
  }, [initialSelection]);

  const canSave = scope === "all" || selected.size > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{l10n("local.who_can_use_this_identity_c43b5922")}</DialogTitle>
          <DialogDescription>
            {grantAccountLabel(grant)} · {appName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={l10n("local.who_can_use_this_identity_c43b5922")}
            value={scope}
            onValueChange={(next) => setScope(next as "all" | "selected")}
            options={[
              {
                value: "all",
                title: l10n("local.all_organization_members_eac0894e"),
                description: l10n("local.anyone_in_this_organization_can_have_work_use_eb19683e"),
              },
              {
                value: "selected",
                title: l10n("local.selected_members_78a2792c"),
                description: l10n("local.only_the_people_you_choose_085cf136"),
              },
            ]}
          />

          {scope === "selected" ? (
            <MemberMultiSelect
              members={members.map((member) => ({
                userId: member.userId,
                name: member.name,
                email: member.email,
              }))}
              selectedUserIds={selected}
              onChange={setSelected}
              triggerLabel={selected.size === 0
                ? l10n("local.choose_people_4929aabe")
                : l10n("local.value_value_selected_c05d4e8d", {v0: (selected.size), v1: (selected.size === 1 ? "person" : "people")})}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">
            {l10n("local.this_controls_whose_work_can_use_the_identity_0f4980c2")}</p>

          {error ? (
            <InlineBanner tone="warning" compact>
              {error}
            </InlineBanner>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button
            disabled={pending || !canSave}
            onClick={() => onSave(scope === "all" ? [] : [...selected])}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {l10n("local.save_audience_bece046d")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Revoke confirmation (PAP-17835 Surface D). Revoke breaks active and future
 * runs, so it is an `AlertDialog` and the destructive action is not the initial
 * focus. The row survives afterwards showing Revoked, which keeps the context
 * and the reconnect path.
 */
export function RevokeGrantDialog({
  grant,
  providerName,
  pending,
  isOwnIdentity,
  credentialPolicy,
  description,
  children,
  onCancel,
  onConfirm,
}: {
  grant: ConnectionGrant;
  providerName: string;
  pending: boolean;
  isOwnIdentity: boolean;
  credentialPolicy: ToolConnectionCredentialPolicy;
  description?: string;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const personal = grant.kind === "user";
  const title = personal
    ? isOwnIdentity
      ? l10n("local.revoke_your_value_identity_fce13000", {v0: (providerName)})
      : l10n("local.revoke_this_value_identity_478699ca", {v0: (providerName)})
    : l10n("local.revoke_the_organization_identity_2606ac93");
  const body = personal
    ? isOwnIdentity
      ? "Agents will stop acting as you. Work that needs this identity can ask you to connect again."
      : "Agents will stop acting as this person. They can connect again themselves; no one else can do it for them."
    : credentialPolicy === "per_user"
      ? "Installed agents lose this shared identity immediately."
      : "Eligible members and installed agents will lose this shared identity immediately.";

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description ?? body}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>
            {l10n("local.cancel_19766ed6")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {l10n("local.revoke_identity_c8534276")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
