import { l10n } from "../../../i18n";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, HelpCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { InlineBanner } from "@/components/InlineBanner";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RemoteMcpManagement } from "./RemoteMcpManagement";
import { AccessStepContent, StepHeader } from "../ConnectionSetupFlow";
import type { RemoteMcpProvider } from "./providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

const steps = ["access", "connect"] as const;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><button type="button" aria-label={l10n("local.help_with_value_99385c23", {v0: (label)})} onClick={() => setOpen(!open)} className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><HelpCircle className="size-4" /></button></TooltipTrigger>
    <TooltipContent className="max-w-xs">{children}</TooltipContent>
  </Tooltip>;
}

/** Controlled presentation shared by provider setup, configuration imports and review stories.
 * Authentication, persistence and calls belong to the controller, never these views. */
export function RemoteMcpConnectionSetup({ provider, state: s, actions: a, agents, connectionId, fixedGrantKind, lockedAgentId, host = "page", authorizationUrl }: {
  host?: "page" | "dialog";
  lockedAgentId?: string;
  authorizationUrl?: string;
  provider: RemoteMcpProvider;
  connectionId: string;
  fixedGrantKind?: RemoteMcpSetupState["grantKind"];
  state: RemoteMcpSetupState;
  actions: RemoteMcpSetupActions;
  agents: { id: string; name: string }[];
}) {
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(s.step);
  useEffect(() => {
    if (previousStep.current !== s.step) heading.current?.focus();
    previousStep.current = s.step;
  }, [s.step]);
  const currentStep = steps.indexOf(s.step as typeof steps[number]);
  const busy = s.connectStatus === "connecting";
  const change = (patch: Partial<RemoteMcpSetupState>) => a.edit(patch);
  const external = (purpose: Parameters<typeof a.openProvider>[0], text: string) => <Button type="button" variant="link" className="h-auto p-0 text-sm text-current underline" onClick={() => a.openProvider(purpose)}>{text}<ExternalLink className="size-3.5" aria-hidden="true" /></Button>;
  const boundary = <InlineBanner compact>
    {l10n("local.paperclip_controls_access_to_the_tools_listed_ba12d624")}{" "}{external("manage", provider.name)}.
  </InlineBanner>;
  const footer = (children: ReactNode) => <SetupWizardFooter onSaveExit={a.saveExit} disabled={busy}>{children}</SetupWizardFooter>;

  const error = s.connectStatus === "invalid_url" ? { title: l10n("local.enter_a_valid_mcp_url_90cbbcb5"), body: "Paste the complete server URL, including https:// or http://. A dashboard page is not an MCP endpoint." }
    : s.connectStatus === "oauth_failed" ? { title: l10n("local.value_couldn_t_connect_37b5bbb7", {v0: (provider.name)}), body: "Authorization did not complete. Your saved connection is still here, so you can try again." }
    : s.connectStatus === "rejected" ? { title: l10n("local.credentials_were_rejected_73a49563"), body: `Check or replace the credentials from ${provider.name}, then reconnect. Your agent access and tool choices are preserved.` }
    : s.connectStatus === "unreachable" ? { title: l10n("local.paperclip_could_not_reach_this_server_dd97cf34"), body: "Check that the endpoint is running and reachable from Paperclip, then try again. Your draft is still here." }
    : null;

  return <div className={host === "dialog" ? "min-w-0 text-foreground" : "mx-auto max-w-6xl p-4 text-foreground sm:p-8"} data-remote-mcp-provider={provider.id}>
    <StepHeader headingRef={heading} appIdentity={{ name: provider.name, logoUrl: null }}
      title={s.step === "draft" ? l10n("local.continue_your_setup_e4e54fce") : s.setupComplete ? s.step === "access" ? l10n("local.who_can_use_this_connection_ba7dda12") : s.step === "connect" ? l10n("local.reconnect_value_e66847e3", {v0: (provider.name)}) : provider.name : undefined}
      subtitle={currentStep >= 0 && !s.setupComplete ? l10n("local.step_value_of_2_87209571", {v0: (currentStep + 1)}) : s.step === "draft" ? l10n("local.your_value_setup_is_ready_to_resume_02663f8f", {v0: (provider.name)}) : s.step === "permissions" ? l10n("local.connectedvalue_value_actions_available_632f13bb", {v0: (s.identity ? ` as ${s.identity}` : ""), v1: (s.tools.length)}) : l10n("local.manage_this_value_connection_69a9d561", {v0: (provider.name)})}
      step={currentStep >= 0 && !s.setupComplete ? "access" : "gallery"} activeIndex={currentStep} labels={["Access", "Connect"]} onCancel={busy || s.step === "management" || s.step === "permissions" || s.step === "draft" ? undefined : a.saveExit} />
    <main className="space-y-6">
        {s.notice && <p role="status" className="text-sm text-muted-foreground">{s.notice}</p>}

        {s.step === "access" && <AccessStepContent agents={agents} lockedAgentId={lockedAgentId} authKind="oauth" grantKinds={fixedGrantKind ? [fixedGrantKind] : undefined} grantKind={s.grantKind} setGrantKind={(grantKind) => { if (grantKind !== "agent") change({ grantKind }); }}
          installChoice={s.allAgents ? "all" : "specific"} setInstallChoice={(choice) => change({ allAgents: choice === "all" })}
          installAgentIds={new Set(s.agentIds)} setInstallAgentIds={(ids) => change({ agentIds: [...ids] })}
          submitLabel={s.setupComplete ? l10n("local.done_11a6767d") : l10n("local.continue_31fbef16")} onBack={s.setupComplete ? a.finish : a.saveExit} onContinue={s.setupComplete ? a.finish : () => a.navigate("connect")} />}
        {s.step === "permissions" && <>
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{l10n("local.permissions_abccc78c")}</h2><Button variant="outline" onClick={a.finish}>{l10n("local.connection_settings_b4ddb3c1")}</Button></div>
          {s.tools.some((entry) => entry.broad) && boundary}
          <ActionsSection connectionId={connectionId} appName={provider.name}
            readOnly={s.tools.filter((entry) => entry.isReadOnly)} canChange={s.tools.filter((entry) => !entry.isReadOnly)} quarantined={[]}
            enabledIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] !== "off").map((entry) => entry.id))}
            askFirstIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] === "ask_first").map((entry) => entry.id))}
            disabled={!s.connected} refreshPending={s.refreshing} canConfigure
            onSetPermission={(id, next) => change({ permissions: { ...s.permissions, [id]: next === "ask" ? "ask_first" : next } })}
            onReviewQuarantined={() => {}} onRefreshActions={a.refresh} />
        </>}
        <div className="mx-auto max-w-2xl space-y-6">
        {s.step === "connect" && <>
          <div className="space-y-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">{provider.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
            {external("setup", `Open ${provider.name} setup guide`)}
          </div>
          {s.connectStatus === "sign_in" && provider.supportsBrowserAuth ? <>
            <div role="status"><InlineBanner title={l10n("local.finish_signing_in_to_value_81e0cd67", {v0: (provider.name)})}>
              {l10n("local.complete_sign_in_in_the_provider_window_then_5b1f7130")}</InlineBanner></div>
            <p className="text-sm text-muted-foreground">{l10n("local.if_a_window_did_not_open_2b43fd00")}{" "}{authorizationUrl ? <a className="text-current underline" href={authorizationUrl} onClick={() => a.openProvider("sign_in")} target="_blank" rel="noopener noreferrer">{l10n("local.open_sign_in_again_24857fcb")}</a> : external("sign_in", "open sign-in again")}.</p>
            {footer(<><Button variant="outline" onClick={a.cancelConnect}>{l10n("local.cancel_sign_in_9effa0b7")}</Button><Button disabled>{l10n("local.waiting_for_sign_in_749a343a")}</Button></>)}
          </> : <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); a.connect(); }}>
            {error && <div role="alert"><InlineBanner tone="danger" title={error.title}>{error.body}</InlineBanner></div>}
            {s.connectStatus === "cancelled" && <p role="status" className="text-sm text-muted-foreground">{l10n("local.connection_cancelled_your_setup_details_are_p_7d123dbb")}</p>}
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Label htmlFor={`${uid}-url`}>{l10n("local.mcp_server_url_4f5aff03")}</Label><FieldHelp label={l10n("local.mcp_server_url_4f5aff03")}>{provider.urlHelp}</FieldHelp></div>
                <Input id={`${uid}-url`} type="password" autoComplete="off" spellCheck={false} placeholder={provider.placeholder} value={s.url} aria-invalid={s.connectStatus === "invalid_url"} aria-describedby={`${uid}-url-help`} onChange={(event) => change({ url: event.target.value })} />
                <p id={`${uid}-url-help`} className="text-xs text-muted-foreground">{provider.urlHelp}</p>
              </div>
              <details open={s.advanced} onToggle={(event) => { if (event.currentTarget.open !== s.advanced) change({ advanced: event.currentTarget.open }); }}>
                <summary className="cursor-pointer text-sm font-medium">{l10n("local.advanced_authentication_6083f79d")}</summary>
                <div className="space-y-4 pt-4">
                  <p className="text-sm text-muted-foreground">{provider.authHelp}</p>
                  <div className="space-y-2"><Label htmlFor={`${uid}-auth`}>{l10n("local.authentication_66880d2d")}</Label><select id={`${uid}-auth`} className={selectClass} value={s.auth} onChange={(event) => change({ auth: event.target.value as RemoteMcpSetupState["auth"] })}>
                    {provider.supportsBrowserAuth && <option value="auto">{l10n("local.automatic_sign_in_if_required_2332ea4f")}</option>}<option value="bearer">{l10n("local.bearer_token_b22ac30e")}</option><option value="headers">{l10n("local.custom_headers_34cb675c")}</option><option value="none">{l10n("local.no_additional_authentication_403f3df9")}</option>
                  </select></div>
                  {s.auth === "bearer" && <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-token`}>{l10n("local.bearer_token_b22ac30e")}</Label><FieldHelp label={l10n("local.bearer_token_0063f0d1")}>{l10n("local.paste_the_token_only_without_the_word_bearer_face6d5c")}</FieldHelp></div><Input id={`${uid}-token`} type="password" autoComplete="off" value={s.token} onChange={(event) => change({ token: event.target.value })} /></div>}
                  {(s.auth === "bearer" || s.auth === "headers") && <div className="space-y-3">
                    <p className="text-sm font-medium">{s.auth === "bearer" ? l10n("local.additional_headers_1ff7bcb8") : l10n("local.headers_194e9fe6")}</p>
                    {s.headers.map((header, index) => <div key={header.id} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-name`}>{l10n("local.header_ba5caa42")}{" "}{index + 1} {l10n("local.name_82a3537f")}</Label><Input id={`${uid}-${header.id}-name`} value={header.name} placeholder={provider.id === "arcade" ? l10n("local.arcade_user_id_020dff87") : l10n("local.header_name_c1dcc8fb")} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, name: event.target.value } : h) })} /></div>
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-value`}>{l10n("local.header_ba5caa42")}{" "}{index + 1} {l10n("local.value_cd42404d")}</Label><Input id={`${uid}-${header.id}-value`} type="password" autoComplete="off" value={header.value} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, value: event.target.value } : h) })} /></div>
                      <Button type="button" variant="ghost" size="icon" aria-label={l10n("local.remove_header_value_8573cc18", {v0: (index + 1)})} onClick={() => change({ headers: s.headers.filter((h) => h.id !== header.id) })}><Trash2 className="size-4" /></Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" onClick={() => change({ headers: [...s.headers, { id: crypto.randomUUID(), name: "", value: "" }] })}><Plus className="size-4" />{l10n("local.add_header_1192c90d")}</Button>
                  </div>}
                </div>
              </details>
            </fieldset>
            {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{l10n("local.connecting_and_discovering_tools_99f0c67e")}</p>}
            {footer(<><Button type="button" variant="outline" disabled={busy} onClick={() => s.setupComplete ? a.finish() : a.navigate("access")}>{l10n("local.back_76900f1b")}</Button><Button type="submit" disabled={busy || !s.url.trim()}>{busy ? l10n("local.connecting_72021eb7") : error || s.connectStatus === "cancelled" ? l10n("local.try_again_d8b8392e") : l10n("local.connect_1a2303ed")}</Button></>)}
          </form>}
        </>}

        {s.step === "management" && <>
          {!s.connected ? <InlineBanner tone="warning" title={l10n("local.disconnected_04dfac36")}>{l10n("local.agents_cannot_use_this_connection_reconnect_t_ef1eb298")}</InlineBanner> : <div className="space-y-2"><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />{l10n("local.connected_22965568")}{s.identity ? (" " + l10n("local.as_value_87cd310c", {v0: (s.identity)})) : ""}</p><p className="text-sm text-muted-foreground">{s.grantKind === "user" ? l10n("local.just_me_3a4b4df8") : l10n("local.any_human_in_the_organization_e6b1c669")} · {s.tools.length} {l10n("local.tools_e9c00279")}{" "}{s.allAgents ? l10n("local.any_agent_ee3e7690") : l10n("local.value_agents_with_access_7e03ef6e", {v0: (s.agentIds.length)})}</p></div>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => a.navigate("access")}>{l10n("local.who_can_use_this_connection_ba7dda12")}</Button><Button variant="outline" disabled={!s.connected} onClick={() => a.navigate("permissions")}>{l10n("local.permissions_abccc78c")}</Button></div>
          <p className="text-sm text-muted-foreground">{l10n("local.refresh_the_catalog_after_changing_tools_in_0d14dc82")}{" "}{provider.name}{l10n("local._existing_off_and_ask_first_choices_are_prese_517b062e")}</p>
          <Button variant="outline" disabled={!s.connected || s.refreshing} onClick={a.refresh}>{s.refreshing ? l10n("local.refreshing_1c0def7b") : l10n("local.refresh_tools_31393d31")}</Button>
          <RemoteMcpManagement providerName={provider.name} connected={s.connected} onReconnect={a.reconnect} onManage={() => a.openProvider("manage")} onDisconnect={a.disconnect} />
        </>}
        {s.step === "draft" && <><p className="text-sm">{l10n("local.your_access_choices_and_setup_progress_are_ke_67357c15")}</p><div className="flex justify-end"><Button onClick={a.resumeDraft}>{l10n("local.resume_setup_014c5f81")}</Button></div></>}
        </div>
    </main>
  </div>;
}
