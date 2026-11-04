import { describe, expect, it } from "vitest";
import { formatJoinInviteContext } from "./join-invite-labels";

describe("formatJoinInviteContext", () => {
  it("formats human invitations with a localized default role", () => {
    expect(formatJoinInviteContext({ allowedJoinTypes: "human", humanRole: "viewer" }))
      .toBe("Human join invite • default role Viewer");
  });

  it("formats agent and mixed invitations without exposing enum values", () => {
    expect(formatJoinInviteContext({ allowedJoinTypes: "agent", humanRole: null }))
      .toBe("Agent join invite");
    expect(formatJoinInviteContext({ allowedJoinTypes: "both", humanRole: null }))
      .toBe("Human or agent join invite");
  });
});
