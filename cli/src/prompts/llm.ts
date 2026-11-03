import * as p from "@clack/prompts";
import type { LlmConfig } from "../config/schema.js";

export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: "现在配置大模型服务商吗？",
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: "大模型服务商",
    options: [
      { value: "claude" as const, label: "Claude（Anthropic）" },
      { value: "openai" as const, label: "OpenAI" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const apiKey = await p.password({
    message: `${provider === "claude" ? "Anthropic" : "OpenAI"} API 密钥`,
    validate: (val) => {
      if (!val) return "必须填写 API 密钥";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  return { provider, apiKey };
}
