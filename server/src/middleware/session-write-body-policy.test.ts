import { describe, expect, it } from "vitest";
import { sessionWriteBodyPolicy } from "./session-write-body-policy.js";

describe("sessionWriteBodyPolicy", () => {
  it("accepts a record-only task create", () => {
    expect(sessionWriteBodyPolicy("POST", "/api/companies/11111111-1111-1111-1111-111111111111/issues", {
      title: "Rabbit-owned task",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      status: "todo",
    }).safe).toBe(true);
  });

  it("rejects execution controls and reports the safe create fields", () => {
    const policy = sessionWriteBodyPolicy(
      "POST",
      "/api/companies/11111111-1111-1111-1111-111111111111/issues",
      { title: "Unsafe task", assigneeAdapterOverrides: { useProjectWorkspace: false } },
    );

    expect(policy.safe).toBe(false);
    expect(policy.allowedFields).toContain("assigneeAgentId");
    expect(policy.allowedFields).not.toContain("assigneeAdapterOverrides");
  });

  it("rejects execution statuses from a short session write", () => {
    expect(sessionWriteBodyPolicy(
      "PATCH",
      "/api/issues/11111111-1111-1111-1111-111111111111",
      { status: "in_progress" },
    ).safe).toBe(false);
  });
});
