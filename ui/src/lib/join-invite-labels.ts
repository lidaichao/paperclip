import type { HumanCompanyRole } from "@/api/access";
import { l10n } from "../i18n";

type JoinInviteContext = {
  allowedJoinTypes: "human" | "agent" | "both";
  humanRole: HumanCompanyRole | null;
};

const roleLabels: Record<HumanCompanyRole, () => string> = {
  owner: () => l10n("local.owner_4b1b8aa3"),
  admin: () => l10n("local.admin_c1c224b0"),
  operator: () => l10n("local.operator_291101a0"),
  viewer: () => l10n("local.viewer_678bfa6a"),
};

export function formatJoinInviteContext(invite: JoinInviteContext): string {
  const audience = invite.allowedJoinTypes === "agent"
    ? l10n("local.agent_11b39c93")
    : invite.allowedJoinTypes === "both"
      ? l10n("local.human_or_agent_a9d069a5")
      : l10n("local.human_9ffa865f");
  return invite.humanRole
    ? l10n("local.join_invite_default_role_10300683", {
        v0: audience,
        v1: roleLabels[invite.humanRole](),
      })
    : l10n("local.join_invite_context_10300682", { v0: audience });
}
