import path from "node:path";
import { existsSync } from "node:fs";
import { Command, Option } from "commander";
import {
  scaffoldPluginProject,
  shellQuote,
  type ScaffoldPluginOptions,
} from "../../../../packages/plugins/create-paperclip-plugin/src/index.js";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// ---------------------------------------------------------------------------
// Types mirroring server-side shapes
// ---------------------------------------------------------------------------

interface PluginRecord {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  displayName?: string;
  lastError?: string | null;
  installedAt: string;
  updatedAt: string;
}

/** Subset of `GET /api/health` we surface as install/target diagnostics. */
interface TargetHealth {
  status?: string;
  version?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
}

/** Result of probing the Paperclip instance the CLI is about to talk to. */
interface TargetDiagnostics {
  apiBase: string;
  reachable: boolean;
  health?: TargetHealth;
  error?: string;
}


// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface PluginListOptions extends BaseClientOptions {
  status?: string;
}

interface PluginInstallOptions extends BaseClientOptions {
  local?: boolean;
  version?: string;
  /** When false, skip the pre-install target-host health probe. Defaults true. */
  verifyTarget?: boolean;
}

interface PluginInstallRequest {
  packageName: string;
  version?: string;
  isLocalPath: boolean;
}

interface PluginUninstallOptions extends BaseClientOptions {
  force?: boolean;
}

interface PluginInitOptions extends BaseClientOptions {
  output?: string;
  template?: ScaffoldPluginOptions["template"];
  category?: ScaffoldPluginOptions["category"];
  displayName?: string;
  description?: string;
  author?: string;
  sdkPath?: string;
}

interface PluginJsonOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface PluginStreamOptions extends BaseClientOptions {
  durationMs?: string;
}

interface PluginCompanyOptions extends PluginJsonOptions {
  companyId?: string;
}

function requireCompanyId(ctx: { companyId?: string }): string {
  if (!ctx.companyId) {
    throw new Error(
      "必须提供公司 ID。请传入 --company-id、设置 PAPERCLIP_COMPANY_ID，或通过 `paperclipai context set` 设置上下文配置的 companyId。",
    );
  }
  return ctx.companyId;
}

