import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { listServerAdapters } from "../adapters/index.js";
import { hermesGatewayAgentConfigurationDoc } from "../adapters/hermes-gateway-doc.js";
import { agentService } from "../services/agents.js";

const pluginOnlyAdapterDocs = new Map<string, string>([
  ["hermes_gateway", hermesGatewayAgentConfigurationDoc],
]);

function hasCreatePermission(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export function llmRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);

  async function assertCanRead(req: Request) {
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("需要看板用户或获准智能体身份验证");
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || !hasCreatePermission(actorAgent)) {
      throw forbidden("缺少读取智能体配置映射的权限");
    }
  }

  router.get("/llms/agent-configuration.txt", async (req, res) => {
    await assertCanRead(req);
    const adapters = listServerAdapters().sort((a, b) => a.type.localeCompare(b.type));
    const lines = [
      "# Alice 智能体配置索引",
      "",
      "已安装的适配器：",
      ...adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
      "",
      "仅插件适配器文档：",
      ...Array.from(pluginOnlyAdapterDocs.keys())
        .filter(
          (adapterType) => !adapters.some((adapter) => adapter.type === adapterType),
        )
        .map(
          (adapterType) => `- ${adapterType}: /llms/agent-configuration/${adapterType}.txt`,
        ),
      "",
      "相关 API 端点：",
      "- GET /api/companies/:companyId/agent-configurations",
      "- GET /api/agents/:id/configuration",
      "- POST /api/companies/:companyId/agent-hires",
      "",
      "智能体身份参考：",
      "- GET /llms/agent-icons.txt",
      "",
      "说明：",
      "- 配置读取 API 会遮蔽敏感值。",
      "- 根据公司设置，新录用的智能体可能以 pending_approval 状态创建。",
      "- 使用 paperclip-create-agent 技能完成端到端录用：适配器映射、配置比较、指令来源选择、图标选择、desiredSkills、sourceIssueId/sourceIssueIds 和审批跟进。",
      "- 新录用智能体默认不启用定时心跳。除非角色确实需要定时工作或用户明确要求，否则请保持 runtimeConfig.heartbeat.enabled 为 false。",
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-icons.txt", async (req, res) => {
    await assertCanRead(req);
    const lines = [
      "# Alice 智能体图标名称",
      "",
      "将录用或创建载荷中的 `icon` 字段设置为以下值之一：",
      ...AGENT_ICON_NAMES.map((name) => `- ${name}`),
      "",
      "示例：",
      '{ "name": "SearchOps", "role": "researcher", "icon": "search" }',
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-configuration/:adapterType.txt", async (req, res) => {
    await assertCanRead(req);
    const adapterType = req.params.adapterType as string;
    const adapter = listServerAdapters().find((entry) => entry.type === adapterType);
    if (!adapter) {
      const pluginOnlyDoc = pluginOnlyAdapterDocs.get(adapterType);
      if (pluginOnlyDoc) {
        res.type("text/plain").send(pluginOnlyDoc);
        return;
      }
      res.status(404).type("text/plain").send(`未知适配器类型：${adapterType}`);
      return;
    }
    res
      .type("text/plain")
      .send(
        adapter.agentConfigurationDoc ??
          `# ${adapterType} 智能体配置\n\n尚未注册此适配器的专用文档。`,
      );
  });

  return router;
}
