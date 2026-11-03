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
    expect(messages.preview_review_no_success_0c910001).toContain("直接进入评审");
    expect(messages.alice_subscription_api_keys_0c910002).toContain("现有的订阅或 API 密钥");
    expect(messages.provide_provider_api_key_0c910003).toBe("提供 {{v0}} API 密钥以连接");
    expect(messages.mcp_paste_complete_server_address_0c910004).toContain("完整服务器地址");
    expect(messages.mcp_check_provider_credentials_0c910005).toContain("智能体访问权限和工具选择将保留");
    expect(messages.mcp_check_endpoint_reachable_0c910006).toContain("Alice 可以访问");
    expect(messages.open_provider_setup_guide_0c910007).toBe("打开 {{v0}} 设置指南");
    expect(messages.zapier_create_mcp_server_0c910101).toContain("创建 MCP 服务器");
    expect(messages.arcade_copy_gateway_address_0c910109).toContain("MCP 网关地址");
    expect(messages.composio_prefilled_external_session_0c910113).toContain("高级身份验证");
    expect(messages.executor_workspace_address_reachable_alice_0c910118).toContain("Alice 可以访问");
    expect(messages.no_agents_set_up_add_first_0c920001).toContain("添加一个智能体");
    expect(messages.all_agents_paused_resume_sidebar_0c920002).toContain("所有智能体均已暂停");
    expect(messages.agents_running_activity_soon_0c920003).toContain("智能体正在运行");
    expect(messages.invite_address_selected_copy_manually_0c920004).toContain("邀请地址已选中");
    expect(messages.secret_name_lowercase_digits_0c920006).toContain("小写字母、数字和下划线");
    expect(messages.secret_missing_runs_fail_rebind_0c920012).toContain("运行会失败");
    expect(messages.user_secret_disabled_runs_fail_0c920015).toContain("用户密钥定义");
    expect(messages.file_viewer_sensitive_body_0c930002).toContain("敏感数据");
    expect(messages.file_viewer_outside_body_0c930003).toContain("任务工作区内");
    expect(messages.file_viewer_cleaned_body_0c930004).toContain("隔离工作树已清理");
    expect(messages.file_viewer_unsupported_body_0c930006).toContain("文本、图片或视频预览");
    expect(messages.unable_to_load_file_content_0c930009).toBe("无法加载文件内容。");
    expect(messages.file_contents_unavailable_0c930010).toBe("文件内容不可用。");
    expect(messages.instructions_file_runtime_prompt_0c940001).toContain("注入提示词");
    expect(messages.instructions_file_gemini_prompt_0c940002).toContain("Gemini 提示词前");
    expect(messages.instructions_file_kimi_prompt_0c940003).toContain("Kimi 提示词前");
    expect(messages.instructions_file_system_prompt_0c940004).toContain("注入系统提示词");
    expect(messages.choose_agent_0c950001).toBe("选择智能体");
    expect(messages.alice_could_not_read_pem_file_0c950005).toContain("重新选择 .pem 文件");
    expect(messages.alice_messaging_endpoint_0c950014).toBe("Alice 消息接收地址");
    expect(messages.slack_app_name_help_0c950022).toContain("Slack 应用目录");
    expect(messages.discover_and_link_messages_identity_0c950031).toContain("权限管理");
    expect(messages.unlinked_account_guest_work_off_0c950037).toContain("不会重新执行");
    expect(messages.link_sender_to_alice_person_0c950042).toContain("Alice 用户");
    expect(messages.open_installed_bot_text_channel_0c950046).toBe("打开已安装机器人的文字频道。");
    expect(messages.open_installed_issue_or_pull_request_0c950052).toContain("议题或拉取请求");
    expect(messages.reply_in_agent_thread_0c950060).toContain("讨论串");
    expect(messages.empty_agent_slot_0c960001).toBe("空智能体槽位");
    expect(messages.agent_configured_offline_0c960002).toContain("当前离线");
    expect(messages.my_provider_subscription_0c960004).toBe("我的 {{v0}} 订阅");
    expect(messages.select_organization_to_test_environment_0c960008).toContain("测试适配器环境");
    expect(messages.run_heartbeat_every_0c960009).toBe("心跳运行间隔");
    expect(messages.sign_in_to_environment_0c960011).toBe("登录运行环境");
    expect(messages.another_sign_in_attempt_active_0c960012).toContain("另一个登录流程正在进行");
    expect(messages.zapier_gallery_tagline_0c970001).toContain("9,000 多款应用");
    expect(messages.github_gallery_copy_0c970003).toContain("拉取请求");
    expect(messages.railway_gallery_short_0c970008).toContain("容器访问");
    expect(messages.posthog_gallery_tagline_0c970009).toContain("功能开关和实验");
    expect(messages.gmail_gallery_copy_0c970014).toContain("创建草稿");
    expect(messages.google_workspace_search_gallery_copy_0c970021).toContain("Google 工作区");
    expect(messages.generic_app_gallery_copy_0c970027).toBe("授权智能体访问此应用。");
    expect(messages.upstream_work_changed_review_latest_0c980003).toContain("上游工作已发生变化");
    expect(messages.pipeline_item_added_0c980005).toBe("已添加条目。");
    expect(messages.moved_from_stage_to_stage_0c980008).toContain("已从“{{v0}}”移动到“{{v1}}”");
    expect(messages.pipeline_movement_automatic_reason_0c980011).toContain("自动执行");
    expect(messages.review_requested_changes_0c980021).toBe("评审要求修改。");
    expect(messages.upstream_change_acknowledged_0c980033).toBe("已确认上游变更。");
    expect(messages.automation_needs_attention_reason_0c980037).toContain("需要处理");
    expect(messages.work_handoff_cleared_0c980040).toBe("工作交接已清除。");
    expect(messages.thought_for_seconds_0c990001).toBe("思考了 {{v0}} 秒");
    expect(messages.provider_session_total_0c990003).toBe("服务商会话总用量");
    expect(messages.interrupted_before_provider_completion_0c990005).toContain("运行已中断");
    expect(messages.ran_count_commands_0c990009).toBe("已运行 {{v0}} 条命令");
    expect(messages.used_count_subagents_0c990017).toContain("子智能体");
    expect(messages.read_from_alice_0c990040).toBe("已从 Alice 读取信息");
    expect(messages.activity_summary_more_0c990047).toContain("另有 {{v1}} 项");
    expect(messages.no_tool_activity_0c990049).toBe("没有工具活动");
    expect(messages.runner_activity_4da41ca2).toBe("运行器活动");
    expect(messages.monday_0ca00001).toBe("星期一");
    expect(messages.connect_sending_app_to_alice_routine_0ca00008).toContain("Alice 例行任务");
    expect(messages.webhook_url_value_0ca00009).toContain("回调通知地址");
    expect(messages.github_secret_signature_guidance_0ca00015).toContain("不要使用 Bearer 身份验证");
    expect(messages.unique_idempotency_key_guidance_0ca00023).toContain("避免启用后重复测试");
    expect(messages.finish_setup_in_alice_enable_webhook_0ca00028).toContain("在 Alice 中完成设置");
    expect(messages.schedule_every_weekday_at_0ca00032).toBe("每周{{v0}} {{v1}}");
    expect(messages.choose_trigger_0ca00035).toBe("选择触发方式");
    expect(messages.choose_options_0cb00001).toBe("选择选项");
    expect(messages.no_messages_yet_0cb00006).toBe("暂无消息。");
    expect(messages.document_revision_0cb00009).toContain("修订版 {{v0}}");
    expect(messages.waiting_to_resume_0cb00011).toBe("等待恢复");
    expect(messages.runner_returned_no_user_response_0cb00015).toContain("面向用户的回复");
    expect(messages.runtime_request_missing_provider_identity_0cb00019).toContain("服务商轮次标识");
    expect(messages.queue_reordering_unavailable_0cb00022).toContain("调整队列顺序");
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
