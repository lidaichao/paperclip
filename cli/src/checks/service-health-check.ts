import fs from "node:fs/promises";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { readInstallManifest, resolveInstallStorePaths } from "../install-store.js";
import {
  detectServiceManager,
  isExecutableFile,
  resolveServiceShimPath,
  type ServiceManagerDetection,
} from "../services/service-manager.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";
import type { CheckResult } from "./index.js";

type HealthResult = { ok: boolean; version: string | null; error?: string };
type ServiceCheckDependencies = {
  detect: (instanceId: string) => Promise<ServiceManagerDetection>;
  probe: (config: PaperclipConfig) => Promise<HealthResult>;
  shimPresent: (executablePath: string) => Promise<boolean>;
};

async function probeHealth(config: PaperclipConfig): Promise<HealthResult> {
  try {
    const response = await fetch(buildLocalHealthUrl(config.server.host, config.server.port), {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as {
      status?: unknown;
      serverVersion?: unknown;
      version?: unknown;
    };
    const version = typeof body.serverVersion === "string"
      ? body.serverVersion
      : typeof body.version === "string"
        ? body.version
        : null;
    return { ok: response.ok && body.status === "ok", version };
  } catch (error) {
    return { ok: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function serviceHealthChecks(
  config: PaperclipConfig,
  dependencies: Partial<ServiceCheckDependencies> = {},
): Promise<CheckResult[]> {
  if (process.env.PAPERCLIP_SERVICE_MANAGED === "1") return [];

  const deps: ServiceCheckDependencies = {
    detect: (instanceId) => detectServiceManager({ instanceId }),
    probe: probeHealth,
    shimPresent: (executablePath) => isExecutableFile(executablePath),
    ...dependencies,
  };
  const instanceId = resolvePaperclipInstanceId();
  const detection = await deps.detect(instanceId);
  if (!detection.supported) {
    return [{ name: "后台服务", status: "pass", message: detection.reason }];
  }

  const manager = detection.manager;
  const status = await manager.status();
  if (!status.installed) {
    return [
      {
        name: "后台服务",
        status: "pass",
        message: `实例 ${instanceId} 未安装后台服务（可选）`,
      },
    ];
  }

  const results: CheckResult[] = [];
  let definitionCurrent = false;
  try {
    definitionCurrent = (await fs.readFile(manager.definitionPath, "utf8")) === manager.renderDefinition();
  } catch {
    definitionCurrent = false;
  }
  results.push(
    definitionCurrent
      ? { name: "服务定义", status: "pass", message: manager.definitionPath }
      : {
          name: "服务定义",
          status: "fail",
          message: `${manager.definitionPath} 中的服务定义缺失或已偏离`,
          repairHint: "请运行 `paperclipai service install` 重新生成服务定义",
        },
  );

  const health = await deps.probe(config);
  // The installed definition is the truth about what the service executes;
  // fall back to the environment-derived path only when it is unreadable.
  const serviceExecutable = (await manager.installedExecutablePath()) ?? resolveServiceShimPath();
  const shimPresent = status.active ? true : await deps.shimPresent(serviceExecutable);
  results.push(
    status.active
      ? { name: "服务运行状态", status: "pass", message: `${status.serviceName} 正在运行` }
      : !shimPresent
        ? {
            name: "服务运行状态",
            status: "fail",
            message: `${status.serviceName} 无法启动：${serviceExecutable} 不存在可执行文件`,
            repairHint:
              path.resolve(serviceExecutable) === path.resolve(resolveInstallStorePaths().shimPath)
                ? "请运行 `paperclipai install` 恢复托管程序和命令入口，然后运行 `paperclipai service start`"
                : `请恢复 ${serviceExecutable} 中的可执行文件，或取消设置 PAPERCLIP_SHIM_PATH，然后依次运行 \`paperclipai install\` 和 \`paperclipai service install\`，使服务重新指向托管命令入口`,
          }
        : health.ok
          ? {
              name: "服务运行状态",
              status: "fail",
              message: `${status.serviceName} 未运行，但配置的端口正由另一个 Alice 进程提供服务`,
              repairHint: "请运行 `paperclipai service start`，或先停止冲突的前台进程",
            }
          : {
              name: "服务运行状态",
              status: "fail",
              message: `${status.serviceName} 状态为 ${status.detail ?? "未运行"}`,
              repairHint: "请运行 `paperclipai service start`；如果服务无法持续运行，请检查 `paperclipai service logs`",
            },
  );

  let expectedVersion: string | null = null;
  try {
    expectedVersion = readInstallManifest()?.version ?? null;
  } catch {}
  results.push(
    !health.ok
      ? {
          name: "服务健康状态",
          status: "fail",
          message: health.error ?? "健康检查端点未报告正常",
          repairHint: "请检查 `paperclipai service status` 和 `paperclipai service logs`",
        }
      : expectedVersion && health.version !== expectedVersion
        ? {
            name: "服务版本",
            status: "fail",
            message: `当前运行 ${health.version ?? "未知版本"}；托管安装版本为 ${expectedVersion}`,
            repairHint: "请运行 `paperclipai service restart --expected-version " + expectedVersion + "`",
          }
        : status.active
          ? {
              name: "服务健康状态",
              status: "pass",
              message: `健康${health.version ? `，版本 ${health.version}` : ""}`,
            }
          : {
              name: "服务健康状态",
              status: "warn",
              message: `配置的端口返回健康状态${health.version ? `（版本 ${health.version}）` : ""}，但响应并非来自 ${status.serviceName}——该服务未运行`,
            },
  );

  if (status.enabled && status.linger === false) {
    results.push({
      name: "服务注销后驻留",
      status: "warn",
      message: "已启用登录时启动，但 systemd 用户驻留功能已关闭",
      repairHint: "如果服务必须在注销后继续运行，请重新运行 `paperclipai service install --enable-linger`",
    });
  }

  return results;
}
