import * as p from "@clack/prompts";
import pc from "picocolors";
import { normalizeHostnameInput } from "../config/hostnames.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

export async function addAllowedHostname(host: string, opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`未在 ${configPath} 找到配置，请先运行 ${pc.cyan("paperclip onboard")}。`);
    return;
  }

  const normalized = normalizeHostnameInput(host);
  const current = new Set((config.server.allowedHostnames ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const existed = current.has(normalized);
  current.add(normalized);

  config.server.allowedHostnames = Array.from(current).sort();
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (existed) {
    p.log.info(`主机名 ${pc.cyan(normalized)} 已在允许列表中。`);
  } else {
    p.log.success(`已添加允许的主机名：${pc.cyan(normalized)}`);
    p.log.message(
      pc.dim("请重启 Alice 服务器以使更改生效。"),
    );
  }

  if (!(config.server.deploymentMode === "authenticated" && config.server.exposure === "private")) {
    p.log.message(
      pc.dim("注意：允许的主机名仅在认证/私有模式下生效。"),
    );
  }
}

