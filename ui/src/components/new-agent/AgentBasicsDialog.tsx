import { l10n } from "../../i18n";
import { useCompany } from "@/context/CompanyContext";
import { useAgentAppearanceDraft } from "@/hooks/useAgentAppearanceDraft";
import { AgentCharacter } from "../AgentCharacter";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ChevronRight } from "lucide-react";
import { adaptersApi } from "@/api/adapters";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { isNewAgentAdapterAllowed } from "@/lib/new-agent-adapters";
import { queryKeys } from "@/lib/queryKeys";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";

export type AgentBasics = {
  name: string;
  adapterType: string;
  runnerProvider: string;
};
const brandMarks: Record<string, { src: string; dark?: string }> = {
  claude_local: { src: "/brands/claude-color.svg" },
  codex_local: { src: "/brands/codex-color.svg" },
  gemini_local: { src: "/brands/adapters/gemini-color.svg" },
  kimi_local: {
    src: "/brands/adapters/kimi-color-light.svg",
    dark: "/brands/adapters/kimi-color.svg",
  },
  ...Object.fromEntries(
    [
      ["cursor", "cursor"],
      ["cursor_cloud", "cursor"],
      ["grok_local", "grok"],
      ["hermes_local", "hermesagent"],
      ["hermes_gateway", "hermesagent"],
      ["pi_local", "pi"],
    ].map(([type, icon]) => [
      type,
      {
        src: `/brands/adapters/${icon}.svg`,
        dark: `/brands/adapters/${icon}-dark.svg`,
      },
    ]),
  ),
};
export function AdapterMark({
  type,
  className = "size-6",
}: {
  type: string;
  className?: string;
}) {
  const Icon = getAdapterDisplay(type).icon;
  const mark = brandMarks[type];
  if (!mark) return <Icon className={className} />;
  return (
    <>
      <img
        src={mark.src}
        className={cn(
          "shrink-0 object-contain",
          mark.dark && "dark:hidden",
          className,
        )}
        alt=""
      />
      {mark.dark && (
        <img
          src={mark.dark}
          className={cn("hidden shrink-0 object-contain dark:block", className)}
          alt=""
        />
      )}
    </>
  );
}
function AgentBasicsCharacter() {
  const { selectedCompanyId } = useCompany();
  const { appearance } = useAgentAppearanceDraft(`${selectedCompanyId}:new-agent`);
  return <AgentCharacter appearance={appearance} state="sleepy" muted size={256} className="size-48" trackingScope="page" />;
}

