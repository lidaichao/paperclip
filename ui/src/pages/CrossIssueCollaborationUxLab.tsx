import { l10n } from "../i18n";
import type { ReactNode } from "react";
import { ISSUE_WRITE_DENIAL_CODES } from "@paperclipai/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { CommentAttributionChip } from "@/components/CommentAttributionChip";
import { IssueFieldChangeReceipt } from "@/components/IssueFieldChangeReceipt";
import { IssueWriteDenialNotice } from "@/components/IssueWriteDenialNotice";
import { Identity } from "@/components/Identity";
import { cn } from "@/lib/utils";

/**
 * UX lab for the three surfaces that make open
 * cross-issue collaboration legible — the "for {user}" attribution chip, the
 * field-edit audit receipt in the activity stream, and actionable denial copy.
 *
 * Route: /ux-lab/cross-issue-collaboration. Public (no session) so the states
 * can be captured for UX review without seeding a live thread.
 */

function LabSection({
  index,
  title,
  description,
  children,
  columns = 2,
}: {
  index: string;
  title: string;
  description: string;
  children: ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-background/85 p-5 shadow-sm">
      <div className="mb-4">
        <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
          {index}
        </div>
        <h2 className="mt-1 text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className={cn("grid gap-4", columns === 2 && "lg:grid-cols-2")}>{children}</div>
    </section>
  );
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </div>
      <Card className="block border-border/60 p-3">{children}</Card>
    </div>
  );
}

