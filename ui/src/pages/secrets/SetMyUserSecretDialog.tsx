import { l10n } from "../../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { secretsApi } from "../../api/secrets";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { useToastActions } from "../../context/ToastContext";
import { UserSecretChip } from "./user-secret-presentation";

/**
 * Shared "set my value" dialog for a user-secret definition. Used both from the
 * Secrets → My secrets tab and from the missing-required-secret warning surfaces
 * (task run / issue failure), so a user can satisfy a required secret from either
 * place with identical behavior.
 */
export function SetMyUserSecretDialog({
  companyId,
  definition,
  existingSecret,
  open,
  onOpenChange,
  onSaved,
}: {
  companyId: string;
  definition: UserSecretDefinition | null;
  existingSecret?: CompanySecret | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (secret: CompanySecret) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [value, setValue] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isExternal = definition?.managedMode === "external_reference";

  useEffect(() => {
    if (open) {
      setValue("");
      setExternalRef("");
      setError(null);
    }
  }, [open, definition?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error("No definition selected");
      const payload = isExternal
        ? { externalRef: externalRef.trim() }
        : { value: value.trim() };
      if (existingSecret) {
        // A stored value already exists → rotate it in place.
        return secretsApi.rotateMyUserSecret(companyId, existingSecret.id, payload);
      }
      return secretsApi.createMyUserSecret(companyId, {
        definitionId: definition.id,
        definitionKey: definition.key,
        ...payload,
      });
    },
    onSuccess: (secret) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({
        title: existingSecret ? l10n("local.value_updated_2590dbf5") : l10n("local.value_saved_ee25dd4c"),
        body: definition?.name,
        tone: "success",
      });
      onSaved?.(secret);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to save value",
      );
    },
  });

  const canSave = isExternal ? externalRef.trim().length > 0 : value.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {existingSecret ? l10n("local.update_your_value_5aa98f20") : l10n("local.set_your_value_830bced8")}
            <UserSecretChip />
          </DialogTitle>
          <DialogDescription>
            {definition ? (
              <>
                {l10n("local.this_value_is_yours_only_it_is_used_when_you_8db1e14c")}{" "}<span className="font-mono">{definition.key}</span>.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {definition ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
              <div className="font-medium text-foreground">{definition.name}</div>
              {definition.description ? (
                <p className="mt-1 text-muted-foreground">{definition.description}</p>
              ) : null}
              {definition.usageGuidance ? (
                <p className="mt-1 text-muted-foreground">{definition.usageGuidance}</p>
              ) : null}
            </div>

            {isExternal ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{l10n("local.external_reference_5c54252e")}</label>
                <Input
                  value={externalRef}
                  onChange={(event) => setExternalRef(event.target.value)}
                  placeholder={l10n("local.provider_reference_or_arn_3aaaf811")}
                  className="font-mono text-sm"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {l10n("local.points_at_your_own_credential_in_the_configur_293a244f")}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{l10n("local.your_value_92b09f9a")}</label>
                <Textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={l10n("local.paste_your_token_or_credential_2e889692")}
                  className="font-mono text-sm min-h-(--sz-80px)"
                  autoFocus
                />
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {l10n("local.stored_encrypted_never_shown_back_to_anyone_i_b803c895")}</p>
              </div>
            )}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? l10n("local.saving_23e39291") : existingSecret ? l10n("local.update_value_d508b1f3") : l10n("local.save_value_2e2689eb")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
