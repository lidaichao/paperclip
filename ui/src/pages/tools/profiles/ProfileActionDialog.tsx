import { l10n } from "../../../i18n";
import { AlertTriangle } from "lucide-react";
import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ProfileActionDialogKind = "archive" | "delete" | "restore";

export function ProfileActionDialog({
  kind,
  profile,
  pending,
  onClose,
  onArchive,
  onRestore,
  onDelete,
}: {
  kind: ProfileActionDialogKind | null;
  profile: ToolProfileWithDetails | null;
  pending: boolean;
  onClose: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  if (!kind || !profile) return null;

  const defaultDeleteBlocked = kind === "delete" && profile.summary.isCompanyDefault;
  const copy = {
    archive: {
      title: l10n("local.archive_profile_2962d868"),
      body: `This profile stops applying to ${profile.summary.appliesToAgentCount} ${profile.summary.appliesToAgentCount === 1 ? "agent" : "agents"}. You can restore it later.`,
      confirm: "Archive",
      action: onArchive,
    },
    restore: {
      title: l10n("local.restore_profile_ec01a812"),
      body: "This profile will be active again and can be assigned to agents.",
      confirm: "Restore",
      action: onRestore,
    },
    delete: {
      title: l10n("local.delete_profile_47311af4"),
      body: defaultDeleteBlocked
        ? "This profile is the organization default. Reassign the organization default to another profile before deleting it."
        : `This permanently deletes the profile and removes ${profile.summary.assignmentCount} ${profile.summary.assignmentCount === 1 ? "assignment" : "assignments"}.`,
      confirm: "Delete",
      action: onDelete,
    },
  }[kind];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {defaultDeleteBlocked ? (
          <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{l10n("local.choose_another_access_profile_and_make_it_the_29f96b1e")}</span>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{l10n("local.cancel_19766ed6")}</Button>
          <Button
            variant={kind === "delete" ? "destructive" : "default"}
            disabled={pending || defaultDeleteBlocked}
            onClick={copy.action}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
