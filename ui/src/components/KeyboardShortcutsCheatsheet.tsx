import { l10n } from "../i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    title: l10n("local.inbox_94835ea2"),
    shortcuts: [
      { keys: ["j"], label: l10n("local.move_down_40bb50da") },
      { keys: ["↓"], label: l10n("local.move_down_40bb50da") },
      { keys: ["k"], label: l10n("local.move_up_c66feb5e") },
      { keys: ["↑"], label: l10n("local.move_up_c66feb5e") },
      { keys: ["←"], label: l10n("local.collapse_selected_group_933a60af") },
      { keys: ["→"], label: l10n("local.expand_selected_group_6ecae6bf") },
      { keys: ["Enter"], label: l10n("local.open_selected_item_948dbc15") },
      { keys: ["a"], label: l10n("local.archive_item_0fd57cea") },
      { keys: ["y"], label: l10n("local.archive_item_0fd57cea") },
      { keys: ["r"], label: l10n("local.mark_as_read_50c8b81f") },
      { keys: ["U"], label: l10n("local.mark_as_unread_2c19d584") },
    ],
  },
  {
    title: l10n("local.task_detail_be4654d6"),
    shortcuts: [
      { keys: ["y"], label: l10n("local.quick_archive_back_to_inbox_630428a4") },
      { keys: ["g", "i"], label: l10n("local.go_to_inbox_cde5beda") },
      { keys: ["g", "c"], label: l10n("local.focus_comment_composer_a0f6da74") },
    ],
  },
  {
    title: l10n("local.decisions_cfa6a08a"),
    shortcuts: [
      { keys: ["j"], label: l10n("local.move_down_40bb50da") },
      { keys: ["↓"], label: l10n("local.move_down_40bb50da") },
      { keys: ["k"], label: l10n("local.move_up_c66feb5e") },
      { keys: ["↑"], label: l10n("local.move_up_c66feb5e") },
      { keys: ["Enter"], label: l10n("local.open_or_close_selected_decision_54d2aeda") },
      { keys: ["x"], label: l10n("local.dismiss_selected_decision_371158fa") },
    ],
  },
  {
    title: l10n("local.global_a258b30f"),
    shortcuts: [
      { keys: ["/"], label: l10n("local.search_current_page_or_quick_search_4dac6ee7") },
      { keys: ["c"], label: l10n("local.new_task_3e992276") },
      { keys: ["["], label: l10n("local.toggle_sidebar_041aefc4") },
      { keys: ["]"], label: l10n("local.toggle_panel_ed988528") },
      { keys: ["?"], label: l10n("local.show_keyboard_shortcuts_3d0ced5d") },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {shortcut.combo ? "+" : l10n("local.then_21af6f12")}
                          </span>
                        )}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {l10n("local.press_9ed1273e")}{" "}<KeyCap>Esc</KeyCap> {l10n("local.to_close_middot_shortcuts_are_disabled_in_tex_06aefdd4")}</p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{l10n("local.keyboard_shortcuts_e9bef0b0")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
