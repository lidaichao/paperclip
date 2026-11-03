import { describe, expect, it } from "vitest";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { safeMilestoneText } from "./chat-run-publications.js";
import { isExplicitExternalAgentComment } from "./issues.js";

describe("chat run milestone projection", () => {
  it("allows only safe lifecycle state and text through the shared projection", () => {
    expect(
      projectSafeChatPublication({
        classification: "external",
        source: "safe_milestone",
        text: "Maya 正在处理…",
        progressState: "working",
      }),
    ).toEqual({ text: "Maya 正在处理…", progressState: "working" });
    expect(
      JSON.stringify(
        projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text: "Maya 在完成本轮任务前停止。",
          progressState: "failed",
        }),
      ),
    ).not.toContain("stderr");
  });

  it("gives unlinked external identities a safe recovery path when isolation is unavailable", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "low_trust_isolation_unavailable",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl: "https://paperclip.example/path",
      }),
    ).toBe(
      "Maya 无法安全开始本轮任务：该任务由未关联的外部访客发起，但隔离访客执行不可用。请让 Alice 管理员为此账户创建私有身份关联，或启用隔离访客执行，然后新建任务。 在 Alice 中打开任务：https://paperclip.example/issues/issue-1",
    );
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "low_trust_isolation_unavailable",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl: null,
      }),
    ).toBe(
      "Maya 无法安全开始本轮任务：该任务由未关联的外部访客发起，但隔离访客执行不可用。请让 Alice 管理员为此账户创建私有身份关联，或启用隔离访客执行，然后新建任务。 请在 Alice 中打开任务查看详情。",
    );
  });

  it("gives permanent integrity failures a safe operator recovery path", () => {
    const text = safeMilestoneText({
      agentName: "Maya",
      errorCode: "native_event_replay_conflict",
      milestone: "failed",
      issueId: "issue-1",
    });
    expect(text).toBe(
      "Maya 无法安全继续本轮任务。请由 Alice 管理员检查此次运行后再重试。 请在 Alice 中打开任务查看详情。",
    );
    expect(text).not.toMatch(/digest|source.seq|semantic|replay.conflict/i);
  });

  it("keeps every other run failure generic outside Paperclip", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "provider_secret_in_error_code",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya 在完成本轮任务前停止。 请在 Alice 中打开任务查看详情。",
    );
  });

  it.each([
    [null, " 请在 Alice 中打开任务查看详情。"],
    [
      "https://paperclip.example",
      " 在 Alice 中打开任务：https://paperclip.example/issues/issue-1",
    ],
  ])(
    "explains retained-session recovery without encouraging duplicate requests (%s)",
    (publicBaseUrl, suffix) => {
      const text = safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_session_cleanup_quarantined",
        milestone: "failed",
        issueId: "issue-1",
        publicBaseUrl,
      });
      expect(text).toBe(
        "Maya 无法开始本轮任务，因为较早的会话需要恢复。你的请求已保存。请由 Alice 管理员恢复该会话后再重试；重复发送请求无法解决问题。" +
          suffix,
      );
      expect(text).not.toMatch(
        /quarantin|checkpoint|process|native_session|runnerId|reset/i,
      );
      expect(
        projectSafeChatPublication({
          classification: "external",
          source: "safe_milestone",
          text,
          progressState: "failed",
        }),
      ).toEqual({ text, progressState: "failed" });
    },
  );

  it("describes ownership recovery without claiming the retained process stopped", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_execution_ownership_unverified",
        milestone: "waiting_for_input",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya 需要 Alice 管理员安全恢复本轮任务，之后才能继续工作。 请在 Alice 中打开任务查看详情。",
    );
  });

  it.each(["server_shutdown_interrupted", "lease_released_before_terminal"])(
    "keeps interruption bookkeeping for %s inside Paperclip",
    (errorCode) => {
      expect(
        safeMilestoneText({
          agentName: "Maya",
          errorCode,
          milestone: "failed",
          issueId: "issue-1",
        }),
      ).toBe(
        "Maya 在完成本轮任务前停止。 请在 Alice 中打开任务查看详情。",
      );
    },
  );

  it("explains an allowlisted native provider capacity failure without exposing provider details", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "native_provider_usage_limit",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe(
      "Maya 未能完成本轮任务，因为模型服务商的使用额度已耗尽。请由 Alice 管理员恢复容量后重试。 请在 Alice 中打开任务查看详情。",
    );
  });

  it("confirms an explicit Slack Stop without claiming an unexpected failure", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        errorCode: "slack_session_stopped",
        milestone: "failed",
        issueId: "issue-1",
      }),
    ).toBe("Maya 已按你的要求停止。");
  });

  it("projects a successful run without an explicit reply as a generic completion", () => {
    expect(
      safeMilestoneText({
        agentName: "Maya",
        milestone: "completed",
        issueId: "issue-1",
      }),
    ).toBe("Maya 已完成本轮任务。");
  });
});

describe("chat agent comment publication authorization", () => {
  const metadata = (authorizationReason: string | null) => ({
    version: 1 as const,
    authorizationReason,
    sections: [
      {
        title: "Authorization",
        rows: [
          {
            type: "key_value" as const,
            label: "Reason",
            value: authorizationReason ?? "none",
          },
        ],
      },
    ],
  });

  it.each([
    "paperclip_runner_protocol",
    "allow_visible_issue_write",
    "allow_scoped_agent_write",
    "allow_chat_run_presentation",
  ])("allows an explicitly authored agent reply with reason %s", (reason) => {
    expect(isExplicitExternalAgentComment(metadata(reason))).toBe(true);
  });

  it.each([
    "internal_agent_write",
    "execution_workspace_branch_reconcile",
    "",
    null,
  ])(
    "keeps an internal agent comment with reason %s inside Paperclip",
    (reason) => {
      expect(isExplicitExternalAgentComment(metadata(reason))).toBe(false);
    },
  );
});
