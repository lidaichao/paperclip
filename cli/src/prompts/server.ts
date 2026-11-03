import * as p from "@clack/prompts";
import { isLoopbackHost, type BindMode } from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { parseHostnameCsv } from "../config/hostnames.js";
import { buildCustomServerConfig, buildPresetServerConfig, inferConfiguredBind } from "../config/server-bind.js";

const TAILNET_BIND_WARNING =
  "设置时未检测到 Tailscale 地址。Alice 将继续使用本机回环地址，直到 Tailscale 可用或已设置 PAPERCLIP_TAILNET_BIND_HOST。";

function cancelled(): never {
  p.cancel("已取消设置。");
  process.exit(0);
}

export async function promptServer(opts?: {
  currentServer?: Partial<ServerConfig>;
  currentAuth?: Partial<AuthConfig>;
}): Promise<{ server: ServerConfig; auth: AuthConfig }> {
  const currentServer = opts?.currentServer;
  const currentAuth = opts?.currentAuth;
  const currentBind = inferConfiguredBind(currentServer);

  const bindSelection = await p.select({
    message: "访问范围",
    options: [
      {
        value: "loopback" as const,
        label: "受信任的本机访问",
        hint: "首次运行推荐：仅限本机，无需登录",
      },
      {
        value: "lan" as const,
        label: "私有网络",
        hint: "适用于局域网、VPN 或旧版 --tailscale-auth 访问方式",
      },
      {
        value: "tailnet" as const,
        label: "Tailnet",
        hint: "使用本机检测到的 Tailscale 地址进行私有认证访问",
      },
      {
        value: "custom" as const,
        label: "自定义",
        hint: "手动选择认证模式、开放范围和主机",
      },
    ],
    initialValue: currentBind,
  });

  if (p.isCancel(bindSelection)) cancelled();
  const bind = bindSelection as BindMode;

  const portDefault = String(currentServer?.port ?? 3100);
  const portStr = await p.text({
    message: "服务器端口",
    defaultValue: portDefault,
    placeholder: "3100",
    validate: (val) => {
      // Clack validates the raw input before applying defaultValue, so an
      // Enter press hands the validator an empty string. Validate the value
      // that will actually be submitted — the typed input, or the default.
      const n = Number(val || portDefault);
      if (isNaN(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
        return "必须填写 1 到 65535 之间的整数";
      }
    },
  });

  if (p.isCancel(portStr)) cancelled();
  const port = Number(portStr) || 3100;
  const serveUi = currentServer?.serveUi ?? true;

  if (bind === "loopback") {
    return buildPresetServerConfig("loopback", {
      port,
      allowedHostnames: [],
      serveUi,
    });
  }

  if (bind === "lan" || bind === "tailnet") {
    const allowedHostnamesInput = await p.text({
      message: "允许的私有主机名（用逗号分隔，可选）",
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder:
        bind === "tailnet"
          ? "your-machine.tailnet.ts.net"
          : "dotta-macbook-pro, host.docker.internal",
      validate: (val) => {
        try {
          parseHostnameCsv(val ?? "");
          return;
        } catch (err) {
          return err instanceof Error ? err.message : "主机名列表无效";
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) cancelled();

    const preset = buildPresetServerConfig(bind, {
      port,
      allowedHostnames: parseHostnameCsv(allowedHostnamesInput),
      serveUi,
    });
    if (bind === "tailnet" && isLoopbackHost(preset.server.host)) {
      p.log.warn(TAILNET_BIND_WARNING);
    }
    return preset;
  }

  const deploymentModeSelection = await p.select({
    message: "认证模式",
    options: [
      {
        value: "local_trusted",
        label: "受信任的本机模式",
        hint: "无需登录；仅限回环地址或同等可信的访问环境",
      },
      {
        value: "authenticated",
        label: "登录认证",
        hint: "需要登录；支持私有网络和公网部署",
      },
    ],
    initialValue: currentServer?.deploymentMode ?? "authenticated",
  });

  if (p.isCancel(deploymentModeSelection)) cancelled();
  const deploymentMode = deploymentModeSelection as ServerConfig["deploymentMode"];

  let exposure: ServerConfig["exposure"] = "private";
  if (deploymentMode === "authenticated") {
    const exposureSelection = await p.select({
      message: "开放范围",
      options: [
        {
          value: "private",
          label: "私有网络",
          hint: "仅允许私有访问，并自动处理网址",
        },
        {
          value: "public",
          label: "公网",
          hint: "面向互联网部署，必须明确配置公网网址",
        },
      ],
      initialValue: currentServer?.exposure ?? "private",
    });
    if (p.isCancel(exposureSelection)) cancelled();
    exposure = exposureSelection as ServerConfig["exposure"];
  }

  const defaultHost =
    currentServer?.customBindHost ??
    currentServer?.host ??
    (deploymentMode === "local_trusted" ? "127.0.0.1" : "0.0.0.0");
  const host = await p.text({
    message: "绑定主机",
    defaultValue: defaultHost,
    placeholder: defaultHost,
    validate: (val) => {
      const candidate = (val || defaultHost).trim();
      if (!candidate) return "必须填写主机";
      if (deploymentMode === "local_trusted" && !isLoopbackHost(candidate)) {
        return "受信任的本机模式必须使用 127.0.0.1 等回环地址";
      }
    },
  });

  if (p.isCancel(host)) cancelled();

  let allowedHostnames: string[] = [];
  if (deploymentMode === "authenticated" && exposure === "private") {
    const allowedHostnamesInput = await p.text({
      message: "允许的私有主机名（用逗号分隔，可选）",
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder: "dotta-macbook-pro, your-host.tailnet.ts.net",
      validate: (val) => {
        try {
          parseHostnameCsv(val ?? "");
          return;
        } catch (err) {
          return err instanceof Error ? err.message : "主机名列表无效";
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) cancelled();
    allowedHostnames = parseHostnameCsv(allowedHostnamesInput);
  }

  let publicBaseUrl: string | undefined;
  if (deploymentMode === "authenticated" && exposure === "public") {
    const publicBaseUrlDefault = currentAuth?.publicBaseUrl ?? "";
    const urlInput = await p.text({
      message: "公网基础网址",
      defaultValue: publicBaseUrlDefault,
      placeholder: "https://alice.example.com",
      validate: (val) => {
        const candidate = (val || publicBaseUrlDefault).trim();
        if (!candidate) return "公网部署必须填写公网基础网址";
        try {
          const url = new URL(candidate);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "网址必须以 http:// 或 https:// 开头";
          }
          return;
        } catch {
          return "请输入有效网址";
        }
      },
    });
    if (p.isCancel(urlInput)) cancelled();
    publicBaseUrl = urlInput.trim().replace(/\/+$/, "");
  }

  return buildCustomServerConfig({
    deploymentMode,
    exposure,
    host: host.trim(),
    port,
    allowedHostnames,
    serveUi,
    publicBaseUrl,
  });
}
