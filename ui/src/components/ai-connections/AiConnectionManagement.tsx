import { l10n } from "../../i18n";
import { Button } from "@/components/ui/button";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">
        {l10n("local.existing_authentication_not_managed_by_connec_c836e59b")}</h3>
      <p className="text-sm text-muted-foreground">
        {l10n("local.this_agent_keeps_its_current_authentication_u_c88eb326")}</p>
      {!readOnly && (
        <Button variant="outline" className="self-start" onClick={onAdopt}>
          {l10n("local.choose_a_managed_connection_7efd0256")}</Button>
      )}
    </div>
  );
}
