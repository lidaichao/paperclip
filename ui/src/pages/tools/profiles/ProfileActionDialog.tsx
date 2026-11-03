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
      body: l10n(
        profile.summary.appliesToAgentCount === 1
          ? "local.profile_stops_applying_one_agent_10300285"
          : "local.profile_stops_applying_restore_later_10300274",
        { v0: profile.summary.appliesToAgentCount },
      ),
      confirm: l10n("local.archive_66f4804e"),
      action: onArchive,
    },
    restore: {
      title: l10n("local.restore_profile_ec01a812"),
      body: l10n("local.profile_active_again_assignable_10300275"),
      confirm: l10n("local.restore_a76e13b9"),
      action: onRestore,
    },
    delete: {
      title: l10n("local.delete_profile_47311af4"),
      body: defaultDeleteBlocked
        ? l10n("local.default_profile_reassign_before_delete_10300276")
        : l10n(
          profile.summary.assignmentCount === 1
            ? "local.delete_profile_removes_one_assignment_10300286"
            : "local.delete_profile_removes_assignments_10300277",
          { v0: profile.summary.assignmentCount },
        ),
      confirm: l10n("local.delete_e2d0a549"),
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
