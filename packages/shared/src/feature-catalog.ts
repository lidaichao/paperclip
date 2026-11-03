import { z } from "zod";
import { instanceExperimentalSettingsSchema } from "./validators/instance.js";

/**
 * Feature catalog for cloud-managed instances.
 *
 * The instance-settings zod schema is the feature manifest; this module adds
 * only metadata about the flags the schema already declares. Keys are derived
 * from the schema type, so adding, removing, or renaming a boolean flag in
 * `instanceExperimentalSettingsSchema` without updating the metadata map is a
 * compile error (and vice versa).
 *
 * Tiers:
 * - `preference`: tenant-controllable taste setting; the cloud harness does
 *   not manage it.
 * - `managed`: the cloud harness may set this per fleet/stack via
 *   `PAPERCLIP_MANAGED_CONFIG`.
 * - `floor`: pinned by code on managed instances; no flag value may widen it.
 */
export const FEATURE_TIERS = ["preference", "managed", "floor"] as const;

export type FeatureTier = (typeof FEATURE_TIERS)[number];

type ExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;

/**
 * The boolean flag keys of the experimental settings schema. Non-flag keys
 * (activation timestamps, numeric tuning values) are excluded.
 */
export type InstanceFeatureKey = {
  [K in keyof ExperimentalSettings]: ExperimentalSettings[K] extends boolean ? K : never;
}[keyof ExperimentalSettings];

export interface FeatureCatalogEntry {
  title: string;
  description: string;
  tier: FeatureTier;
  /** Desired default on cloud-managed instances. */
  cloudDefault: boolean;
  /** Must match the schema default; enforced by test. */
  selfHostedDefault: boolean;
}

