import {
  ensureAgentJwtSecret,
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import type { CheckResult } from "./index.js";

export function agentJwtSecretCheck(configPath?: string): CheckResult {
  if (readAgentJwtSecretFromEnv(configPath)) {
    return {
      name: "智能体 JWT 密钥",
      status: "pass",
      message: "环境变量中已设置 PAPERCLIP_AGENT_JWT_SECRET",
    };
  }

  const envPath = resolveAgentJwtEnvFile(configPath);
  const fileSecret = readAgentJwtSecretFromEnvFile(envPath);

  if (fileSecret) {
    return {
      name: "智能体 JWT 密钥",
      status: "warn",
      message: `${envPath} 中存在 PAPERCLIP_AGENT_JWT_SECRET，但尚未加载到环境变量`,
      repairHint: `启动 Alice 服务前，请在终端中设置 ${envPath} 里的值`,
    };
  }

  return {
    name: "智能体 JWT 密钥",
    status: "fail",
    message: `环境变量和 ${envPath} 中均缺少 PAPERCLIP_AGENT_JWT_SECRET`,
    canRepair: true,
    repair: () => {
      ensureAgentJwtSecret(configPath);
    },
    repairHint: `请使用 --repair 运行，以创建包含 PAPERCLIP_AGENT_JWT_SECRET 的 ${envPath}`,
  };
}
