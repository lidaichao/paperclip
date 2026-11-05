import { afterEach, describe, expect, it } from "vitest";
import { enumLabel } from "./display";
import { i18n } from "./index";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("enumLabel", () => {
  it("localizes shared runtime statuses in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(enumLabel("success")).toBe("成功");
    expect(enumLabel("processed")).toBe("已处理");
    expect(enumLabel("preparing")).toBe("准备中");
    expect(enumLabel("informational")).toBe("信息");
    expect(enumLabel("not_dispatched")).toBe("未派发");
    expect(enumLabel("ended")).toBe("已结束");
    expect(enumLabel("revision_requested")).toBe("已要求修改");
    expect(enumLabel("oauth_failed")).toBe("OAuth 认证失败");
    expect(enumLabel("file_info_unknown")).toBe("文件信息状态未知");
    expect(enumLabel("preview_url")).toBe("预览链接");
    expect(enumLabel("needs_board_review")).toBe("需要管理层审核");
    expect(enumLabel("job")).toBe("作业");
    expect(enumLabel("ephemeral")).toBe("临时");
    expect(enumLabel("cleanup_failed")).toBe("清理失败");
    expect(enumLabel("script")).toBe("脚本");
    expect(enumLabel("asset")).toBe("资源");
    expect(enumLabel("designer")).toBe("设计师");
    expect(enumLabel("devops")).toBe("运维工程师");
    expect(enumLabel("boolean")).toBe("布尔值");
    expect(enumLabel("unsupported")).toBe("不支持预览");
    expect(enumLabel("software-development")).toBe("软件开发");
    expect(enumLabel("paperclip-operations")).toBe("Alice 运维");
    expect(enumLabel("quality")).toBe("质量保障");
    expect(enumLabel("tool_result")).toBe("工具结果");
    expect(enumLabel("workspace_change")).toBe("工作区变更");
    expect(enumLabel("runtime_request")).toBe("运行请求");
    expect(enumLabel("runner_verified")).toBe("运行器已验证");
    expect(enumLabel("needs_review")).toBe("需要审核");
    expect(enumLabel("slack_post_message")).toBe("发送 Slack 消息");
    expect(enumLabel("slack_delete_message")).toBe("删除 Slack 消息");
    expect(enumLabel("slack_canvas_sections")).toBe("查找 Slack 画布区段");
    expect(enumLabel("issue_responsible_user")).toBe("任务负责人");
    expect(enumLabel("queued_comment_interrupt")).toBe("队列评论中断");
    expect(enumLabel("company_default")).toBe("公司默认");
    expect(enumLabel("dedicated")).toBe("专用");
    expect(enumLabel("mapped")).toBe("已映射");
    expect(enumLabel("operator_only")).toBe("仅操作员");
    expect(enumLabel("normalized")).toBe("已标准化");
    expect(enumLabel("dropped")).toBe("已丢弃");
    expect(enumLabel("company", "lower")).toBe("公司");
    expect(enumLabel("team", "lower")).toBe("团队");
    expect(enumLabel("task", "lower")).toBe("任务");
    expect(enumLabel("automation", "lower")).toBe("自动化");
    expect(enumLabel("warn", "lower")).toBe("警告");
    expect(enumLabel("debug", "lower")).toBe("调试");
    expect(enumLabel("manual", "lower")).toBe("手动");
    expect(enumLabel("create", "lower")).toBe("创建");
    expect(enumLabel("update", "lower")).toBe("更新");
    expect(enumLabel("skip", "lower")).toBe("跳过");
    expect(enumLabel("rename", "lower")).toBe("重命名");
  });

  it("keeps English labels readable", async () => {
    await i18n.changeLanguage("en");

    expect(enumLabel("not_dispatched")).toBe("Not Dispatched");
  });
});
