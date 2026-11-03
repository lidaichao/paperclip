import { readConfig, configExists, resolveConfigPath } from "../config/store.js";
import type { CheckResult } from "./index.js";

export function configCheck(configPath?: string): CheckResult {
  const filePath = resolveConfigPath(configPath);

  if (!configExists(configPath)) {
    return {
      name: "配置文件",
      status: "fail",
      message: `在 ${filePath} 未找到配置文件`,
      canRepair: false,
      repairHint: "请运行 `paperclipai onboard` 创建配置文件",
    };
  }

  try {
    readConfig(configPath);
    return {
      name: "配置文件",
      status: "pass",
      message: `配置有效：${filePath}`,
    };
  } catch (err) {
    return {
      name: "配置文件",
      status: "fail",
      message: `配置无效：${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "请运行 `paperclipai configure --section database`（或运行 `paperclipai onboard` 重新创建）",
    };
  }
}
