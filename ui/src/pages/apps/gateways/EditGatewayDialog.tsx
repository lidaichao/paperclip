import { l10n } from "../../../i18n";
import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
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
import { allowedToolsLabel } from "./gateway-helpers";
import { gatewaysQueryKey } from "./NewGatewayDialog";

export function EditGatewayDialog({
  companyId,
  gateway,
  profiles,
  open,
  onOpenChange,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
  profiles: ToolProfileWithDetails[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState(gateway.name);
  const [description, setDescription] = useState(gateway.description ?? "");
  const [profileId, setProfileId] = useState(gateway.profileId);

  useEffect(() => {
    if (!open) return;
    setName(gateway.name);
    setDescription(gateway.description ?? "");
    setProfileId(gateway.profileId);
  }, [gateway, open]);

  const activeProfiles = profiles.filter((profile) => profile.status !== "archived");
  const updateMutation = useMutation({
    mutationFn: () =>
      toolsApi.updateGateway(companyId, gateway.id, {
        name: name.trim(),
        description: description.trim() || null,
        profileId,
      }),
    onSuccess: async (updated) => {
      pushToast({ title: l10n("local.gateway_updated_b8482057"), body: updated.name, tone: "success" });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(companyId) });
      onOpenChange(false);
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.gateway_was_not_updated_34c6cf19"),
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !profileId) return;
    updateMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{l10n("local.edit_gateway_30f16c79")}</DialogTitle>
          <DialogDescription>
            {l10n("local.change_the_label_or_the_access_profile_that_c_15de47de")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.name_dcd1d522")}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.access_profile_0ffe9da7")}</span>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              required
            >
              {activeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} — {allowedToolsLabel(profile)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{l10n("local.description_optional_f6cbe2f0")}</span>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={l10n("local.who_this_endpoint_is_for_5e66484a")}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button type="submit" disabled={updateMutation.isPending || !name.trim() || !profileId}>
              {updateMutation.isPending ? l10n("local.saving_23e39291") : l10n("local.save_changes_dd0ae7a5")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
