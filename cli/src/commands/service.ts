import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../config/home.js";
import { detectServiceManager, type ServiceManager, type ServiceStatus } from "../services/service-manager.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";

type CommonOptions = { instance?: string; json?: boolean };
type HealthResult = { ok: boolean; serverVersion: string | null; error?: string };

function output(value: unknown, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function resolveManager(opts: CommonOptions): Promise<ServiceManager | null> {
  const detection = await detectServiceManager({ instanceId: opts.instance });
  if (detection.supported) return detection.manager;
  output({ supported: false, message: detection.reason }, opts.json);
  return null;
}

function healthUrl(instanceId: string): string {
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  const config = readConfig(resolveConfigPath());
  return buildLocalHealthUrl(config?.server.host, config?.server.port ?? 3100);
}

async function probeHealth(instanceId: string): Promise<HealthResult> {
  try {
    const response = await fetch(healthUrl(instanceId), { signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as { status?: unknown; serverVersion?: unknown; version?: unknown };
    return { ok: response.ok && body.status === "ok", serverVersion: typeof body.serverVersion === "string" ? body.serverVersion : typeof body.version === "string" ? body.version : null };
  } catch (error) {
    return { ok: false, serverVersion: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForHealth(instanceId: string, expectedVersion: string | null, timeoutMs = 60_000): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { ok: false, serverVersion: null };
  while (Date.now() < deadline) {
    last = await probeHealth(instanceId);
    if (last.ok && (!expectedVersion || last.serverVersion === expectedVersion)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Alice 服务未恢复健康${expectedVersion ? `（预期版本 ${expectedVersion}）` : ""}：${last.error ?? `报告版本 ${last.serverVersion ?? "未知"}`}`);
}

export function resolveRestartExpectedVersion(expectedVersion: string | null | undefined): string | null {
  return expectedVersion ?? null;
}

export async function withHotRestartLock<T>(
  instanceId: string,
  callback: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number; isProcessAlive?: (pid: number) => boolean } = {},
): Promise<T> {
  const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
  const lockPath = path.join(instanceRoot, "hot-restart.lock");
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollMs = options.pollMs ?? 100;
  const isProcessAlive = options.isProcessAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  });
  await fs.mkdir(instanceRoot, { recursive: true });

  while (true) {
    try {
      await fs.writeFile(lockPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existingToken = (await fs.readFile(lockPath, "utf8")).trim();
        const ownerPid = Number.parseInt(existingToken.split(":", 1)[0] ?? "", 10);
        if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
          if ((await fs.readFile(lockPath, "utf8")).trim() === existingToken) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `实例 ${instanceId} 的另一次重启仍在进行。` +
          `如果当前没有重启进程，请删除过期锁文件 ${lockPath} 后重试。`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await callback();
  } finally {
    try {
      if ((await fs.readFile(lockPath, "utf8")).trim() === token) {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function writeHotRestartIntent(status: ServiceStatus, instanceId: string, drainRequired: boolean): Promise<{ requestedAt: string }> {
  if (!status.pid) throw new Error(`无法重启 ${status.serviceName}：监控程序未报告服务进程编号。`);
  const health = await probeHealth(instanceId);
  const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
  const requestedAt = new Date().toISOString();
  await fs.mkdir(instanceRoot, { recursive: true });
  await fs.rm(path.join(instanceRoot, "hot-restart-report.json"), { force: true });
  await fs.writeFile(path.join(instanceRoot, "hot-restart-intent.json"), `${JSON.stringify({
    version: 1,
    requestedAt,
    previousServerPid: status.pid,
    previousServerVersion: health.serverVersion,
    drainRequired,
    requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
  }, null, 2)}\n`, "utf8");
  return { requestedAt };
}

async function waitForRestartReport(instanceId: string, requestedAt: string, timeoutMs = 10_000): Promise<unknown | null> {
  const reportPath = path.join(resolvePaperclipInstanceRoot(instanceId), "hot-restart-report.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as { requestedAt?: unknown };
      if (report.requestedAt === requestedAt) return report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function restartManagedService(input: { instanceId?: string; expectedVersion?: string | null; waitForDrain?: boolean } = {}): Promise<{ status: ServiceStatus; health: HealthResult; report: unknown | null }> {
  const instanceId = resolvePaperclipInstanceId(input.instanceId);
  return withHotRestartLock(instanceId, async () => {
    const detection = await detectServiceManager({ instanceId });
    if (!detection.supported) throw new Error(detection.reason);
    const before = await detection.manager.status();
    const intent = await writeHotRestartIntent(before, instanceId, input.waitForDrain ?? false);
    await detection.manager.restart();
    const health = await waitForHealth(instanceId, resolveRestartExpectedVersion(input.expectedVersion));
    return { status: await detection.manager.status(), health, report: await waitForRestartReport(instanceId, intent.requestedAt) };
  });
}

export function registerServiceCommands(program: Command): void {
  const service = program.command("service").description("将 Alice 作为后台服务进行管理");
  const common = (command: Command) => command.option("-i, --instance <id>", "本地实例编号（默认：default）").option("--json", "输出便于程序读取的 JSON", false);

  common(service.command("install").description("安装并注册后台服务"))
    .option("--no-start-now", "安装后暂不启动")
    .option("--no-start-on-login", "安装后不启用登录时启动")
    .option("--enable-linger", "允许 systemd 在没有活跃登录会话时启动", false)
    .action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      const result = await manager.install({ startNow: opts.startNow, startOnLogin: opts.startOnLogin });
      let lingerEnabled = false;
      if (manager.enableLinger) {
        let consent = opts.enableLinger === true;
        if (!consent && process.stdin.isTTY && process.stdout.isTTY) {
          consent = await p.confirm({ message: "是否允许 Alice 在没有活跃登录会话时运行？这会为当前用户执行 ‘loginctl enable-linger’，并可能请求系统授权。", initialValue: false }) === true;
        }
        if (consent) { await manager.enableLinger(); lingerEnabled = true; }
      }
      output({ installed: true, changed: result.changed, platform: manager.platform, serviceName: manager.serviceName, definitionPath: manager.definitionPath, lingerEnabled }, opts.json);
    });

  common(service.command("uninstall").description("停止、禁用并移除后台服务")).action(async (opts) => {
    const manager = await resolveManager(opts); if (!manager) return;
    await manager.uninstall();
    const status = await manager.status();
    if (status.installed || status.active) throw new Error(`卸载后 ${manager.serviceName} 仍处于已加载状态。`);
    output({ uninstalled: true, serviceName: manager.serviceName }, opts.json);
  });

  for (const verb of ["start", "stop"] as const) {
    common(service.command(verb).description(`${verb === "start" ? "启动" : "停止"}后台服务`)).action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      await manager[verb]();
      output(await manager.status(), opts.json);
    });
  }

  common(service.command("restart").description("热重启服务，并保留正在执行的智能体任务"))
    .option("--wait", "等待正在执行的任务结束，而不是接管它们", false)
    .option("--expected-version <version>", "要求重启后的服务报告此版本")
    .action(async (opts) => output(await restartManagedService({ instanceId: opts.instance, expectedVersion: opts.expectedVersion, waitForDrain: opts.wait }), opts.json));

  common(service.command("status").description("显示监控程序与健康状态")).action(async (opts) => {
    const manager = await resolveManager(opts); if (!manager) return;
    const instanceId = resolvePaperclipInstanceId(opts.instance);
    output({ ...await manager.status(), health: await probeHealth(instanceId) }, opts.json);
  });

  common(service.command("logs").description("显示服务日志"))
    .option("-f, --follow", "持续显示新增日志", false)
    .option("-n, --lines <count>", "显示最近的日志行数", "100")
    .action(async (opts) => {
      const manager = await resolveManager(opts); if (!manager) return;
      const lines = Number.parseInt(opts.lines, 10);
      if (!Number.isInteger(lines) || lines < 1) throw new Error("--lines 必须是正整数。");
      await manager.logs(opts.follow, lines);
    });
}
