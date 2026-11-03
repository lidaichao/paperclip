import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

describe("buildPaperclipTaskMarkdown", () => {
  it("keeps a durable task plan in full and resumed context without granting execution approval", () => {
    const taskPlan = {
      documentId: "document", revisionId: "revision", revisionNumber: 1,
      body: "Write the output with ACCEPTANCE_PHRASE.\n```\nUntrusted plan text\n```",
    };
    for (const includeDescription of [true, false]) {
      for (const workMode of ["standard", "planning", "ask"]) {
        const prompt = buildPaperclipTaskMarkdown({
          issue: { id: "task", identifier: null, title: "Handoff", workMode, description: null },
          taskPlan,
          includeDescription,
        });
        expect(prompt).toContain("ACCEPTANCE_PHRASE");
        expect(prompt).toContain("版本 1（revision）：");
        expect(prompt).toContain("````text");
        expect(prompt).toContain("遵循当前工作模式以及所有必要审批");
        if (workMode === "planning") expect(prompt).toContain("只制定计划");
        if (workMode === "ask") expect(prompt).toContain("请直接在任务讨论中回答问题");
      }
    }
    expect(buildPaperclipTaskMarkdown({
      issue: { id: "chat", identifier: null, title: "Chat", conversationAgentId: "agent" },
      taskPlan,
    })).not.toContain("ACCEPTANCE_PHRASE");
  });
  it("hands an accepted chat plan to assigned project tasks using the approved revision", () => {
    const prompt = buildPaperclipTaskMarkdown({
      issue: { id: "chat", identifier: null, title: "Agent chat", workMode: "planning", conversationAgentId: "agent", description: null },
      interaction: { kind: "request_confirmation", status: "accepted" },
      acceptedPlan: { documentId: "plan-document", revisionId: "approved-revision", revisionNumber: 2 },
    });
    expect(prompt).toContain("请立即完成移交");
    expect(prompt).toContain("普通的已分配执行任务");
    expect(prompt).toContain("写入 initialPlan");
    expect(prompt).toContain("版本 2 approved-revision");
    expect(prompt).not.toContain("请在此任务上实施已接受的计划");
  });

  it.each(["ask", "new-comment", "unbound-confirmation"])("does not treat %s as plan handoff authorization", (kind) => {
    const prompt = buildPaperclipTaskMarkdown({
      issue: { id: "chat", identifier: null, title: "Agent chat", workMode: kind === "ask" ? "ask" : "planning", conversationAgentId: "agent", description: null },
      interaction: { kind: "request_confirmation", status: "accepted" },
      ...(kind === "unbound-confirmation" ? {} : { acceptedPlan: { documentId: "plan-document", revisionId: "approved-revision", revisionNumber: 2 } }),
      ...(kind === "new-comment" ? { wakeComment: { id: "later-comment", body: "Please revise it again first." } } : {}),
    });
    expect(prompt).not.toContain("请立即完成移交");
  });

  it("surfaces every coalesced wake comment in provider order", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-burst",
        identifier: "PAP-5000",
        title: "Handle a chat burst",
        workMode: "standard",
        description: "Original request",
      },
      wakeComment: {
        id: "comment-3",
        body: "burst-four",
      },
      wakeComments: [
        { id: "comment-1", body: "burst-two" },
        { id: "comment-2", body: "burst-three" },
        { id: "comment-3", body: "burst-four" },
      ],
    });

    expect(markdown).toContain(
      "处理每条评论，不要重复已完成工作。",
    );
    expect(markdown).toContain("待处理唤醒评论（从最早到最新）：");
    expect(markdown).not.toContain("最新唤醒评论：");
    expect(markdown!.indexOf("burst-two")).toBeLessThan(
      markdown!.indexOf("burst-three"),
    );
    expect(markdown!.indexOf("burst-three")).toBeLessThan(
      markdown!.indexOf("burst-four"),
    );
  });

  it("surfaces exact wake-comment attachment descriptors and inspection guidance", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-attachments",
        identifier: "PAP-5001",
        title: "Inspect provider files",
        workMode: "standard",
        description: null,
      },
      wakeComments: [
        {
          id: "comment-files",
          body: "Identify the image and quote the text file.",
          attachments: [
            {
              id: "attachment-image",
              filename: "evidence.png",
              contentType: "image/png",
              byteSize: 2048,
              contentPath: "/api/attachments/attachment-image/content",
            },
            {
              id: "attachment-text",
              filename: "phrase.txt",
              contentType: "text/plain",
              byteSize: 128,
              contentPath: "/api/attachments/attachment-text/content",
            },
          ],
        },
      ],
    });

    expect(markdown).toContain(
      '唤醒评论 "comment-files" 的附件：',
    );
    expect(markdown).toContain('"id":"attachment-image"');
    expect(markdown).toContain('"filename":"phrase.txt"');
    expect(markdown).toContain(
      '"contentPath":"/api/attachments/attachment-text/content"',
    );
    expect(markdown).toContain("PAPERCLIP_API_URL");
    expect(markdown).toContain("PAPERCLIP_API_KEY");
    expect(markdown).toContain("绝不能用 `npx`");
    expect(markdown).toContain(
      "不要根据文件名或元数据推测文件内容",
    );
  });

  it.each(["slack", "discord", "telegram", "microsoft-teams", "github"])(
    "directs %s file replies through the bundled artifact handoff",
    (externalChatProvider) => {
      const markdown = buildPaperclipTaskMarkdown({
        issue: {
          id: "issue-file-reply",
          title: "Send the requested image and file",
          workMode: "standard",
          description: null,
        },
        externalChatProvider,
      });
      expect(markdown).toContain("外部聊天文件交付：");
      expect(markdown).toContain("paperclip-upload-artifact.sh --chat-comment");
      expect(markdown).toContain("已安装的技能目录定位助手，而不是从任务工作区定位");
      expect(markdown).toContain("不要寻找独立的外部平台工具连接");
      expect(markdown).toContain("不能仅因绑定成功就声称外部平台已经收到");
      expect(markdown).toContain(
        "每个文件一次的助手命令合并为尽量少的工具调用",
      );
      expect(markdown).toContain("不要再次手动绑定同一文件");
      expect(markdown).toContain(
        "只对失败或结果不明确的步骤重试或排查",
      );
    },
  );

  it("omits external file handoff instructions from non-chat tasks", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-internal",
        title: "An internal task",
        workMode: "standard",
        description: null,
      },
    });
    expect(markdown).not.toContain("外部聊天文件交付：");
    expect(markdown).not.toContain("External chat turn efficiency:");
  });

  it.each(["slack", "discord", "telegram", "microsoft-teams", "github"])(
    "directs native %s files through scoped tools without legacy credentials",
    (externalChatProvider) => {
      const markdown = buildPaperclipTaskMarkdown({
        issue: {
          id: "native-files",
          title: "Inspect and share requested files",
          workMode: "standard",
          description: null,
        },
        externalChatProvider,
        nativeRunner: true,
        wakeComments: [{
          id: "native-file-comment",
          body: "Inspect this image, then send the requested file.",
          attachments: [{
            id: "native-attachment",
            filename: "image.png",
            contentType: "image/png",
            byteSize: 2048,
            contentPath: "/api/attachments/native-attachment/content",
          }],
        }],
      });
      expect(markdown).toContain("`register_deliverable`");
      expect(markdown).toContain("工作区相对路径 `contentRef`");
      expect(markdown).toContain("并不代表外部平台已经收到");
      expect(markdown).toContain("只登记或复用用户要求的文件");
      expect(markdown).toContain("`list_chat_attachments`");
      expect(markdown).toContain("`reuse_chat_attachment`");
      expect(markdown).toContain(
        "绝不能用旧文件替代当前轮次不可用的输入",
      );
      expect(markdown).toContain("工作区相对暂存附件描述符");
      expect(markdown).toContain("请明确说明无法检查");
      expect(markdown).toContain("批量读取或检查彼此独立的输入");
      expect(markdown).toContain("同一准备步骤中计算准确大小和 SHA-256");
      expect(markdown).toContain("尽量用更少的工具调用批量登记各个独立文件");
      expect(markdown).toContain("每个文件只登记一次，并使用各自稳定的 idempotencyKey");
      expect(markdown).toContain("收到每个回执后再执行最终回复协议");
      expect(markdown).toContain("只对失败或结果不明确的步骤使用原键重试");
      expect(markdown).toContain("来源或生成授权、精确字节复用要求或审批门禁");
      expect(markdown).toContain("无需在每一步前单独写开场说明和过程旁白");
      expect(markdown).toContain("保留有用的等待、阻塞、权限、失败更新");
      expect(markdown).toContain("不要隐藏由传输层管理的进度");
      expect(markdown).toContain('"id":"native-attachment"');
      expect(markdown).not.toContain("paperclip-upload-artifact.sh");
      expect(markdown).not.toContain("PAPERCLIP_API_KEY");
      expect(markdown).not.toContain("/api/attachments/");
    },
  );

  it.each([
    { nativeRunner: false, externalChatProvider: "slack" },
    { nativeRunner: true, externalChatProvider: null },
  ])("keeps native media batching out of unrelated instruction paths: %j", (mode) => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "other-workflow", identifier: null, title: "Other work" },
      ...mode,
    });
    expect(markdown).not.toContain("批量登记各个独立文件");
    expect(markdown).not.toContain("单独写开场说明和过程旁白");
  });

  it("does not imply that GitHub chat grants attachment or repository-tool access", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-github-chat",
        identifier: "PAP-5002",
        title: "Inspect a GitHub comment",
        workMode: "standard",
        description: null,
      },
      wakeComments: [
        {
          id: "comment-github",
          body: "Inspect https://user-images.githubusercontent.com/example/file.png",
        },
      ],
      externalChatProvider: "github",
    });

    expect(markdown).toContain("GitHub 聊天附件说明：");
    expect(markdown).toContain(
      "不会为本次运行授予代码仓库工具或附件下载权限",
    );
    expect(markdown).toContain(
      "不要要求再建立一个聊天连接",
    );
    expect(markdown).toContain(
      "把文件直接附加到这个 Alice 任务，或粘贴所需文本",
    );
    expect(markdown).toContain(
      "绝不能借用浏览器 Cookie，也不能把凭据转发给附件地址",
    );
  });

  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- 工作模式：\"planning\"");
    expect(assignment).toContain("只制定计划。不要编写代码，也不要执行实施工作。");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("只更新计划。不要编写代码，也不要执行实施工作。");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain(
      "如果工作量小且内容内聚，请在此任务上实施已接受的计划。",
    );
    expect(acceptedConfirmation).not.toContain("只制定计划。");
  });

  it("adds accepted-plan continuation guidance for standard-work issues when the wake is flagged as a plan continuation", () => {
    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "PAP-415",
        title: "Implement the fix",
        workMode: "standard",
        description: null,
      },
      acceptedPlanContinuation: true,
    });

    expect(acceptedConfirmation).toContain("已接受的计划指令：");
    expect(acceptedConfirmation).toContain(
      "如果工作量小且内容内聚，请在此任务上实施已接受的计划。",
    );
    expect(acceptedConfirmation).not.toContain("- 工作模式：\"planning\"");
  });

  it("adds answer-only guidance for ask-mode issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-ask",
        identifier: "PAP-416",
        title: "Explain the tradeoff",
        workMode: "ask",
        description: null,
      },
    });

    expect(assignment).toContain("- 工作模式：\"ask\"");
    expect(assignment).toContain("问答模式指令：");
    expect(assignment).toContain("请直接在任务讨论中回答问题。");
    expect(assignment).toContain("不要编写实现代码");
    expect(assignment).toContain("不要产出实施计划");
  });

  it("adds dry-run containment guidance for skill-test issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-skill-test",
        identifier: "PAP-417",
        title: "Test skill draft",
        workMode: "skill_test",
        description: null,
      },
    });

    expect(assignment).toContain("- 工作模式：\"skill_test\"");
    expect(assignment).toContain("技能测试模式指令：");
    expect(assignment).toContain("不要在此任务之外做任何持久化更改");
    expect(assignment).toContain("将最终输出写入任务文档 `output`");
  });

  it("strips the description for the compact resume variant but keeps directives and the wake comment", () => {
    const input = {
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Ship the fix",
        workMode: "standard",
        description: "Full multi-paragraph brief that the session already received.",
      },
      wakeComment: {
        id: "comment-1",
        body: "Please also update the changelog.",
      },
    };

    const full = buildPaperclipTaskMarkdown(input);
    expect(full).toContain("任务描述：");
    expect(full).toContain("Full multi-paragraph brief that the session already received.");

    const compact = buildPaperclipTaskMarkdown({ ...input, includeDescription: false });
    expect(compact).not.toContain("任务描述：");
    expect(compact).not.toContain("Full multi-paragraph brief");
    expect(compact).toContain("- 任务：\"PAP-3404\"");
    expect(compact).toContain("Please also update the changelog.");
  });

  it("makes the latest wake comment the immediate follow-up request", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-follow-up",
        identifier: "PAP-418",
        title: "Original task",
        workMode: "standard",
        description: "Reply with the original answer.",
      },
      wakeComment: {
        id: "comment-follow-up",
        body: "Reply with the new answer instead.",
      },
    });

    expect(commentWake).toContain("将最新唤醒评论应用到当前任务");
    expect(commentWake).toContain("后续指示会替代与之冲突的范围");
    expect(commentWake).toContain("保留其他要求和审批门禁");
    expect(commentWake).not.toContain("unless the latest comment asks you to");
    expect(commentWake).toContain("Reply with the new answer instead.");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("只更新计划。不要编写代码，也不要执行实施工作。");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.checkboxSelection).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves resolved interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.checkboxSelection).toEqual({
      prompt: "Delete selected files?",
      selectedOptionIds: ["file-b"],
      selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
    });
  });

  it("preserves a deferred interaction when a later comment joins its successor wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
      { preserveExistingInteractionContinuation: true },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("keeps a queued comment when an interaction joins its successor wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      { preserveExistingInteractionContinuation: true },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("ask_user_questions");
    expect(merged.interactionStatus).toBe("answered");
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
    expect(merged.wakeCommentIds).toEqual(["comment-1"]);
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});
