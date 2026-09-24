import { l10n } from "../../i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretStatus, UserSecretDefinition } from "@paperclipai/shared";
import { AlertCircle, Pencil, Plus, Trash2, UserRound, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../../components/EmptyState";
import { secretsApi } from "../../api/secrets";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import {
  coverageSummaryLabel,
  secretStatusTone,
  UserSecretChip,
} from "./user-secret-presentation";

function keyFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

interface DefinitionForm {
  name: string;
  key: string;
  description: string;
  usageGuidance: string;
  status: SecretStatus;
}

const emptyForm: DefinitionForm = {
  name: "",
  key: "",
  description: "",
  usageGuidance: "",
  status: "active",
};

/**
 * Secrets → User secret definitions tab (admin). Defines the shared credentials
 * that each member fills in with their own value. Coverage is shown as counts
 * only — never values — per the UX terminology decisions.
 */
export function UserSecretDefinitionsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserSecretDefinition | null>(null);
  const [form, setForm] = useState<DefinitionForm>(emptyForm);
  const [keyDirty, setKeyDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSecretDefinition | null>(null);

  const definitionsQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitions(companyId),
    queryFn: () => secretsApi.listUserSecretDefinitions(companyId),
  });
  const definitions = definitionsQuery.data ?? [];

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setKeyDirty(false);
    setError(null);
    setDialogOpen(true);
  }

  function openEdit(definition: UserSecretDefinition) {
    setEditing(definition);
    setForm({
      name: definition.name,
      key: definition.key,
      description: definition.description ?? "",
      usageGuidance: definition.usageGuidance ?? "",
      status: definition.status,
    });
    setKeyDirty(true);
    setError(null);
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const sharedPayload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        usageGuidance: form.usageGuidance.trim() || null,
      };
      if (editing) {
        return secretsApi.updateUserSecretDefinition(companyId, editing.id, {
          ...sharedPayload,
          status: form.status,
        });
      }
      return secretsApi.createUserSecretDefinition(companyId, {
        ...sharedPayload,
        key: form.key.trim(),
        status: form.status === "deleted" ? "active" : form.status,
      });
    },
    onSuccess: (definition) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({
        title: editing ? l10n("local.definition_updated_cec55bc9") : l10n("local.definition_created_41e2dce3"),
        body: definition.name,
        tone: "success",
      });
      setDialogOpen(false);
    },
    onError: (err) =>
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Failed to save"),
  });

  const remove = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(companyId, definition.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({ title: l10n("local.definition_removed_b179e55e"), tone: "info" });
      setDeleteTarget(null);
    },
    onError: (err) =>
      pushToast({
        title: l10n("local.could_not_remove_definition_e6de8f56"),
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      }),
  });

  const canSave = form.name.trim().length > 0 && form.key.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-start gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-violet-800 dark:text-violet-200">
        <UserRound className="h-4 w-4 mt-0.5 shrink-0" />
        <p>
          {l10n("local.define_credentials_that_289a740d")}{" "}<span className="font-medium">{l10n("local.each_member_supplies_for_themselves_752fb011")}</span>{l10n("local._you_set_the_shape_here_every_user_enters_the_d3e24cb7")}</p>
      </div>

      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-3.5 w-3.5" /> {l10n("local.new_user_secret_a67839ad")}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {definitionsQuery.isError ? (
          <div className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {l10n("local.failed_to_load_definitions_dd92bad0")}{" "}
            {(definitionsQuery.error as Error).message}
            <Button variant="ghost" size="sm" onClick={() => definitionsQuery.refetch()}>
              {l10n("local.retry_942087cc")}</Button>
          </div>
        ) : definitions.length === 0 && !definitionsQuery.isPending ? (
          <EmptyState
            icon={UserRound}
            message="No user secret definitions yet. Create one to require each member to supply their own credential."
            action="New user secret"
            onAction={openCreate}
          />
        ) : (
          <ul className="space-y-2">
            {definitions.map((definition) => (
              <li
                key={definition.id}
                className="flex items-start gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{definition.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                      {definition.key}
                    </code>
                    <UserSecretChip />
                    <Badge
                      variant="outline"
                      className={cn("text-(length:--text-micro)", secretStatusTone(definition.status))}
                    >
                      {definition.status}
                    </Badge>
                  </div>
                  {definition.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
                  ) : null}
                  <CoverageBadge companyId={companyId} definitionId={definition.id} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(definition)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(definition)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editing ? l10n("local.edit_user_secret_299bb088") : l10n("local.new_user_secret_a67839ad")}
              <UserSecretChip />
            </DialogTitle>
            <DialogDescription>
              {l10n("local.members_supply_their_own_value_for_this_crede_a42859e1")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{l10n("local.name_dcd1d522")}</label>
              <Input
                value={form.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setForm((current) => ({
                    ...current,
                    name,
                    key: keyDirty ? current.key : keyFromName(name),
                  }));
                }}
                placeholder={l10n("local.personal_github_token_92e189a9")}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{l10n("local.key_99a52df3")}</label>
              <Input
                value={form.key}
                onChange={(event) => {
                  setKeyDirty(true);
                  setForm((current) => ({ ...current, key: event.target.value }));
                }}
                placeholder="PERSONAL_GH_TOKEN"
                className="font-mono text-sm"
                disabled={Boolean(editing)}
              />
              <p className="text-(length:--text-micro) text-muted-foreground">
                {l10n("local.stable_identifier_referenced_by_env_bindings_cb82b785")}{" "}{editing ? l10n("local.cannot_be_changed_6eef4993") : ""}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{l10n("local.description_526e0087")}</label>
              <Input
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={l10n("local.what_this_credential_is_for_ecdde2fb")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">
                {l10n("local.usage_guidance_0c1d12df")}{" "}<span className="text-muted-foreground">{l10n("local._optional_0059798b")}</span>
              </label>
              <Textarea
                value={form.usageGuidance}
                onChange={(event) =>
                  setForm((current) => ({ ...current, usageGuidance: event.target.value }))
                }
                placeholder={l10n("local.tell_members_how_to_create_their_token_requir_2eecaea0")}
                className="min-h-(--sz-70px) text-sm"
              />
            </div>
            {editing ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{l10n("local.status_920e413c")}</label>
                <Select
                  value={form.status}
                  onValueChange={(status) =>
                    setForm((current) => ({ ...current, status: status as SecretStatus }))
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{l10n("local.active_92340695")}</SelectItem>
                    <SelectItem value="disabled">{l10n("local.disabled_75081b59")}</SelectItem>
                    <SelectItem value="archived">{l10n("local.archived_bdb86505")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={save.isPending}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
              {save.isPending ? l10n("local.saving_23e39291") : editing ? l10n("local.save_changes_dd0ae7a5") : l10n("local.create_4759498a")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.remove_user_secret_c34b555e")}</DialogTitle>
            <DialogDescription>
              {l10n("local.this_removes_the_definition_7efd01cc")}{" "}<span className="font-mono">{deleteTarget?.key}</span> {l10n("local.for_the_whole_company_existing_member_values_9a4ac234")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={remove.isPending}>
              {l10n("local.cancel_19766ed6")}</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
              disabled={remove.isPending}
            >
              {remove.isPending ? l10n("local.removing_d4b09919") : l10n("local.remove_c3812fc4")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CoverageBadge({
  companyId,
  definitionId,
}: {
  companyId: string;
  definitionId: string;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  const summary = coverageQuery.data;
  const missing = summary ? summary.missingCount : 0;
  return (
    <p className="mt-1 inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
      <Users className="h-3 w-3" />
      {l10n("local.coverage_c79fb748")}{" "}{coverageSummaryLabel(summary)}
      {summary && missing > 0 ? (
        <span className="text-amber-600 dark:text-amber-400">· {missing} {l10n("local.not_set_1aef9399")}</span>
      ) : null}
    </p>
  );
}
