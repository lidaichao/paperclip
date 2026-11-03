import { inferBindModeFromHost } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function deploymentAuthCheck(config: PaperclipConfig): CheckResult {
  const mode = config.server.deploymentMode;
  const exposure = config.server.exposure;
  const auth = config.auth;
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);

  if (mode === "local_trusted") {
    if (bind !== "loopback") {
      return {
        name: "部署/认证模式",
        status: "fail",
        message: `local_trusted 要求绑定本机回环地址（当前为 ${bind}）`,
        canRepair: false,
        repairHint: "请运行 `paperclipai configure --section server`，并选择“本机受信任 / 仅本机回环可访问”",
      };
    }
    return {
      name: "部署/认证模式",
      status: "pass",
      message: "local_trusted 模式已配置为仅允许本机回环访问",
    };
  }

  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() ??
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!secret) {
    return {
      name: "部署/认证模式",
      status: "fail",
      message: "authenticated 模式需要 BETTER_AUTH_SECRET（或 PAPERCLIP_AGENT_JWT_SECRET）",
      canRepair: false,
      repairHint: "启动 Alice 前请设置 BETTER_AUTH_SECRET",
    };
  }

  if (auth.baseUrlMode === "explicit" && !auth.publicBaseUrl) {
    return {
      name: "部署/认证模式",
      status: "fail",
      message: "auth.baseUrlMode=explicit 时必须设置 auth.publicBaseUrl",
      canRepair: false,
      repairHint: "请运行 `paperclipai configure --section server` 并提供基础地址",
    };
  }

  if (exposure === "public") {
    if (auth.baseUrlMode !== "explicit" || !auth.publicBaseUrl) {
      return {
        name: "部署/认证模式",
        status: "fail",
        message: "authenticated/public 模式要求明确设置 auth.publicBaseUrl",
        canRepair: false,
        repairHint: "请运行 `paperclipai configure --section server` 并选择公开访问范围",
      };
    }
    try {
      const url = new URL(auth.publicBaseUrl);
      if (url.protocol !== "https:") {
        return {
          name: "部署/认证模式",
          status: "warn",
          message: "公开访问应使用以 https:// 开头的 auth.publicBaseUrl",
          canRepair: false,
          repairHint: "生产环境请使用 HTTPS，以保护会话 Cookie",
        };
      }
    } catch {
      return {
        name: "部署/认证模式",
        status: "fail",
        message: "auth.publicBaseUrl 不是有效网址",
        canRepair: false,
        repairHint: "请运行 `paperclipai configure --section server` 并提供有效网址",
      };
    }
  }

  return {
    name: "部署/认证模式",
    status: "pass",
    message: `模式 ${mode}/${exposure}，绑定 ${bind}，认证地址模式 ${auth.baseUrlMode}`,
  };
}