interface PluginInitResult {
  outputDir: string;
  nextCommands: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHomePath(packageArg: string): string {
  if (!packageArg.startsWith("~")) return packageArg;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.resolve(home, packageArg.slice(1).replace(/^[\\/]/, ""));
}

function hasLocalPathSyntax(packageArg: string): boolean {
  return (
    path.isAbsolute(packageArg) ||
    packageArg.startsWith("./") ||
    packageArg.startsWith("../") ||
    packageArg.startsWith("~") ||
    packageArg.startsWith(".\\") ||
    packageArg.startsWith("..\\")
  );
}

function isExistingRelativePath(
  packageArg: string,
  cwd: string,
  pathExists: (targetPath: string) => boolean,
): boolean {
  if (packageArg.trim() === "") return false;
  if (hasLocalPathSyntax(packageArg)) return false;
  return pathExists(path.resolve(cwd, packageArg));
}

/**
 * Resolve a local path argument to an absolute path so the server can find the
 * plugin on disk regardless of where the user ran the CLI.
 */
function resolvePackageArg(packageArg: string, isLocal: boolean, cwd = process.cwd()): string {
  if (!isLocal) return packageArg;
  if (path.isAbsolute(packageArg)) return packageArg;
  if (packageArg.startsWith("~")) return expandHomePath(packageArg);
  return path.resolve(cwd, packageArg);
}

export function buildPluginInstallRequest(
  packageArg: string,
  opts: Pick<PluginInstallOptions, "local" | "version"> = {},
  deps: { cwd?: string; existsSync?: (targetPath: string) => boolean } = {},
): PluginInstallRequest {
  const cwd = deps.cwd ?? process.cwd();
  const pathExists = deps.existsSync ?? existsSync;
  const isLocal =
    opts.local ||
    hasLocalPathSyntax(packageArg) ||
    (opts.version ? false : isExistingRelativePath(packageArg, cwd, pathExists));

  if (isLocal && opts.version) {
    throw new Error("--version 只支持安装 npm 包，不支持本地插件路径。");
  }

  return {
    packageName: resolvePackageArg(packageArg, Boolean(isLocal), cwd),
    version: opts.version,
    isLocalPath: Boolean(isLocal),
  };
}

export function renderLocalPluginInstallHint(packagePath: string): string {
  return [
    pc.dim("安装本地插件会运行本机上受信任的代码。"),
    pc.dim(`请保持 ${pc.cyan("pnpm dev")} 在 ${packagePath} 中运行；Alice 会监控重新构建的 dist 输出并重新加载插件进程。`),
  ].join("\n");
}

/**
 * Probe `GET /api/health` on the instance the CLI is configured to talk to so a
 * developer can confirm *which* Paperclip they are about to install into. This
 * exists because a local-path plugin can otherwise be silently installed into a
 * stale control-plane host that does not serve the branch's routes; surfacing
 * the API URL plus the server version/status catches that mismatch before the
 * plugin is exercised against the wrong runtime.
 */
export async function probeTargetDiagnostics(
  api: { apiBase: string; get(path: string): Promise<TargetHealth | null> },
): Promise<TargetDiagnostics> {
  try {
    const health = await api.get("/api/health");
    return {
      apiBase: api.apiBase,
      reachable: true,
      health: health ?? undefined,
    };
  } catch (err) {
    return {
      apiBase: api.apiBase,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Render the target-host diagnostics as human-readable lines. Pure so it can be
 * unit-tested without a live server.
 */
export function formatTargetDiagnostics(diag: TargetDiagnostics): string {
  const lines = [pc.dim(`目标 Alice 实例：${pc.cyan(diag.apiBase)}`)];

  if (!diag.reachable) {
    lines.push(pc.yellow(`  健康状态：不可访问${diag.error ? `（${diag.error.split("\n")[0]}）` : ""}`));
    lines.push(
      pc.dim(
        `  请确认正确的实例正在运行；如果实例位于其他地址，请传入 ${pc.cyan("--api-base <url>")} 或设置 ${pc.cyan("PAPERCLIP_API_URL")}。`,
      ),
    );
    return lines.join("\n");
  }

  const health = diag.health ?? {};
  const detailParts: string[] = [];
  if (health.status) detailParts.push(`状态=${health.status}`);
  if (health.version) detailParts.push(`版本=${health.version}`);
  if (health.deploymentMode) detailParts.push(`模式=${health.deploymentMode}`);
  if (health.deploymentExposure) detailParts.push(`访问范围=${health.deploymentExposure}`);

  lines.push(
    pc.dim(`  健康状态：${detailParts.length > 0 ? detailParts.join("  ") : "正常（未提供详情）"}`),
  );
  return lines.join("\n");
}

function formatPlugin(p: PluginRecord): string {
  const statusColor =
    p.status === "ready"
      ? pc.green(p.status)
      : p.status === "error"
        ? pc.red(p.status)
        : p.status === "disabled"
          ? pc.dim(p.status)
          : pc.yellow(p.status);

  const parts = [
    `键名=${pc.bold(p.pluginKey)}`,
    `状态=${statusColor}`,
    `版本=${p.version}`,
    `编号=${pc.dim(p.id)}`,
  ];

  if (p.lastError) {
    parts.push(`错误=${pc.red(p.lastError.slice(0, 80))}`);
  }

  return parts.join("  ");
}

function packageToDirName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

export function buildPluginInitScaffoldOptions(
  packageName: string,
  opts: PluginInitOptions,
  cwd = process.cwd(),
): ScaffoldPluginOptions {
  const outputRoot = path.resolve(cwd, opts.output ?? ".");
  const outputDir = path.resolve(outputRoot, packageToDirName(packageName));

  return {
    pluginName: packageName,
    outputDir,
    template: opts.template,
    category: opts.category,
    displayName: opts.displayName,
    description: opts.description,
    author: opts.author,
    sdkPath: opts.sdkPath,
  };
}

export function buildPluginInitNextCommands(outputDir: string): string[] {
  const quotedOutputDir = shellQuote(outputDir);
  return [
    `cd ${quotedOutputDir}`,
    "pnpm install",
    "pnpm dev",
    `paperclipai plugin install ${quotedOutputDir}`,
  ];
}

export function renderPluginInitSuccess(result: PluginInitResult): string {
  return [
    pc.green(`✓ 已在 ${result.outputDir} 创建插件脚手架`),
    "",
    "后续命令：",
    ...result.nextCommands.map((command) => `  ${pc.cyan(command)}`),
  ].join("\n");
}

export function runPluginInitCommand(packageName: string, opts: PluginInitOptions): PluginInitResult {
  const scaffoldOptions = buildPluginInitScaffoldOptions(packageName, opts);
  const outputDir = scaffoldPluginProject(scaffoldOptions);
  return {
    outputDir,
    nextCommands: buildPluginInitNextCommands(outputDir),
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("插件生命周期管理");

  // -------------------------------------------------------------------------
  // plugin init <package-name>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("init <packageName>")
      .description("创建本地 Alice 插件项目脚手架")
      .option("--output <dir>", "创建插件文件夹的目录")
      .addOption(
        new Option("--template <template>", "起始模板")
          .choices(["default", "connector", "workspace", "environment"])
          .default("default"),
      )
      .addOption(
        new Option("--category <category>", "清单分类")
          .choices(["connector", "workspace", "automation", "ui", "environment"]),
      )
      .option("--display-name <name>", "清单显示名称")
      .option("--description <description>", "清单说明")
      .option("--author <author>", "清单作者")
      .option("--sdk-path <path>", "本地 @paperclipai/plugin-sdk 包路径")
      .action((packageName: string, opts: PluginInitOptions) => {
        try {
          const result = runPluginInitCommand(packageName, opts);

          if (opts.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(renderPluginInitSuccess(result));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin list
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("list")
      .description("列出已安装插件")
      .option("--status <status>", "按状态筛选（ready、error、disabled、installed、upgrade_pending）")
      .action(async (opts: PluginListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
          const plugins = await ctx.api.get<PluginRecord[]>(`/api/plugins${qs}`);

          if (ctx.json) {
            printOutput(plugins, { json: true });
            return;
          }

          const rows = plugins ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("尚未安装插件。"));
            return;
          }

          for (const p of rows) {
            console.log(formatPlugin(p));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin install <package-or-path>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("install <package>")
      .description(
        "从本地路径或 npm 包安装插件。\n" +
          "  示例：\n" +
          "    paperclipai plugin install ./my-plugin              # 本地路径\n" +
          "    paperclipai plugin install @acme/plugin-linear      # npm 包\n" +
          "    paperclipai plugin install @acme/plugin-linear@1.2  # 固定版本",
      )
      .option("-l, --local", "将 <package> 视为本地文件系统路径", false)
      .option("--version <version>", "要安装的指定 npm 版本（仅限 npm 包）")
      .option(
        "--no-verify-target",
        "跳过安装前探测；该探测会显示插件将安装到哪个 Alice 实例",
      )
      .action(async (packageArg: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          const installRequest = buildPluginInstallRequest(packageArg, opts);

          // Make the install target explicit before sending the plugin to it. A
          // local-path plugin can otherwise be silently installed into a stale
          // control-plane host that lacks this branch's routes; printing the API
          // URL + server version/health lets the developer catch that mismatch.
          let target: TargetDiagnostics | undefined;
          if (opts.verifyTarget !== false) {
            target = await probeTargetDiagnostics(ctx.api);
            if (!ctx.json) {
              console.log(formatTargetDiagnostics(target));
            }
          }

          if (!ctx.json) {
            console.log(
              pc.dim(
                installRequest.isLocalPath
                  ? `正在从本地路径安装插件：${installRequest.packageName}`
                  : `正在安装插件：${installRequest.packageName}${opts.version ? `@${opts.version}` : ""}`,
              ),
            );
          }

          const installedPlugin = await ctx.api.post<PluginRecord>("/api/plugins/install", installRequest);

          if (ctx.json) {
            // Preserve the original flat PluginRecord shape so existing
            // automation reading top-level fields (id/pluginKey/version/status)
            // keeps working; attach target diagnostics as an additive field.
            printOutput({ ...installedPlugin, ...(target ? { target } : {}) }, { json: true });
            return;
          }

          if (!installedPlugin) {
            console.log(pc.dim("安装操作未返回插件记录。"));
            return;
          }

          console.log(
            pc.green(
              `✓ 已安装 ${pc.bold(installedPlugin.pluginKey)} v${installedPlugin.version}（${installedPlugin.status}）`,
            ),
          );

          if (installedPlugin.lastError) {
            console.log(pc.red(`  警告：${installedPlugin.lastError}`));
          }

          if (installRequest.isLocalPath) {
            console.log(renderLocalPluginInstallHint(installRequest.packageName));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin target
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("target")
      .description(
        "显示插件命令将连接的 Alice 实例。\n" +
          "  输出解析后的 API URL，以及 GET /api/health 返回的服务端状态、版本和模式，\n" +
          "  便于确认目标是当前分支运行时，而不是过期的控制面主机。",
      )
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const diag = await probeTargetDiagnostics(ctx.api);

          if (ctx.json) {
            printOutput(diag, { json: true });
            return;
          }

          console.log(formatTargetDiagnostics(diag));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin uninstall <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("uninstall <pluginKey>")
      .description(
        "按插件键名或数据库 ID 卸载插件。\n" +
          "  使用 --force 可彻底清除全部状态和配置。",
      )
      .option("--force", "彻底清除全部插件状态和配置", false)
      .action(async (pluginKey: string, opts: PluginUninstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const purge = opts.force === true;
          const qs = purge ? "?purge=true" : "";

          if (!ctx.json) {
            console.log(
              pc.dim(
                purge
                  ? `正在卸载并彻底清除插件：${pluginKey}`
                  : `正在卸载插件：${pluginKey}`,
              ),
            );
          }

          const result = await ctx.api.delete<PluginRecord | null>(
            `/api/plugins/${encodeURIComponent(pluginKey)}${qs}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ 已卸载 ${pc.bold(pluginKey)}${purge ? "（已彻底清除）" : ""}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin enable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("enable <pluginKey>")
      .description("启用已禁用或出错的插件")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/enable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ 已启用 ${pc.bold(pluginKey)}——状态：${result?.status ?? "未知"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin disable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("disable <pluginKey>")
      .description("禁用运行中的插件，但不卸载")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/disable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.dim(`已禁用 ${pc.bold(pluginKey)}——状态：${result?.status ?? "未知"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin inspect <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("inspect <pluginKey>")
      .description("显示已安装插件的完整详情")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          if (!result) {
            console.log(pc.red(`未找到插件：${pluginKey}`));
            process.exit(1);
          }

          console.log(formatPlugin(result));
          if (result.lastError) {
            console.log(`\n${pc.red("最近一次错误：")}\n${result.lastError}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin examples
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("examples")
      .description("列出可本地安装的内置示例插件")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const examples = await ctx.api.get<
            Array<{
              packageName: string;
              pluginKey: string;
              displayName: string;
              description: string;
              localPath: string;
              tag: string;
            }>
          >("/api/plugins/examples");

          if (ctx.json) {
            printOutput(examples, { json: true });
            return;
          }

          const rows = examples ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("没有可用的内置示例插件。"));
            return;
          }

          for (const ex of rows) {
            console.log(
              `${pc.bold(ex.displayName)}  ${pc.dim(ex.pluginKey)}\n` +
                `  ${ex.description}\n` +
                `  ${pc.cyan(`paperclipai plugin install ${ex.localPath}`)}`,
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addPluginGet(plugin, "ui-contributions", "列出插件界面扩展", "/api/plugins/ui-contributions");
  addPluginGet(plugin, "tools", "列出插件工具", "/api/plugins/tools");
  addPluginPost(plugin, "tool:execute", "执行插件工具", "/api/plugins/tools/execute");
  addPluginSubGet(plugin, "health", "获取插件健康状态", "health");
  addPluginSubGet(plugin, "logs", "获取插件日志", "logs");
  addPluginSubPost(plugin, "upgrade", "升级插件", "upgrade");
  addPluginConfigGet(plugin, "config", "获取公司范围的插件配置");
  addPluginConfigPost(plugin, "config:set", "设置公司范围的插件配置", "config");
  addPluginConfigPost(plugin, "config:test", "测试公司范围的插件配置", "config/test");
  addPluginSubGet(plugin, "jobs", "列出插件任务", "jobs");
  addPluginJobGet(plugin, "job:runs", "列出插件任务运行记录", "runs");
  addPluginJobPost(plugin, "job:trigger", "触发插件任务", "trigger");
  addPluginKeyPost(plugin, "webhook", "发送插件 Webhook", "webhooks");
  addPluginSubGet(plugin, "dashboard", "获取插件仪表盘数据", "dashboard");
  addPluginSubPost(plugin, "bridge:data", "发送插件桥接数据", "bridge/data");
  addPluginSubPost(plugin, "bridge:action", "发送插件桥接操作", "bridge/action");
  addCommonClientOptions(
    plugin
      .command("bridge:stream")
      .description("持续读取插件桥接通道")
      .argument("<pluginId>", "插件 ID 或键名")
      .argument("<channel>", "数据流通道")
      .option("--duration-ms <ms>", "经过指定毫秒后停止读取")
      .action(async (pluginId: string, channel: string, opts: PluginStreamOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await streamPluginBridge(ctx.api.apiBase, ctx.api.apiKey, pluginId, channel, parseOptionalInt(opts.durationMs));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addPluginKeyPost(plugin, "data", "获取按 URL 键名索引的插件数据", "data");
  addPluginKeyPost(plugin, "action", "调用按 URL 键名索引的插件操作", "actions");
  addPluginLocalFolderGet(plugin, "local-folders", "列出插件本地文件夹绑定");
  addPluginLocalFolderKeyGet(plugin, "local-folder:status", "获取插件本地文件夹状态", "status");
  addPluginLocalFolderKeyPost(plugin, "local-folder:validate", "验证插件本地文件夹绑定", "validate");
  addPluginLocalFolderKeyPut(plugin, "local-folder:set", "设置插件本地文件夹绑定");
}

function addPluginGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).action(async (opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(path), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).option("--payload-json <json>", "JSON 数据", "{}").action(async (opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginSubGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "插件 ID 或键名").action(async (pluginId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginSubPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "插件 ID 或键名").option("--payload-json <json>", "JSON 数据", "{}").action(async (pluginId: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginConfigGet(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .option("-C, --company-id <id>", "公司 ID")
      .action(async (pluginId: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = requireCompanyId(ctx);
          printOutput(
            await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/config?companyId=${encodeURIComponent(companyId)}`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginConfigPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .option("-C, --company-id <id>", "公司 ID")
      .option("--payload-json <json>", "JSON 数据", "{}")
      .action(async (pluginId: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = parseJson(opts.payloadJson ?? "{}") as Record<string, unknown>;
          printOutput(
            await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`, {
              ...payload,
              companyId: ctx.companyId,
            }),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginJobGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "插件 ID 或键名").argument("<jobId>", "任务 ID").action(async (pluginId: string, jobId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginJobPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "插件 ID 或键名").argument("<jobId>", "任务 ID").option("--payload-json <json>", "JSON 数据", "{}").action(async (pluginId: string, jobId: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginKeyPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "插件 ID 或键名").argument("<key>", "端点或数据/操作键名").option("--payload-json <json>", "JSON 数据", "{}").action(async (pluginId: string, key: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}/${encodeURIComponent(key)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginLocalFolderGet(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (pluginId: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .argument("<folderKey>", "本地文件夹键名")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .argument("<folderKey>", "本地文件夹键名")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .option("--payload-json <json>", "JSON 数据", "{}")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPut(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "插件 ID 或键名")
      .argument("<folderKey>", "本地文件夹键名")
      .requiredOption("-C, --company-id <id>", "公司 ID")
      .requiredOption("--payload-json <json>", "JSON 数据")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.put(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`无效的整数值：${value}`);
  }
  return parsed;
}

async function streamPluginBridge(
  apiBase: string,
  apiKey: string | undefined,
  pluginId: string,
  channel: string,
  durationMs: number | undefined,
): Promise<void> {
  const controller = new AbortController();
  const timer = durationMs === undefined ? null : setTimeout(() => controller.abort(), durationMs);
  try {
    const response = await fetch(buildApiUrl(
      apiBase,
      `/api/plugins/${encodeURIComponent(pluginId)}/bridge/stream/${encodeURIComponent(channel)}`,
    ), {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text.trim() || `请求失败，状态码 ${response.status}`);
    }
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) process.stdout.write(decoder.decode(value, { stream: true }));
    }
    const trailing = decoder.decode();
    if (trailing) process.stdout.write(trailing);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}
