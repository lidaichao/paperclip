import { describe, expect, it } from "vitest";

import { resolveNativeAttentionStatus } from "./native-interaction-bridge.js";

describe("原生关注状态提示", () => {
  it.each([
    {
      facts: {
        companyScopeValid: false,
        responseState: "none" as const,
        route: "context" as const,
        summary: "跨公司目标",
      },
      nextAction: "移除跨公司的关注目标。",
    },
    {
      facts: {
        companyScopeValid: true,
        responseState: "none" as const,
        route: "recovery" as const,
        summary: "需要恢复",
      },
      nextAction: "指定一名明确的恢复负责人。",
    },
    {
      facts: {
        companyScopeValid: true,
        responseState: "none" as const,
        route: "agent" as const,
        summary: "需要委派",
      },
      nextAction: "指派一名同公司且符合条件的代理人。",
    },
  ])("返回中文恢复动作：$nextAction", ({ facts, nextAction }) => {
    const decision = resolveNativeAttentionStatus({
      facts,
      priorIssueStatus: "in_progress",
      agentId: "agent-1",
    });

    expect(decision.effects).toContainEqual(
      expect.objectContaining({
        kind: "record_finalization_error",
        nextAction,
      }),
    );
  });
});
