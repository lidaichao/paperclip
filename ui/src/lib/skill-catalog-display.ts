import { i18n } from "../i18n";

const CATALOG_DESCRIPTIONS_ZH: Record<string, string> = {
  "paperclipai/bundled/docs/doc-maintenance": "让项目文档与近期代码和功能变更保持一致：发现内容漂移、更新受影响页面，并补充与发布相关的说明，不重写未变化的部分。",
  "paperclipai/bundled/paperclip-operations/issue-triage": "梳理 Alice 收件箱中停滞、受阻、待审或已分配但无进展的任务，并为每项任务确定一个明确动作：恢复、改派、解除阻塞、升级或关闭。",
  "paperclipai/bundled/paperclip-operations/reflection-coach": "复盘其他智能体近期的执行记录，提出最小且可长期保留的指令、技能或工具说明改进；用于有证据的辅导建议，不直接热更新运行配置。",
  "paperclipai/bundled/paperclip-operations/status-card-query": "创建和维护由智能体撰写的 Alice 状态卡片，或把自然语言关注点编译为有边界的搜索查询，并由指定的总结智能体写入第一版摘要。",
  "paperclipai/bundled/paperclip-operations/summarize-status": "为 Alice 摘要栏撰写简短、口语化的状态摘要：先列出读者当前需要执行的 1～3 个具体动作，再用简明语言说明状态，并在处理过程中持续更新进展。",
  "paperclipai/bundled/paperclip-operations/task-planning": "把 Alice 任务或请求整理成结构化实施计划，包括子任务图、阻塞关系、负责人和验收标准，并保存为任务的计划文档。",
  "paperclipai/bundled/product/paperclip-capsules": "生成、实现或评审 Alice 胶囊视觉，包括智能体胶囊、心跳状态胶囊、头像标识、胶囊素材库和品牌使用检查。",
  "paperclipai/bundled/product/wireframe": "以 SVG 或查看器页面制作低保真黑白界面线框图，适用于页面草图、布局方案、低保真原型和线框图发布。",
  "paperclipai/bundled/quality/qa-acceptance": "为功能变更制定质量验收标准和人工验证方案，覆盖主流程、边界场景、错误状态、性能限制以及明确的通过/失败证据。",
  "paperclipai/bundled/software-development/github-pr-workflow": "从功能分支准备 GitHub 拉取请求，包括分支整理、提交结构、标题与正文、验证说明、界面截图和评审意见回复。",
  "paperclipai/optional/browser/agent-browser": "驱动真实浏览器检查网页或应用：导航、截图、读取控制台与网络信息、填写简单表单；用于验证任务，不用于无人值守自动化。",
  "paperclipai/optional/content/release-announcement": "撰写发布公告、更新日志、博客、应用内通知或社交媒体内容：突出用户影响、明确受众，并包含升级或迁移步骤，避免空话。",
  "paperclipai/optional/content/simplified-english": "使用 ASD-STE100 简化技术英语撰写面向用户的评论、计划和文档：句子简短明确、使用批准词汇且一词一义，帮助读者一次读懂。",
  "paperclipai/optional/finance/ramp": "在 Alice 中获取并遵循 Ramp 发布的智能体工作手册；涉及支出、公司注册、卡片、账户设置和其他财务操作时必须经过审批。",
  "paperclipai/optional/product/design-critique": "给出结构化产品设计评审，覆盖用户目标、信息层级、操作提示、错误状态、无障碍和一致性，并明确修改内容、顺序和原因。",
  "paperclipai/optional/research/last30days": "研究最近 30 天人们对任意主题的真实讨论，汇总 Reddit、X、YouTube、TikTok、Hacker News、Polymarket、GitHub 和网页内容及互动数据。",
  "paperclipai/optional/software-development/prepare-mcp-integration": "通过有引用的调研、内容拉取请求、精确版本人工审批，以及每个获批连接对应的一项受治理 Alice 连接器拉取请求，准备 MCP 或供应商集成。",
};

export function localizedCatalogSkillDescription(
  key: string,
  name: string,
  description: string | null | undefined,
  kind: "bundled" | "optional" | null | undefined,
): string | null {
  const fallback = description ?? null;
  if (i18n.language !== "zh-CN" || !kind) return fallback;
  return CATALOG_DESCRIPTIONS_ZH[key]
    ?? (kind === "bundled"
      ? `Alice 内置技能“${name}”。打开详情可查看完整说明。`
      : `可选技能“${name}”。打开详情可查看完整说明。`);
}

export function localizedSkillSourceLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  let result = label.replace(/Paperclip/gi, "Alice");
  if (i18n.language === "zh-CN") {
    result = result
      .replace(/\bbundled\b/gi, "内置")
      .replace(/\bcatalog\b/gi, "目录")
      .replace(/\bmanaged\b/gi, "托管")
      .replace(/\boptional\b/gi, "可选");
  }
  return result;
}
