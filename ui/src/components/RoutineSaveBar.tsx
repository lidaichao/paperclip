import { l10n } from "../i18n";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RoutineHistoryDirtyFieldDescriptor } from "./RoutineHistoryTab";

/**
 * Per-section sticky save bar (§1.4–§1.5). Hidden when clean; reveals on dirty.
 * On a 409 it swaps to the conflict-recovery surface ("Reload latest" /
 * "Overwrite anyway"). Wires ⌘/Ctrl+S → save and Esc → discard-with-confirm.
 */
export function RoutineSaveBar({
  dirtyFields,
  isSaving,
  saveConflict,
  onSave,
  onDiscard,
  onReload,
  disabled,
}: {
  dirtyFields: RoutineHistoryDirtyFieldDescriptor[];
  isSaving: boolean;
  saveConflict: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  disabled?: boolean;
}) {
  const dirtyCount = dirtyFields.length;
  const isDirty = dirtyCount > 0;
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  useEffect(() => {
    if (!isDirty && !saveConflict) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!isSaving && !disabled) onSave();
      } else if (event.key === "Escape" && isDirty) {
        event.preventDefault();
        setConfirmDiscardOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, saveConflict, isSaving, disabled, onSave]);

  if (!isDirty && !saveConflict) return null;

  return (
    <>
      <div
        className={cn(
          "sticky bottom-0 z-10 -mx-8 mt-6 flex h-14 items-center justify-between border-t px-8 backdrop-blur",
          "motion-safe:transition-colors motion-safe:duration-200",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
          saveConflict
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-border bg-background/95",
        )}
      >
        {saveConflict ? (
          <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            <span>{l10n("local.routine_changed_elsewhere_reload_to_merge_3148fbdb")}</span>
          </div>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-foreground hover:text-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span className="font-medium">
                  {dirtyCount} {l10n("local.unsaved_9c80e833")}{" "}{dirtyCount === 1 ? l10n("local.change_12ea12ea") : l10n("local.changes_d0b4ba23")}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {l10n("local.pending_changes_54ae644f")}</p>
              <ul className="space-y-1 text-sm">
                {dirtyFields.map((field) => (
                  <li key={field.key} className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-amber-500" />
                    <span className="capitalize">{field.label}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}

        <div className="flex items-center gap-2">
          {saveConflict ? (
            <>
              <Button variant="outline" size="sm" onClick={onReload}>
                {l10n("local.reload_latest_cb5bbbf3")}</Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={isSaving || disabled}
                      onClick={onSave}
                    >
                      {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      {l10n("local.overwrite_anyway_9511749c")}</Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {l10n("local.replaces_the_newer_revision_with_your_local_e_fec05c5b")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={isSaving || disabled}
                onClick={() => setConfirmDiscardOpen(true)}
              >
                {l10n("local.discard_eb1a70e3")}</Button>
              <Button
                size="sm"
                disabled={isSaving || disabled}
                onClick={onSave}
              >
                {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {l10n("local.save_changes_dd0ae7a5")}<kbd className="ml-2 hidden rounded bg-foreground/10 px-1 text-(length:--text-nano) font-medium sm:inline">
                  ⌘S
                </kbd>
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.discard_changes_85bcf416")}</DialogTitle>
            <DialogDescription>
              {l10n("local.this_will_revert_25fd077b")}{" "}{dirtyCount} {l10n("local.unsaved_9c80e833")}{" "}
              {dirtyCount === 1 ? l10n("local.change_12ea12ea") : l10n("local.changes_d0b4ba23")} {l10n("local.in_this_section_a9e6d4f6")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscardOpen(false)}>
              {l10n("local.keep_editing_e76fd2ad")}</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDiscard();
                setConfirmDiscardOpen(false);
              }}
            >
              {l10n("local.discard_changes_f9bfa3dc")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Read-only strip for non-owners on editable sections (§1.6). */
export function RoutineReadOnlyStrip() {
  return (
    <div className="-mx-8 mt-6 border-t border-border bg-muted/20 px-8 py-3 text-xs text-muted-foreground">
      {l10n("local.read_only_you_don_t_own_this_routine_ed056afb")}</div>
  );
}
