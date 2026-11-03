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
    expect(messages.skill_not_found_9d0a5468).toBe("未找到技能。");
    expect(messages.no_test_runs_yet_pick_an_agent_and_run_a16187a9).toBe(
      "暂无测试运行记录。请选择智能体并开始运行。",
    );
    expect(messages.no_team_catalog_configured_23ebee3c).toBe("尚未配置团队目录。");
    expect(messages.nothing_needs_you_right_now_e9877921).toBe("目前没有需要你处理的内容。");
    expect(messages.no_stages_configured_6acf8a75).toBe("尚未配置阶段。");
    expect(messages.advanced_child_settings_hidden_while_break_into_pieces_enabled_1e9928a3).toBe(
      "启用“拆分为更小条目”后，高级子条目设置会隐藏。请在自动化中配置该流程。",
    );
    expect(messages.no_secrets_yet_create_shared_or_user_supplied_secret_700fe184).toBe(
      "暂无密钥。你可以创建组织共享密钥或由各用户提供的密钥。",
    );
    expect(messages.could_not_load_timeline_aggregation_endpoint_may_be_unavailable_0c3b69f2).toBe(
      "无法加载时间线，汇总接口可能不可用。",
    );
    expect(messages.user_profile_not_found_for_this_organization_1117e51f).toBe(
      "此组织中未找到该用户资料。",
    );
    expect(messages.failed_to_refresh_adapter_models_d6cd5e90).toBe("刷新适配器模型失败。");
    expect(messages.no_connection_selected_connect_account_to_continue_c2c2eb6b).toBe(
      "尚未选择连接。请连接账户后继续。",
    );
    expect(messages.could_not_save_across_devices_retry_when_reconnected_a7620309).toBe(
      "无法跨设备保存。重新连接或返回后将自动重试。",
    );
    expect(messages.alice_shipped_newer_default_843f7d52).toBe("Alice 已提供更新的默认版本。");
    expect(messages.restart_alice_now_704f60f7).toBe("现在重启 Alice？");
    expect(messages.grok_instructions_file_hint_alice_426049a1).toContain(
      "Alice 会在可行时将其放入 Grok 工作区",
    );
    expect(messages.external_delivery_retry_body_alice_db868c38).toBe(
      "Alice 将重试本次发布，并保留你的草稿和重试标识。",
    );
    expect(messages.webhook_loopback_warning_alice_50bda791).toContain(
      "GitHub 等服务无法通过该地址访问你电脑上的 Alice",
    );
    expect(messages.new_in_alice_7a1d321b).toBe("Alice 新功能");
    expect(messages.alice_secret_name_already_used_095a719e).toBe("已有 Alice 密钥使用此名称。");
    expect(messages.import_result_counts_50271350).toBe(
      "已创建 {{v0}} 项 · 已跳过 {{v1}} 项 · 失败 {{v2}} 项",
    );
    expect(messages.skill_now_editable_in_alice_workspace_1a7f6704).toBe(
      "现在可在 Alice 工作区中编辑 {{v0}}。",
    );
    expect(messages.activity_moved_to_value_dbb053ec).toBe("移至{{v0}}");
    expect(messages.activity_requested_approval_on_dfeaf6d7).toBe("请求审批：");
    expect(messages.activity_updated_organization_budget_7ccafcc6).toBe("更新了组织预算");
    expect(messages.no_matching_secrets_create_one_to_bind_87db44e7).toBe(
      "没有匹配的密钥。请创建密钥后在此绑定。",
    );
    expect(messages.no_services_configured_for_workspace_19f147cb).toBe("此工作区尚未配置服务。");
    expect(messages.default_agent_field_4863dadf).toBe("默认智能体");
    expect(messages.environment_secret_key_faa91bf7).toBe("环境变量 {{v0}} 的密钥");
    expect(messages.environment_keys_changed_many_7278f62e).toBe("修改 {{v0}} 个环境变量");
    expect(messages.trigger_removed_value_b5ed4db8).toBe("移除触发器（{{v0}}）");
    expect(messages.enabled_skills_materialized_alice_bundle_b3af24c0).toContain("由 Alice 管理");
    expect(messages.applied_on_next_run_ddcedb38).toBe("下次运行时应用");
    expect(messages.alice_cannot_manage_openclaw_skills_b98627a5).toContain("请前往你的 OpenClaw 实例");
    expect(messages.connection_removed_from_alice_2b93f280).toBe("连接已从 Alice 中移除。");
    expect(messages.remove_slack_guidance_alice_f44800a2).toContain("不会卸载 Slack 应用");
    expect(messages.could_not_copy_number_manually_f591d033).toBe("无法复制号码，请手动选择并复制。");
    expect(messages.slash_command_label_ec8382bc).toBe("斜杠命令");
    expect(messages.alice_could_not_connect_address_retry_25a88b1e).toBe("Alice 无法连接该地址。请检查后重试。");
    expect(messages.alice_public_https_oauth_guidance_01eb902f).toContain("请让 Alice 管理员完成配置");
    expect(messages.add_header_value_or_remove_row_a33a2b2a).toBe("请为“{{v0}}”填写值，或删除这一行。");
    expect(messages.alice_retries_after_blocker_clears_e5d25a51).toContain("Alice 会自动重试");
    expect(messages.alice_no_pipeline_action_path_2c765bb2).toContain("重新运行当前阶段");
    expect(messages.rerun_stage_automation_565101d6).toBe("重新运行阶段自动化");
    expect(messages.alice_managed_9cb2150a).toBe("由 Alice 管理");
    expect(messages.no_installed_skills_discover_or_create_4525f28e).toContain("暂无已安装技能");
    expect(messages.detach_skill_before_removing_67159c97).toContain("先从所有智能体中解除关联");
    expect(messages.skill_in_library_not_enabled_add_to_agent_20bb9ce4).toContain("添加到智能体");
    expect(messages.alice_managed_secret_mode_e8dc78bb).toBe("由 Alice 管理");
    expect(messages.alice_resolves_reference_can_update_value_888e9f81).toContain("更新值");
    expect(messages.provider_vault_disabled_7baa5d89).toBe("此提供方密钥库已禁用。");
    expect(messages.last_resolved_user_values_per_member_855bce82).toContain("按成员分别解析");
    expect(messages.available_variables_66ba4500).toBe("可用变量");
    expect(messages.choose_existing_workspace_before_saving_stage_03c49382).toContain("选择已有工作区");
    expect(messages.approved_items_move_to_8ef0703d).toBe("通过后移动到");
    expect(messages.stay_in_review_1fde448b).toBe("留在评审阶段");
    expect(messages.item_has_circular_row_dependency_49213091).toContain("循环等待");
    expect(messages.retry_previous_step_1b69b7fa).toBe("重试上一步");
    expect(messages.unassigned_items_e26a6106).toBe("未分配条目");
    expect(messages.value_moved_to_next_review_8f9277e7).toContain("下一条评审");
    expect(messages.work_products_label_c9e7b709).toBe("工作成果");
    expect(messages.team_trust_markdown_only_tip_61c372af).toContain("不含可执行内容");
    expect(messages.team_trust_assets_tip_1843c6f2).toContain("静态资源");
    expect(messages.team_trust_scripts_tip_ecb5e7d1).toContain("安全审查");
    expect(messages.team_trust_external_sources_tip_d6aa51d4).toContain("安装时解析");
    expect(messages.failed_to_load_team_install_preview_d243e628).toBe("无法加载团队安装预览。");
    expect(messages.skills_label_02b7848c).toBe("项技能");
    expect(messages.webhook_4814f62c).toBe("回调通知");
    expect(messages.github_webhook_62487aeb).toBe("GitHub 回调通知");
    expect(messages.http_webhook_676845ee).toBe("HTTP 回调通知");
    expect(messages.webhook_url_84805a75).toBe("回调通知地址");
    expect(Object.values(messages).filter((value) => /webhook/i.test(value))).toEqual([]);
    expect(messages.the_login_did_not_return_a_saved_connection_t_35407fca).toBe("登录后未返回已保存的连接，请重试。");
    expect(messages.the_model_provider_has_reached_its_current_us_14acaa2d).toContain("用量上限");
    expect(messages.the_previous_execution_must_be_checked_before_b8424cab).toContain("上一次执行");
    expect(messages.the_provider_rejected_the_selected_model_chec_e8030a7c).toContain("服务商拒绝了所选模型");
    expect(messages.we_couldn_t_confirm_whether_this_comment_was_d18cbb20).toContain("可能已经出现在对话中");
    expect(messages.we_couldn_t_load_who_this_connection_acts_as_8d0b5a1b).toContain("刷新页面后重试");
    expect(messages.connected_this_account_is_saved_in_connection_95a419a8).toContain("连接管理");
    expect(messages.the_routine_is_paused_enable_its_automatic_tr_28f90721).toBe("例行任务已暂停。准备使用此计划时，请启用自动触发器。");
    expect(messages.allow_new_codex_agents_to_select_the_experime_813b44bc).toContain("新手引导仍使用旧版适配器");
    expect(messages.paperclip_could_not_validate_this_skill_as_ag_11cb7a41).toContain("智能体技能 Markdown");
    expect(Object.values(messages).filter((value) => /\bURL\b/.test(value))).toEqual([]);
    expect(Object.values(messages).filter((value) => /Application ID|Client ID|Client Secret|Tenant ID|Signing Secret|Alice Runner|Runner Inspector/.test(value))).toEqual([]);
    expect(Object.values(messages).filter((value) => /请求 地址|此 地址|实例 地址|回调 地址|网关 地址/.test(value))).toEqual([]);
  });
});