/** A faithful copy of an agent comment bubble header + body (IssueChatThread.tsx). */
function AgentCommentBubble({
  authorName,
  onBehalfOf,
  body,
}: {
  authorName: string;
  onBehalfOf?: string | null;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start py-1.5">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Avatar size="sm" className="size-5">
            <AvatarFallback className="text-(length:--text-nano)">
              {authorName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </span>
        <span className="text-sm font-medium text-foreground">{authorName}</span>
        {onBehalfOf ? (
          <CommentAttributionChip agentName={authorName} userName={onBehalfOf} />
        ) : null}
      </div>
      <div className="min-w-0 max-w-(--pct-85) break-words border border-border bg-card px-3 py-2 text-sm text-foreground [border-radius:14px_14px_14px_4px]">
        {body}
      </div>
    </div>
  );
}

/** A faithful copy of an activity row in the issue run ledger (IssueDetail.tsx). */
function ActivityRow({
  actorName,
  verb,
  children,
}: {
  actorName: string;
  verb: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Identity name={actorName} size="sm" />
        <span>{verb}</span>
        <span className="ml-auto shrink-0">{l10n("local.2m_ago_35abf1da")}</span>
      </div>
      {children}
    </div>
  );
}

const AGENT_NAMES = new Map([
  ["3108ef8e-5ed0-41d9-b561-6b41c41b8545", "ClaudeCoder"],
  ["6670e11b-91d3-4429-82e0-436b88b51808", "UXDesigner"],
]);

export function CrossIssueCollaborationUxLab() {
  const resolveAgentLabel = (id: string) => AGENT_NAMES.get(id) ?? null;
  const resolveUserLabel = (id: string) => (id === "user-dotta" ? "Dotta" : null);

  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {l10n("local.open_cross_task_collaboration_fc1b8d88")}</div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">
            {l10n("local.open_cross_task_collaboration_attribution_aud_69801ba0")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.agents_may_now_write_to_any_task_they_can_rea_6439ad9c")}</p>
        </header>

        <LabSection
          index="1 · Attribution chip (plan §3a)"
          title={l10n("local._fable_for_dotta_on_a_cross_task_agent_commen_89066eeb")}
          description={l10n("local.an_agent_commenting_on_a_task_it_is_not_assig_65a88410")}
        >
          <Frame label={l10n("local.assignee_s_own_comment_no_chip_30ed05fa")}>
            <AgentCommentBubble
              authorName="CodexCoder"
              body={l10n("local.rebased_onto_master_and_re_ran_the_containmen_7e4326d1")}
            />
          </Frame>
          <Frame label={l10n("local.cross_task_comment_chipped_bdf59089")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf="Dotta"
              body={l10n("local.dotta_asked_me_to_flag_that_the_retry_window_ca5bdd2b")}
            />
          </Frame>
          <Frame label={l10n("local.responsible_user_not_in_the_loaded_directory_6babdf34")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf="the responsible user"
              body={l10n("local.falls_back_to_a_generic_label_rather_than_pri_c74ad23c")}
            />
          </Frame>
          <Frame label={l10n("local.long_user_name_truncates_in_the_chip_a3aace7a")}>
            <AgentCommentBubble
              authorName="Fable"
              onBehalfOf="Alexandra Konstantinopoulos-Whitfield"
              body={l10n("local.the_chip_caps_its_width_and_truncates_the_too_83b2dc4c")}
            />
          </Frame>
        </LabSection>

        <LabSection
          index="2 · Field-edit audit receipt (plan §3b)"
          title={l10n("local.every_patch_says_who_changed_what_and_under_w_b1368a71")}
          description={l10n("local.required_for_agent_and_board_edits_alike_befo_14061d15")}
        >
          <Frame label={l10n("local.cross_task_agent_edit_e4405f7c")}>
            <ActivityRow actorName="Fable" verb="changed the status from todo to in progress">
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_visible_issue_write",
                    changes: {
                      status: { from: "todo", to: "in_progress" },
                      priority: { from: "medium", to: "high" },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={l10n("local.board_human_edit_audited_the_same_way_42e957f9")}>
            <ActivityRow actorName="Dotta" verb="updated the issue">
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_board_actor",
                    changes: {
                      assigneeAgentId: {
                        from: "3108ef8e-5ed0-41d9-b561-6b41c41b8545",
                        to: "6670e11b-91d3-4429-82e0-436b88b51808",
                      },
                      description: { from: "Old brief…", to: "New brief…", updated: true },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={l10n("local.reassignment_blockers_and_work_mode_in_one_wr_f94600c0")}>
            <ActivityRow actorName="CTO" verb="updated the issue">
              <IssueFieldChangeReceipt
                event={{
                  action: "issue.updated",
                  responsibleUserId: "user-dotta",
                  details: {
                    authorizationReason: "allow_visible_issue_write",
                    changes: {
                      blockedByIssueIds: { from: [], to: ["TASK-491", "TASK-492"] },
                      workMode: { from: "planning", to: "standard" },
                      assigneeAgentId: {
                        from: null,
                        to: "3108ef8e-5ed0-41d9-b561-6b41c41b8545",
                      },
                    },
                  },
                }}
                resolveAgentLabel={resolveAgentLabel}
                resolveUserLabel={resolveUserLabel}
              />
            </ActivityRow>
          </Frame>
          <Frame label={l10n("local.older_activity_row_no_receipt_renders_unchang_a4b11034")}>
            <ActivityRow actorName="CodexCoder" verb="checked out the issue" />
          </Frame>
        </LabSection>

        <LabSection
          index="3 · Actionable denial copy (plan §6)"
          title={l10n("local.every_wall_names_the_boundary_who_can_act_and_733ce275")}
          description={l10n("local.a_real_incident_burned_a_full_detour_discover_ed947644")}
          columns={1}
        >
          <Frame label={l10n("local.before_what_the_incident_actually_saw_3f92ba62")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {l10n("local.403_forbidden_issue_is_outside_this_actor_apo_5adeb9e6")}</span>
              <p className="mt-1 text-muted-foreground">
                {l10n("local.no_boundary_named_nobody_named_no_path_forwar_26c285bf")}</p>
            </div>
          </Frame>
          {ISSUE_WRITE_DENIAL_CODES.map((code) => (
            <Frame key={code} label={l10n("local.after_value_471317e4", {v0: (code)})}>
              <IssueWriteDenialNotice
                code={code}
                context={{
                  actorLabel: "Fable",
                  assigneeLabel: "CodexCoder",
                  responsibleUserName: "Dotta",
                  issueIdentifier: "TASK-482",
                  cap: 20,
                  count: 21,
                }}
              />
            </Frame>
          ))}
        </LabSection>
      </div>
    </div>
  );
}

export default CrossIssueCollaborationUxLab;
