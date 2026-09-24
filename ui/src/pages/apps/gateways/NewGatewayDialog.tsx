import { l10n } from "../../../i18n";
import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolMcpGatewayContextScopeType, ToolProfileWithDetails } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { allowedToolsLabel } from "./gateway-helpers";

export const gatewaysQueryKey = (companyId: string) => ["tools", "gateways", companyId] as const;

/**
 * "New gateway" dialog. A gateway is one safe MCP endpoint that exposes only
 * the tools in its access profile. Matches the prosumer create flow from the
 * PAP-11178 design of record.
 */
export function NewGatewayDialog({
  companyId,
  open,
  onOpenChange,
  onCreated,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (gatewayId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [profileId, setProfileId] = useState("");

  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(companyId),
    queryFn: () => toolsApi.listProfiles(companyId),
    enabled: open,
  });
  const activeProfiles = (profilesQuery.data?.profiles ?? []).filter(
    (profile: ToolProfileWithDetails) => profile.status !== "archived",
  );

  useEffect(() => {
    if (open && !profileId && activeProfiles[0]) setProfileId(activeProfiles[0].id);
  }, [open, profileId, activeProfiles]);

  const createMutation = useMutation({
    mutationFn: () =>
      toolsApi.createGateway(companyId, {
        name: name.trim(),
        description: description.trim() || null,
        profileId,
        defaultProfileMode: "gateway_only",
        contextScopeType: "company" satisfies ToolMcpGatewayContextScopeType,
      }),
    onSuccess: async (gateway) => {
      pushToast({ title: l10n("local.gateway_created_bf088b7f"), body: gateway.name, tone: "success" });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(companyId) });
      setName("");
      setDescription("");
      onOpenChange(false);
      onCreated?.(gateway.id);
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.gateway_was_not_created_449e74ea"),
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !profileId) return;
    createMutation.mutate();
  }

  const profilesLoading = profilesQuery.isLoading;
  const noProfiles = !profilesLoading && activeProfiles.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{l10n("local.new_gateway_9dff4bab")}</DialogTitle>
          <DialogDescription>
            {l10n("local.one_safe_mcp_endpoint_that_exposes_only_the_a_ae7344ca")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.name_dcd1d522")}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={l10n("local.cto_agents_24458198")}
              required
              autoFocus
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.access_profile_0ffe9da7")}</span>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              required
              disabled={noProfiles}
            >
              <option value="" disabled>
                {profilesLoading ? l10n("local.loading_profiles_16b0bbfd") : l10n("local.choose_a_profile_416c3478")}
              </option>
              {activeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} — {allowedToolsLabel(profile)}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {l10n("local.the_profile_decides_which_tools_this_gateway_846e0081")}</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.description_optional_f6cbe2f0")}</span>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={l10n("local.who_this_endpoint_is_for_and_when_it_should_b_1f1384e3")}
            />
          </label>
          {noProfiles ? (
            <p className="text-xs text-destructive">
              {l10n("local.create_an_access_profile_under_advanced_befor_fc014528")}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || noProfiles || !name.trim() || !profileId}
            >
              {createMutation.isPending ? l10n("local.creating_c79ed949") : l10n("local.create_gateway_f1d4a6bb")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
