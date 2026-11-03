import { describe, expect, it } from "vitest";

import zhCN from "./locales/zh-CN.json";

describe("remaining visible Chinese copy", () => {
  it("localizes common interface fragments instead of leaking English", () => {
    const messages = zhCN.local;

    expect(messages.complete_eebbf645).toBe("已完成");
    expect(messages.connection_1b33ea86).toBe("连接。");
    expect(messages.discoverable_0577d9b9).toBe("可发现");
    expect(messages.frame_9dff50df).toBe("帧");
    expect(messages.frames_594cfd26).toBe("帧");
    expect(messages.installed_a51a6c19).toBe("已安装");
    expect(messages.iterations_2a09eb92).toBe("次迭代");
    expect(messages.no_9390298f).toBe("否");
    expect(messages.null_74234e98).toBe("空值");
    expect(messages.omitted_f34912a1).toBe("项已省略");
    expect(messages.read_3316348d).toBe("已读");
    expect(messages.reconnected_6f0258f8).toBe("已重新连接");
    expect(messages.removed_432c93eb).toBe("已移除。");
    expect(messages.risk_2c6ef0f0).toBe("风险");
    expect(messages.selected_a1260b5d).toBe("已选择。");
    expect(messages.seq_4f5260d7).toBe("序号");
    expect(messages.skills_6608627b).toBe("技能。");
    expect(messages.subscription_a8fa7fd6).toBe("订阅");
    expect(messages.trigger_683259fe).toBe("个触发器");
    expect(messages.triggers_51936fd3).toBe("个触发器");
    expect(messages.yes_8a798890).toBe("是");
    expect(messages.you_bb0347a4).toBe("你");
    expect(messages.agent_alpha_d47b013c).toBe("智能体 Alpha");
    expect(messages.responsible_user_s_connection_08b7643a).toBe("负责人账户的连接");
    expect(messages.select_a_company_to_create_secrets_1935ffb5).toBe("请先选择公司，再创建密钥");
    expect(messages.select_a_company_to_view_routines_b9a1c8b1).toBe("请选择公司以查看例行任务。");
    expect(messages.welcome_to_alice_set_up_your_first_organization_and_agent_6b1221c5).toBe(
      "欢迎使用 Alice。请先创建组织和第一个智能体。",
    );
    expect(messages.no_tasks_assigned_to_you_d625b004).toBe("暂无分配给你的任务。");
    expect(messages.no_active_routines_use_create_routine_to_define_first_workflow_0257c2e4).toBe(
      "暂无启用的例行任务。请创建第一个周期工作流。",
    );
    expect(messages.no_variables_yet_add_placeholder_to_create_one_3f201eba).toBe(
      "暂无变量。请在标题或指令中添加 {{placeholder}} 以创建变量。",
    );
    expect(messages.select_an_organization_to_view_audit_1546e467).toBe("请选择组织以查看审计记录。");
    expect(messages.preview_request_cancelled_export_settings_unchanged_8f5a49ea).toBe(
      "预览请求已取消，导出设置未更改。",
    );
  });
});
