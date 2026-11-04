import type {
  SystemNoticeMetadataSection,
  SystemNoticeProps,
} from "../components/SystemNotice";
import { l10n } from "../i18n";

export type SystemNoticeFixture = {
  id: string;
  caption: string;
} & SystemNoticeProps;

const HANDOFF_METADATA: SystemNoticeMetadataSection[] = [
  {
    title: l10n("local.recovery_owner_27c6c04c"),
    rows: [
      {
        kind: "issue",
        label: l10n("local.recovery_issue_52e39343"),
        identifier: "PAP-3440",
        href: "/PAP/issues/PAP-3440",
        title: l10n("local.successful_run_handoff_missing_disposition_4531b97c"),
      },
      {
        kind: "agent",
        label: l10n("local.owner_4b1b8aa3"),
        name: "CTO",
        href: "/PAP/agents/cto",
      },
      {
        kind: "text",
        label: l10n("local.suggested_action_10300777"),
        value: l10n("local.reassign_recovery_agent_pick_disposition_10300778"),
      },
    ],
  },
  {
    title: l10n("local.run_evidence_96767cbe"),
    rows: [
      {
        kind: "run",
        label: l10n("local.source_run_bb84312e"),
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
      {
        kind: "run",
        label: l10n("local.recovery_run_10300779"),
        runId: "61fdb79b-8012-4676-ac71-2971830e126a",
        href: "/PAP/agents/codexcoder/runs/61fdb79b-8012-4676-ac71-2971830e126a",
        status: "failed",
      },
      {
        kind: "text",
        label: l10n("local.normalized_cause_10300780"),
        value: l10n("local.run_completed_without_disposition_10300781"),
      },
    ],
  },
];

const REQUIRED_METADATA: SystemNoticeMetadataSection[] = [
  {
    title: l10n("local.required_action_10300782"),
    rows: [
      {
        kind: "issue",
        label: l10n("local.source_issue_10300783"),
        identifier: "PAP-3440",
        href: "/PAP/issues/PAP-3440",
        title: l10n("local.successful_run_handoff_missing_disposition_4531b97c"),
      },
      {
        kind: "agent",
        label: l10n("local.responsible_bc110a6d"),
        name: "CodexCoder",
        href: "/PAP/agents/codexcoder",
      },
      {
        kind: "text",
        label: l10n("local.next_step_298a9207"),
        value: l10n("local.pick_disposition_and_post_rationale_10300784"),
      },
    ],
  },
  {
    title: l10n("local.run_context_10300785"),
    rows: [
      {
        kind: "run",
        label: l10n("local.successful_run_10300786"),
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
      {
        kind: "code",
        label: l10n("local.status_before_10300787"),
        value: "in_progress",
      },
    ],
  },
];

const NEUTRAL_METADATA: SystemNoticeMetadataSection[] = [
  {
    rows: [
      {
        kind: "agent",
        label: l10n("local.reassigned_to_10300788"),
        name: "ClaudeFixer",
        href: "/PAP/agents/claudefixer",
      },
      {
        kind: "agent",
        label: l10n("local.from_75857a45"),
        name: "CodexCoder",
        href: "/PAP/agents/codexcoder",
      },
      {
        kind: "text",
        label: l10n("local.reason_f81ab834"),
        value: l10n("local.manual_reassignment_requested_by_board_10300789"),
      },
    ],
  },
];

export const systemNoticeFixtures: readonly SystemNoticeFixture[] = [
  {
    id: "warning-collapsed",
    caption: l10n("local.warning_collapsed_default_10300790"),
    tone: "warning",
    label: l10n("local.system_warning_10300543"),
    source: { label: "Alice", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:32:00.000Z",
    body: l10n("local.alice_needs_disposition_10300792"),
    metadata: REQUIRED_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "warning-expanded",
    caption: l10n("local.warning_expanded_10300791"),
    tone: "warning",
    label: l10n("local.system_warning_10300543"),
    source: { label: "Alice", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:32:00.000Z",
    body: l10n("local.alice_needs_disposition_10300792"),
    metadata: REQUIRED_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "danger-collapsed",
    caption: l10n("local.danger_collapsed_default_10300793"),
    tone: "danger",
    label: l10n("local.system_alert_2b1c663e"),
    source: { label: "Alice", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:48:00.000Z",
    body: l10n("local.paperclip_could_not_resolve_this_issue_s_miss_c1bc4a74"),
    metadata: HANDOFF_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "danger-expanded",
    caption: l10n("local.danger_expanded_10300794"),
    tone: "danger",
    label: l10n("local.system_alert_2b1c663e"),
    source: { label: "Alice", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:48:00.000Z",
    body: l10n("local.paperclip_could_not_resolve_this_issue_s_miss_c1bc4a74"),
    metadata: HANDOFF_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "neutral-collapsed",
    caption: l10n("local.neutral_collapsed_default_10300795"),
    tone: "neutral",
    label: l10n("local.system_notice_10300542"),
    source: { label: "Alice" },
    timestamp: "2026-05-04T15:10:00.000Z",
    body: l10n("local.reassigned_to_claudefixer_10300797"),
    metadata: NEUTRAL_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "neutral-expanded",
    caption: l10n("local.neutral_expanded_10300796"),
    tone: "neutral",
    label: l10n("local.system_notice_10300542"),
    source: { label: "Alice" },
    timestamp: "2026-05-04T15:10:00.000Z",
    body: l10n("local.reassigned_to_claudefixer_10300797"),
    metadata: NEUTRAL_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "warning-no-details",
    caption: l10n("local.warning_no_metadata_10300798"),
    tone: "warning",
    label: l10n("local.system_warning_10300543"),
    source: { label: "Alice" },
    timestamp: "2026-05-04T17:02:00.000Z",
    body: l10n("local.run_paused_waiting_board_approval_10300799"),
  },
];
