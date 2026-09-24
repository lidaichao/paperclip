import { l10n } from "../../i18n";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function aiProviderForAdapter(
  adapterType: string,
): AiProvider | undefined {
  return (
    {
      claude_local: "anthropic",
      codex_local: "openai",
      opencode_local: "openrouter",
      grok_local: "xai",
    } as Record<string, AiProvider>
  )[adapterType];
}
export function AiConnectionField({
  companyId,
  agentId,
  agentName,
  adapterType,
  model,
  value,
  onChange,
  environmentId,
  legacy = false,
  readOnly = false,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
}) {
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  const changeBinding = (next: AiConnectionBinding) => {
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); }
    else onChange(next);
  };
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(provider),
  });
  const method: AiAuthMethod = (value?.mode !== "responsible_user" ? value?.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider === "openrouter" ? "api_key" : "subscription");
  if (!provider) return null;
  if (legacy && !value && !adopting)
    return (
      <AiConnectionLegacyNotice
        readOnly={readOnly}
        onAdopt={() => setAdopting(true)}
      />
    );
  return (
    <div className="space-y-4">
      {value && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          {l10n("local.this_connection_does_not_support_the_current_f964a914")}</p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending}
        error={accounts.error?.message}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onConnect={() => { returnFocus.current = document.activeElement as HTMLElement; setConnecting(true); }}
        onRetry={() => void accounts.refetch()}
      />
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{l10n("local.adopt_connections_for_85bf58d9")}{" "}{agentName}</DialogTitle>
            <DialogDescription>
              {l10n("local.saving_tests_this_account_in_4bac81f8")}{" "}{agentName}{l10n("local._s_environment_before_replacing_its_existing_c440dccd")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? l10n("local.responsible_user_s_default_for_you_value_othe_a3decdf9", {v0: (accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? "Not connected")})
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {l10n("local.after_adoption_missing_credentials_block_exec_f32239bb")}</p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              {l10n("local.use_this_binding_when_saved_3a51030e")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{l10n("local.connect_account_f7d84518")}</DialogTitle>
          </DialogHeader>
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={method}
            name={`My ${provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : "OpenRouter"} ${method === "subscription" ? "subscription" : "API"}`}
            ownership="personal"
            agentIds={agentId ? [agentId] : []}
            allAgents={false}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={() => {
              void client.invalidateQueries({
                queryKey: ["ai-connections", companyId],
              });
              setConnecting(false);
              changeBinding({ provider, method, mode: "responsible_user" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
