import type { CaseDetail, CaseStatus } from "@/api/cases";
import { l10n } from "../i18n";

type CaseClipboardData = Pick<
  CaseDetail,
  "identifier" | "title" | "key" | "caseType" | "status" | "labels"
>;

const statusLabels: Record<CaseStatus, () => string> = {
  draft: () => l10n("local.draft_ebf12ef4"),
  in_progress: () => l10n("local.in_progress_c1f88e9d"),
  in_review: () => l10n("local.in_review_c3905914"),
  approved: () => l10n("local.approved_87b42e40"),
  done: () => l10n("local.done_11a6767d"),
  cancelled: () => l10n("local.cancelled_d353a99e"),
};

export function formatCaseClipboardMarkdown(currentCase: CaseClipboardData): string {
  const noValue = l10n("local.none_dc937b59");
  const labels = currentCase.labels.length > 0
    ? currentCase.labels.map((label) => label.name).join(", ")
    : noValue;

  return [
    `# ${currentCase.identifier} ${currentCase.title}`,
    "",
    l10n("local.case_clipboard_key_10300684", { v0: currentCase.key ?? noValue }),
    l10n("local.case_clipboard_type_10300685", { v0: currentCase.caseType }),
    l10n("local.case_clipboard_status_10300686", { v0: statusLabels[currentCase.status]() }),
    l10n("local.case_clipboard_labels_10300687", { v0: labels }),
  ].join("\n");
}
