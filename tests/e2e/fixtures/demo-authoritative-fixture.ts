export type DemoBusinessStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
export type DemoPriority = "high" | "medium" | "low";
export type DemoDefectSeverity = "critical" | "high" | "medium" | "low";

export type DemoPlanRecordFixture = {
  key: string;
  title: string;
  assignee: "Jack" | "Rabbit" | "卡罗尔" | "Belle";
  businessStatus: DemoBusinessStatus;
  priority: DemoPriority;
  plannedStartDate: string | null;
  plannedCompletionDate: string | null;
  description: string;
  parentKey: string | null;
  predecessorKeys: string[];
  iteration: "first-available" | null;
  belongsToCurrentUser: boolean;
};

export type DemoDefectRecordFixture = {
  key: string;
  title: string;
  assignee: "Rabbit";
  qaAssignee: "Belle";
  businessStatus: DemoBusinessStatus;
  priority: DemoPriority;
  defectSeverity: DemoDefectSeverity;
  plannedCompletionDate: string;
  description: string;
};

/**
 * Mirrors the immutable, reset state in H:/project/Papercilp/prototype.
 * The visual contract clears the prototype's localStorage before every page,
 * then seeds Paperclip exclusively from this object. Generated database IDs
 * are the only values intentionally masked by the visual comparison.
 */
export const DEMO_AUTHORITATIVE_FIXTURE = {
  projectName: "星海计划",
  version: { name: "历史标记迁移" },
  iteration: { name: "首个可用版本" },
  agents: ["Jack", "Rabbit", "卡罗尔", "Belle"] as const,
  plan: [
    {
      key: "204", title: "编写活动奖励配置说明", assignee: "Jack", businessStatus: "todo", priority: "medium",
      plannedStartDate: "2026-09-22", plannedCompletionDate: "2026-09-23",
      description: "整理本期活动奖励、开放条件和结束规则。", parentKey: null, predecessorKeys: [], iteration: null,
      belongsToCurrentUser: true,
    },
    {
      key: "205", title: "适配活动页窄屏布局", assignee: "Rabbit", businessStatus: "in_progress", priority: "medium",
      plannedStartDate: "2026-09-25", plannedCompletionDate: "2026-09-28",
      description: "完成小屏设备的布局适配。", parentKey: null, predecessorKeys: [], iteration: null,
      belongsToCurrentUser: false,
    },
    {
      key: "206", title: "整理版本回归验证清单", assignee: "Belle", businessStatus: "in_review", priority: "high",
      plannedStartDate: "2026-09-25", plannedCompletionDate: "2026-09-27",
      description: "整理本期版本需要验证的关键路径。", parentKey: null, predecessorKeys: [], iteration: null,
      belongsToCurrentUser: false,
    },
    {
      key: "207", title: "验证低端设备加载表现", assignee: "Belle", businessStatus: "blocked", priority: "medium",
      plannedStartDate: "2026-09-26", plannedCompletionDate: null,
      description: "等待可用测试设备。任务受阻，不代表存在前置任务。", parentKey: null, predecessorKeys: [], iteration: null,
      belongsToCurrentUser: false,
    },
    {
      key: "208", title: "制作旧版引导过渡页", assignee: "卡罗尔", businessStatus: "cancelled", priority: "low",
      plannedStartDate: null, plannedCompletionDate: null,
      description: "旧方案不再实施，保留记录。", parentKey: null, predecessorKeys: [], iteration: null,
      belongsToCurrentUser: false,
    },
    {
      key: "210", title: "完成首局引导", assignee: "Jack", businessStatus: "in_progress", priority: "high",
      plannedStartDate: "2026-09-24", plannedCompletionDate: "2026-09-30",
      description: "汇总交互、开发与验证的交付。", parentKey: null, predecessorKeys: [], iteration: "first-available",
      belongsToCurrentUser: true,
    },
    {
      key: "201", title: "整理首局引导交互方案", assignee: "卡罗尔", businessStatus: "done", priority: "high",
      plannedStartDate: "2026-09-24", plannedCompletionDate: "2026-09-25",
      description: "整理进入、跳过和中断恢复的交互路径。", parentKey: "210", predecessorKeys: [], iteration: "first-available",
      belongsToCurrentUser: false,
    },
    {
      key: "202", title: "实现首局引导页面", assignee: "Rabbit", businessStatus: "backlog", priority: "high",
      plannedStartDate: "2026-09-26", plannedCompletionDate: "2026-09-28",
      description: "按交互方案完成页面与基础操作。", parentKey: "210", predecessorKeys: ["201"], iteration: "first-available",
      belongsToCurrentUser: false,
    },
    {
      key: "203", title: "验证首局引导完整流程", assignee: "Belle", businessStatus: "backlog", priority: "high",
      plannedStartDate: "2026-09-27", plannedCompletionDate: "2026-09-30",
      description: "验证首次进入、跳过、恢复和异常处理。", parentKey: "210", predecessorKeys: ["202"], iteration: "first-available",
      belongsToCurrentUser: false,
    },
  ] satisfies DemoPlanRecordFixture[],
  defects: [
    {
      key: "103", title: "登录失败提示不明确", assignee: "Rabbit", qaAssignee: "Belle", businessStatus: "backlog",
      priority: "high", defectSeverity: "high", plannedCompletionDate: "2026-09-27",
      description: "断网与密码错误展示不同提示，支持重新尝试。",
    },
    {
      key: "106", title: "安卓设备偶发音效丢失", assignee: "Rabbit", qaAssignee: "Belle", businessStatus: "in_review",
      priority: "medium", defectSeverity: "medium", plannedCompletionDate: "2026-09-28",
      description: "切到后台再恢复后音效正常，连续验证三次。",
    },
    {
      key: "108", title: "关卡入口加载异常", assignee: "Rabbit", qaAssignee: "Belle", businessStatus: "blocked",
      priority: "high", defectSeverity: "high", plannedCompletionDate: "2026-09-27",
      description: "冷启动可进入关卡，无无限加载。",
    },
  ] satisfies DemoDefectRecordFixture[],
  prototypeStorageKeys: [
    "paperclip-prototype-v1",
    "paperclip-plan-v2",
    "paperclip-defect-sheet-v1",
    "paperclip-gantt-columns-v1",
  ],
} as const;
