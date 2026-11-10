import type { Issue } from "./types/issue.js";

export type ResponsibleUserSource = "explicit" | "creator" | "none";

export interface ResponsibleUserAttribution {
  userId: string | null;
  source: ResponsibleUserSource;
  isAutoDerived: boolean;
}

export function deriveResponsibleUser(
  issue: Pick<Issue, "responsibleUserId" | "createdByUserId">,
): ResponsibleUserAttribution {
  if (issue.responsibleUserId) {
    return { userId: issue.responsibleUserId, source: "explicit", isAutoDerived: false };
  }

  if (issue.createdByUserId) {
    return { userId: issue.createdByUserId, source: "creator", isAutoDerived: true };
  }

  return { userId: null, source: "none", isAutoDerived: false };
}

/**
 * The actor to display as an issue's "Originating" attribution.
 *
 * The actor that actually created the issue always wins. A responsible user is
 * ownership/accountability metadata, not authorship: showing that user as the
 * originator makes an agent-created task look as if an administrator created
 * it. Routine executions with no creator still fall back to the responsible
 * user.
 */
export type OriginatingActor =
  | { kind: "user"; id: string; viaAgentId?: string }
  | { kind: "agent"; id: string };

export function deriveOriginatingActor(
  issue: Pick<Issue, "createdByUserId" | "createdByAgentId" | "responsibleUserId">,
): OriginatingActor | null {
  if (issue.createdByAgentId) {
    return { kind: "agent", id: issue.createdByAgentId };
  }

  if (issue.createdByUserId) {
    return { kind: "user", id: issue.createdByUserId };
  }

  if (issue.responsibleUserId) {
    return { kind: "user", id: issue.responsibleUserId };
  }

  return null;
}
