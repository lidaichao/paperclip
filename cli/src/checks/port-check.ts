import type { PaperclipConfig } from "../config/schema.js";
import { checkPort } from "../utils/net.js";
import type { CheckResult } from "./index.js";

export async function portCheck(config: PaperclipConfig): Promise<CheckResult> {
  const port = config.server.port;
  const result = await checkPort(port);

  if (result.available) {
    return {
      name: "服务端口",
      status: "pass",
      message: `端口 ${port} 可用`,
    };
  }

  return {
    name: "服务端口",
    status: "warn",
    message: result.error ?? `端口 ${port} 不可用`,
    canRepair: false,
    repairHint: `请使用以下命令检查占用端口 ${port} 的程序：lsof -i :${port}`,
  };
}