export function AgentBasicsDialog({
  open,
  onClose,
  onContinue,
  initialAdapter = "",
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: (basics: AgentBasics) => void;
  initialAdapter?: string;
  onInvite?: () => void;
}) {
  const id = useId();
  const cloud = Boolean(useCloudInstance());
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: instanceSettingsApi.getExperimental,
    enabled: open,
    retry: false,
  });
  const [name, setName] = useState("");
  const [adapterType, setAdapterType] = useState(initialAdapter);
  const [runnerProvider, setRunnerProvider] = useState("codex");
  const [step, setStep] = useState<"name" | "adapter">("name");
  const {
    data: adapters,
    isPending,
    error,
  } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: adaptersApi.list,
    enabled: open,
  });
  const choices = (adapters ?? []).filter(
    (adapter) =>
      adapter.loaded &&
      !adapter.disabled &&
      isNewAgentAdapterAllowed(adapter.type, {
        cloud,
        nativeRunnerEnabled: experimental.data?.enableNativeRunner === true,
      }) &&
      !["process", "http"].includes(adapter.type) &&
      !getAdapterDisplay(adapter.type).comingSoon,
  );
  const validAdapter = choices.some((adapter) => adapter.type === adapterType);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-640px)",
          step === "name" && "sm:max-w-(--sz-560px)",
        )}
      >
        <div
          className="flex items-center gap-2 px-6 py-5 text-xs text-muted-foreground"
          aria-label={l10n("local.new_agent_progress_260193aa")}
        >
          <span
            className={cn(step === "name" && "font-medium text-foreground")}
          >
            {l10n("local.1_name_6dce9cbb")}</span>
          <ChevronRight className="size-3" />
          <span
            className={cn(step === "adapter" && "font-medium text-foreground")}
          >
            {l10n("local.2_adapter_f692efe7")}</span>
        </div>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            if (step === "name") setStep("adapter");
            else if (validAdapter)
              onContinue({ name: name.trim(), adapterType, runnerProvider });
          }}
        >
          <div className="flex min-h-0 flex-col gap-7 overflow-y-auto px-6 pb-8 sm:px-10">
            <div className="flex flex-col items-center gap-4 text-center">
              {open && <AgentBasicsCharacter />}
              <div className="space-y-2">
                <DialogTitle className="text-3xl font-semibold tracking-tight">
                  {step === "name"
                    ? l10n("local.meet_your_next_agent_945b9577")
                    : l10n("local.choose_an_adapter_ea43ab7d")}
                </DialogTitle>
                <DialogDescription className="text-base">
                  {step === "name"
                    ? l10n("local.start_with_a_name_make_them_your_own_8d8fc9f2")
                    : l10n("local.how_should_value_work_e6568aee", {v0: (name.trim())})}
                </DialogDescription>
              </div>
            </div>
            {step === "name" ? (
              <div className="space-y-2">
                <label htmlFor={id} className="text-sm font-medium">
                  {l10n("local.agent_name_1cfb2187")}</label>
                <Input
                  id={id}
                  autoFocus
                  maxLength={100}
                  placeholder={l10n("local.e_g_darnold_4c64e4fe")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 text-base"
                />
                {onInvite && (
                  <Button
                    type="button"
                    variant="link"
                    className="px-0 text-muted-foreground"
                    onClick={onInvite}
                  >
                    {l10n("local.invite_an_external_agent_0c21d454")}</Button>
                )}
              </div>
            ) : (
              <fieldset className="space-y-4">
                <legend className="sr-only">{l10n("local.adapter_0252b849")}</legend>
                {isPending && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {l10n("local.loading_adapters_89e30959")}</p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error.message}
                  </p>
                )}
                <div className={cn("grid grid-cols-2 gap-3", choices.length !== 4 && "sm:grid-cols-3")}>
                  {choices.map((adapter) => {
                    const display = getAdapterDisplay(adapter.type);
                    return (
                      <label
                        key={adapter.type}
                        className="relative cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="new-agent-adapter"
                          value={adapter.type}
                          checked={adapterType === adapter.type}
                          onChange={() => setAdapterType(adapter.type)}
                          className="peer sr-only"
                        />
                        <span
                          className={cn(
                            "flex h-full flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center peer-focus-visible:ring-2 peer-focus-visible:ring-ring hover:bg-accent/40",
                            adapterType === adapter.type
                              ? "border-foreground/40 bg-accent"
                              : "border-border bg-card",
                          )}
                        >
                          <AdapterMark type={adapter.type} />
                          <span className="text-sm font-medium">
                            {display.label}
                          </span>
                          {adapterType === adapter.type && (
                            <Check className="absolute right-2 top-2 size-3.5" />
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {validAdapter && adapterType === "paperclip_runner" && (
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    {l10n("local.runner_2184a4e3")}<select
                      className="rounded-md border border-border bg-background px-3 py-2"
                      value={runnerProvider}
                      onChange={(event) =>
                        setRunnerProvider(event.target.value)
                      }
                    >
                      <option value="codex">{l10n("local.codex_app_server_d64fe2f5")}</option>
                      <option value="claude">{l10n("local.claude_acpx_60a5ff32")}</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </label>
                )}
              </fieldset>
            )}
          </div>
          <div className="flex justify-between gap-4 border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => (step === "name" ? onClose() : setStep("name"))}
            >
              {step === "name" ? (
                l10n("local.cancel_19766ed6")
              ) : (
                <>
                  <ArrowLeft className="size-4" />
                  {l10n("local.back_76900f1b")}</>
              )}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || (step === "adapter" && !validAdapter)}
            >
              {step === "name" ? l10n("local.choose_adapter_83a3d0a9") : l10n("local.configure_agent_14c603bd")}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
