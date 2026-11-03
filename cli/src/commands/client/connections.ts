import { Command } from "commander";
import {
  CONNECTION_INTENT_AGENT_GUIDANCE,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
} from "@paperclipai/shared";

interface RuntimeConnectionOptions {
  json?: boolean;
}

async function callRuntimeConnectionTool(
  endpointEnv: "PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL" | "PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL",
  body: unknown,
) {
  const endpoint = process.env[endpointEnv]?.trim();
  const token = process.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Error("此命令需要处于活动心跳运行提供的运行时连接环境中");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `运行时连接请求失败，状态码：${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

function writeResult(value: unknown, options: RuntimeConnectionOptions) {
  process.stdout.write(`${JSON.stringify(value, null, options.json ? 2 : 0)}\n`);
}

export function registerConnectionIntentCommands(program: Command) {
  const connections = program
    .command("connections")
    .description("在活动心跳运行中搜索或申请连接")
    .addHelpText("after", `\n${CONNECTION_INTENT_AGENT_GUIDANCE}\n`);

  connections
    .command("search")
    .argument("[query]", "服务名称或能力")
    .option("--json", "输出格式化 JSON")
    .action(async (query: string | undefined, options: RuntimeConnectionOptions) => {
      const input = connectionsSearchInputSchema.parse({ query: query ?? "" });
      writeResult(await callRuntimeConnectionTool(
        "PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL",
        input,
      ), options);
    });

  connections
    .command("request")
    .argument("<service>", "可连接服务的标识")
    .option("--json", "输出格式化 JSON")
    .action(async (service: string, options: RuntimeConnectionOptions) => {
      const input = connectionRequestInputSchema.parse({ service });
      writeResult(await callRuntimeConnectionTool(
        "PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL",
        input,
      ), options);
    });
}