export const INSTANCE_FEATURE_CATALOG: Record<InstanceFeatureKey, FeatureCatalogEntry> = {
  enableEnvironments: {
    title: "运行环境",
    description:
      "在公司设置中显示运行环境管理，并允许为项目和智能体分配运行环境。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableNativeRunner: {
    title: "Alice 运行器",
    description:
      "允许已明确配置的本地 Codex、OpenCode 和符合条件的 ACPX 智能体使用实验性 Rust Alice 运行器；必要时启用经过身份验证的沙箱入口。初始设置仍使用旧版适配器。",
    tier: "managed",
    cloudDefault: false,
    // On by default for self-hosted instances. Requires a Rust toolchain (or
    // PAPERCLIP_RUNNER_BINARY) for `pnpm dev`, which builds runnerd whenever
    // this is on.
    selfHostedDefault: true,
  },
  enableManagedSandboxOnly: {
    title: "仅使用托管环境",
    description:
      "隐藏本地环境，并让所有智能体在平台托管的环境中运行。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIsolatedWorkspaces: {
    title: "隔离工作区",
    description:
      "在项目配置中显示执行工作区选项，并允许任务在隔离工作区中运行。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIsolatedWorkspacesByDefault: {
    title: "默认使用隔离工作区",
    description:
      "没有单独设置执行工作区策略的项目将默认使用隔离工作区，使每项任务获得独立工作树，而不是共享项目检出目录。需要先启用“隔离工作区”；已有独立策略的项目不受影响。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStreamlinedLeftNavigation: {
    title: "精简左侧导航",
    description: "使用精简的主侧边栏导航布局。",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableStreamlinedUi: {
    title: "精简界面",
    description:
      "使用精简的应用框架、共享任务集合、聚焦式任务详情、上下文导航和简化的主侧边栏。",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableApps: {
    title: "应用（兼容设置）",
    description:
      "已弃用的兼容设置。应用功能始终启用，已保存和托管的设置值会被忽略。",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableChatConnectors: {
    title: "聊天连接器",
    description:
      "显示实验性的聊天连接器设置和看板界面。隐藏后现有连接仍会运行，GitHub 和其他工具连接器不受影响。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableMcpAggregators: {
    title: "MCP 聚合器",
    description:
      "显示实验性的 Zapier、Arcade、Composio Connect 和 Executor 设置。隐藏后现有 MCP 连接仍会运行。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enablePipelines: {
    title: "流水线",
    description: "启用流水线定义，以及由流水线驱动的案例生产界面。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableCases: {
    title: "案例",
    description:
      "管理由任务创建并持续迭代的持久工作成果，同时添加“案例”页签和智能体案例 API。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableAgentChat: {
    title: "智能体对话",
    description: "使用由任务承载的持久对话澄清目标，并把工作移交给任务执行。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableConferenceRoomChat: {
    title: "会议室群聊",
    description:
      "添加会议室团队群聊、实时动态流和新版引导，并把任务讨论显示为聊天气泡。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableClassicTaskInterface: {
    title: "经典任务界面",
    description:
      "恢复聊天改版前的任务详情页：包含页面级标题栏、行内描述编辑器、普通评论串和固定属性侧边栏。经典视图不支持聊天专属功能，包括流式动态折叠、行内计划或问题卡片，以及三模式编辑器。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIssuePlanDecompositions: {
    title: "任务计划拆解",
    description: "在任务详情页显示已接受计划的拆解历史。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableExperimentalFileViewer: {
    title: "实验性文件查看器",
    description:
      "在任务详情中显示用于浏览和预览任务工作区文件的控件。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStatusCards: {
    title: "状态卡片",
    description:
      "启用实验性的共享状态卡片看板、更新引擎和受控 API。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableExternalObjects: {
    title: "外部对象",
    description:
      "识别任务中的外部网址，并显示拉取请求、工单和其他引用工作对象的解析状态。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSmokeLab: {
    title: "冒烟测试实验室",
    description:
      "添加冒烟测试实验室页签和仪表盘卡片，用确定性的本地测试数据验证集成链路。仅限私有部署。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableBuiltInAgents: {
    title: "内置智能体",
    description:
      "显示由 Alice 管理的内置智能体界面，包括成员标记、内置智能体页签和设置控件。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableBetaSkills: {
    title: "测试版技能",
    description: "允许智能体固定使用 Alice 核心技能的测试版本。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSummaries: {
    title: "摘要",
    description:
      "在项目和工作区页面显示摘要器生成的状态信息，并支持按需刷新和修订历史。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableDecisions: {
    title: "待决事项",
    description:
      "在主侧边栏显示“待决事项”，集中呈现等待人工输入的任务。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableGoalsSidebarLink: {
    title: "目标侧边栏入口",
    description: "在目标功能评估期间，恢复主侧边栏中的“目标”入口。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSimplifiedEnglishInteractions: {
    title: "简明英语交互",
    description:
      "要求智能体使用 ASD-STE100 简明技术英语撰写确认、提问和建议任务，并附上简短的决策背景。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableServerInfoDebugView: {
    title: "服务器信息调试视图",
    description:
      "在账户抽屉中显示“服务器”区域，包括当前服务器的重启时间和运行版本。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enablePaperclipDeveloperMode: {
    title: "Alice 开发者模式",
    description:
      "显示 Alice 内部维护工具和可观测性链接，包括运行页面中的 Honeycomb 链路查询。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  autoRestartDevServerWhenIdle: {
    title: "空闲时自动重启开发服务器",
    description:
      "本地开发时，等待排队中和运行中的智能体任务结束；如果后端变更使当前进程过期，则自动重启服务器。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorkspaceBranchReconcileForward: {
    title: "工作区分支前向协调",
    description:
      "允许执行工作区向前协调已分叉的记录分支，而不是直接判定分支包含关系失败。",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableWorkspaceDirtyQuarantineRepair: {
    title: "工作区脏改动隔离修复",
    description:
      "允许运行时恢复机制在执行前隔离并修复含有未提交改动的工作区。",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableOwnerInstanceAdmin: {
    title: "实例所有者管理员",
    description:
      "在云托管实例中，授予技术栈所有者对其专属实例的管理员权限。权限提升在受信任请求头的身份验证边界计算，不创建实例管理员角色记录；自托管实例不启用。",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: false,
  },
  enableSandboxDuplexBridge: {
    title: "沙箱双向桥接",
    description:
      "当运行提供方授予相应能力时，允许任务打开沙箱双向命令流桥接。主机会在每次运行选择传输方式前读取此设置；关闭后所有运行继续使用文件桥接。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableRunnerPreviewIngress: {
    title: "运行器预览入口（已弃用）",
    description:
      "仅为旧版托管配置保留的兼容设置。运行器入口现在跟随 Alice 运行器设置。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorktreeRunExecution: {
    title: "在工作树中执行任务",
    description:
      "启用后，调度器会在隔离的 Git 工作树预览实例中执行新建任务。",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableFirstTaskPlanProposal: {
    title: "首个任务：使用计划文档提案",
    description:
      "当用户的首个请求是单一任务时，由主管编写简短计划文档和勾选确认卡，而不是使用单卡确认。仅适用于启用此设置后创建的组织。",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
};

export const INSTANCE_FEATURE_KEYS = Object.keys(INSTANCE_FEATURE_CATALOG).sort() as InstanceFeatureKey[];

/**
 * Shape of the `feature-catalog.json` release artifact the cloud harness
 * imports per app release and validates feature writes against.
 */
export const featureCatalogArtifactSchema = z
  .object({
    catalogVersion: z.string().min(1),
    features: z.record(
      z.string().min(1),
      z.object({ tier: z.enum(FEATURE_TIERS) }).strict(),
    ),
  })
  .strict();

export type FeatureCatalogArtifact = z.infer<typeof featureCatalogArtifactSchema>;

export function buildFeatureCatalogArtifact(catalogVersion: string): FeatureCatalogArtifact {
  if (catalogVersion.trim().length === 0) {
    throw new Error("catalogVersion 必须是非空字符串");
  }
  const features: FeatureCatalogArtifact["features"] = {};
  for (const key of INSTANCE_FEATURE_KEYS) {
    features[key] = { tier: INSTANCE_FEATURE_CATALOG[key].tier };
  }
  return { catalogVersion, features };
}

/** Deterministic serialization (sorted keys, trailing newline) for the artifact file. */
export function renderFeatureCatalogArtifact(catalogVersion: string): string {
  return `${JSON.stringify(buildFeatureCatalogArtifact(catalogVersion), null, 2)}\n`;
}
