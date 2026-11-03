import fs from "node:fs";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

export function logCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const logDir = resolveRuntimeLikePath(config.logging.logDir, configPath);
  const reportedDir = logDir;

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(reportedDir, { recursive: true });
  }

  try {
    fs.accessSync(reportedDir, fs.constants.W_OK);
    return {
      name: "日志目录",
      status: "pass",
      message: `日志目录可写：${reportedDir}`,
    };
  } catch {
    return {
      name: "日志目录",
      status: "fail",
      message: `日志目录不可写：${logDir}`,
      canRepair: false,
      repairHint: "请检查日志目录的文件权限",
    };
  }
}
