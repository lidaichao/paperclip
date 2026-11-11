import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { agentChatDraft } from "./agent-chat-draft";

describe("agentChatDraft", () => {
  it("classifies the ephemeral conversation issue as system work", () => {
    const issue = agentChatDraft({
      id: "agent-1",
      companyId: "company-1",
      name: "Luna",
    } as Agent);

    expect(issue.workItemKind).toBe("system");
    expect(issue.id).toBe("chat:agent-1");
  });
});
