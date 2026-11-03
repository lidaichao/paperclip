import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Option, type Command } from "commander";
import type { Agent, Company, InstanceExperimentalSettings } from "@paperclipai/shared";
import { PaperclipApiClient } from "../client/http.js";
import { openUrl } from "../client/board-auth.js";
import {
  expandHomePrefix,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
} from "../config/home.js";
import { readConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { runCommand, type StartedServer } from "./run.js";
import { isLinkedGitWorktree } from "./git-workspace.js";

export const TEST_DRIVE_HARNESSES = ["claude", "codex", "opencode"] as const;
export type TestDriveHarness = (typeof TEST_DRIVE_HARNESSES)[number];

export interface TestDriveOptions {
  dataDir?: string;
  companyName?: string;
  agentName?: string;
  harness?: TestDriveHarness;
  model?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  browser?: boolean;
}

export type TestDriveApi = Pick<PaperclipApiClient, "get" | "post" | "patch" | "delete">;

type HarnessDefinition = {
  adapterType: "claude_local" | "codex_local" | "opencode_local";
  credentialTarget: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  credentialName: string;
};

export type ResolvedTestDriveBootstrap = HarnessDefinition & {
  companyName: string;
  agentName: string;
  model?: string;
  credential: string;
  credentialSource: string;
};

export type TestDriveBootstrapResult = {
  reused: boolean;
  company: Company;
  agent: Agent | null;
};

export interface TestDriveDependencies {
  run: typeof runCommand;
  createApi: (apiBase: string) => TestDriveApi;
  openBrowser: (url: string) => Promise<boolean>;
}

const HARNESS_DEFINITIONS: Record<TestDriveHarness, HarnessDefinition> = {
  claude: {
    adapterType: "claude_local",
    credentialTarget: "ANTHROPIC_API_KEY",
    credentialName: "Anthropic API 密钥",
  },
  codex: {
    adapterType: "codex_local",
    credentialTarget: "OPENAI_API_KEY",
    credentialName: "OpenAI API 密钥",
  },
  opencode: {
    adapterType: "opencode_local",
    credentialTarget: "OPENROUTER_API_KEY",
    credentialName: "OpenRouter API 密钥",
  },
};

const NON_PAPERCLIP_ISOLATED_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "HOST",
  "PORT",
  "SERVE_UI",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
] as const;

function requiredApiResult<T>(value: T | null, action: string): T {
  if (value === null) {
    throw new Error(`Alice 在${action}时未返回结果。`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function redactTestDriveText(text: string, credentials: Array<string | undefined>): string {
  let redacted = text;
  for (const credential of credentials) {
    if (!credential) continue;
    redacted = redacted.replaceAll(credential, "[REDACTED]");
  }
  return redacted;
}

export function redactTestDriveArgv(
  apiKey: string | undefined,
  argv: string[] = process.argv,
): void {
  if (!apiKey) return;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--api-key" && argv[index + 1] === apiKey) {
      argv[index + 1] = "[REDACTED]";
      index += 1;
      continue;
    }
    if (argv[index] === `--api-key=${apiKey}`) {
      argv[index] = "--api-key=[REDACTED]";
    }
  }
}

export function resolveTestDriveDataDir(dataDir?: string): string {
  const explicit = dataDir?.trim();
  if (explicit) {
    return path.resolve(expandHomePrefix(explicit));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-drive-"));
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function resolveTestDriveServerPort(preferredPort = 3100): Promise<number> {
  for (let port = preferredPort; port <= 65_535; port += 1) {
    if (await loopbackPortAvailable(port)) return port;
  }
  throw new Error(`从端口 ${preferredPort} 开始未找到可用的本机回环端口。`);
}

/**
 * Establish isolation before the CLI's normal config and .env loading hook.
 * The selected credential source is preserved in case its name happens to use
 * a PAPERCLIP_ prefix; all other Paperclip routing/configuration is discarded.
 */
export async function prepareTestDriveEnvironment(
  options: Pick<TestDriveOptions, "dataDir" | "apiKeyEnv">,
  cwd = process.cwd(),
): Promise<{ dataDir: string; linkedWorktree: boolean }> {
  const sourceEnvName = options.apiKeyEnv?.trim();
  const preservedCredential = sourceEnvName ? process.env[sourceEnvName] : undefined;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete process.env[key];
    }
  }
  for (const key of NON_PAPERCLIP_ISOLATED_ENV_KEYS) {
    delete process.env[key];
  }
  if (sourceEnvName && preservedCredential !== undefined) {
    process.env[sourceEnvName] = preservedCredential;
  }

  const dataDir = resolveTestDriveDataDir(options.dataDir);
  const linkedWorktree = isLinkedGitWorktree(cwd);
  process.env.PAPERCLIP_HOME = dataDir;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.PAPERCLIP_CONFIG = resolveDefaultConfigPath("default");
  process.env.PAPERCLIP_CONTEXT = resolveDefaultContextPath();
  process.env.PAPERCLIP_IN_WORKTREE = linkedWorktree ? "true" : "false";
  process.env.PAPERCLIP_OPEN_ON_LISTEN = "false";
  process.env.PAPERCLIP_DISABLE_CWD_ENV_FILE = "true";
  process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
  process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
  process.env.PAPERCLIP_BIND = "loopback";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(await resolveTestDriveServerPort());

  return { dataDir, linkedWorktree };
}

export function assertTestDriveDatabaseIsolation(
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  readConfigFile: (path?: string) => PaperclipConfig | null = readConfig,
): void {
  if (env.DATABASE_URL?.trim() || env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error(
      "测试驾驶需要使用独立的内置数据库。请从所选数据目录的 .env 中移除 DATABASE_URL 和 " +
        "DATABASE_MIGRATION_URL，或选择新的 --data-dir。",
    );
  }

  const config = readConfigFile(configPath);
  if (config?.database.mode === "postgres") {
    throw new Error(
      "测试驾驶无法复用已配置为外部 PostgreSQL 数据库的数据目录。" +
        "请选择新的数据目录，或将 database.mode 改为 embedded-postgres。",
    );
  }
}

export function resolveTestDriveBootstrap(
  options: TestDriveOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTestDriveBootstrap {
  if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
    throw new Error("--api-key and --api-key-env are mutually exclusive.");
  }

  const harness = options.harness ?? "claude";
  const definition = HARNESS_DEFINITIONS[harness];
  if (!definition) {
    throw new Error(`不支持的测试驾驶执行环境：${String(harness)}。`);
  }

  const companyName = (options.companyName ?? "测试公司").trim();
  const agentName = (options.agentName ?? "CEO").trim();
  if (!companyName) throw new Error("--company-name cannot be empty.");
  if (!agentName) throw new Error("--agent-name cannot be empty.");

  const model = options.model;
  if (model !== undefined && (!model || model.trim() !== model)) {
    throw new Error("--model cannot be empty or have surrounding whitespace.");
  }
  if (
    harness === "opencode" &&
    (!model || !/^openrouter\/[^/\s]+(?:\/[^/\s]+)*$/.test(model))
  ) {
    throw new Error(
      "OpenCode 测试驾驶要求使用 --model openrouter/<model>，路径中不能有空段。",
    );
  }

  const sourceEnvName = options.apiKeyEnv?.trim() || definition.credentialTarget;
  if (options.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceEnvName)) {
    throw new Error("--api-key-env must name a valid environment variable.");
  }
  const credential = options.apiKey ?? env[sourceEnvName];
  if (!credential || credential.trim().length === 0) {
    throw new Error(
      `未找到凭据。请设置 ${sourceEnvName}、传入 --api-key-env <variable>，或传入 --api-key <value>。`,
    );
  }

  return {
    ...definition,
    companyName,
    agentName,
    ...(model ? { model } : {}),
    credential,
    credentialSource: options.apiKey !== undefined ? "--api-key" : sourceEnvName,
  };
}

function worktreeExecutionArmed(
  settings: InstanceExperimentalSettings,
  instanceId: string,
): boolean {
  return settings.enableWorktreeRunExecution === true
    && Boolean(settings.worktreeRunExecutionActivatedAt)
    && settings.worktreeRunExecutionActivationInstanceId === instanceId;
}

export async function reconcileTestDriveWorktreeExecution(
  api: TestDriveApi,
  instanceId: string,
): Promise<void> {
  const current = requiredApiResult(
    await api.get<InstanceExperimentalSettings>("/api/instance/settings/experimental"),
    "读取实验设置",
  );

  if (!current.enableWorktreeRunExecution) {
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: true,
    });
  } else if (!worktreeExecutionArmed(current, instanceId)) {
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: false,
    });
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: true,
    });
  }

  const verified = requiredApiResult(
    await api.get<InstanceExperimentalSettings>("/api/instance/settings/experimental"),
    "验证实验设置",
  );
  if (!worktreeExecutionArmed(verified, instanceId)) {
    throw new Error(
      `无法为 Alice 实例 ${instanceId} 启用“在此工作区运行任务”。` +
        "请确认 PAPERCLIP_IN_WORKTREE=true 后重试该命令。",
    );
  }
}

export async function bootstrapTestDrive(input: {
  api: TestDriveApi;
  options: TestDriveOptions;
  linkedWorktree: boolean;
  instanceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TestDriveBootstrapResult> {
  const companies = requiredApiResult(
    await input.api.get<Company[]>("/api/companies"),
    "读取公司",
  );
  const existingCompany = companies[0];
  if (existingCompany) {
    if (input.linkedWorktree) {
      await reconcileTestDriveWorktreeExecution(input.api, input.instanceId);
    }
    return { reused: true, company: existingCompany, agent: null };
  }

  // Resolve every bootstrap input before the first mutation. In particular,
  // OpenCode model validation and credential lookup happen before company
  // creation so an invalid invocation leaves the database untouched.
  const resolved = resolveTestDriveBootstrap(input.options, input.env);
  let company: Company | null = null;
  try {
    company = requiredApiResult(
      await input.api.post<Company>("/api/companies", { name: resolved.companyName }),
      "创建测试公司",
    );
    await input.api.post(`/api/companies/${company.id}/user-secret-definitions`, {
      key: resolved.credentialTarget,
      name: resolved.credentialName,
    });
    await input.api.post(`/api/companies/${company.id}/me/user-secrets`, {
      definitionKey: resolved.credentialTarget,
      value: resolved.credential,
    });

    const adapterConfig: Record<string, unknown> = {
      env: {
        [resolved.credentialTarget]: {
          type: "user_secret_ref",
          key: resolved.credentialTarget,
          version: "latest",
          required: true,
        },
      },
    };
    if (resolved.model) adapterConfig.model = resolved.model;

    const agent = requiredApiResult(
      await input.api.post<Agent>(`/api/companies/${company.id}/agents`, {
        name: resolved.agentName,
        role: "ceo",
        adapterType: resolved.adapterType,
        adapterConfig,
      }),
      "创建 CEO 智能体",
    );

    if (input.linkedWorktree) {
      await reconcileTestDriveWorktreeExecution(input.api, input.instanceId);
    }
    return { reused: false, company, agent };
  } catch (error) {
    if (company) {
      try {
        await input.api.delete(`/api/companies/${company.id}`);
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup also failed for newly-created company ${company.id}: ${errorMessage(cleanupError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function dashboardUrl(server: StartedServer): string {
  return server.apiUrl.replace(/\/api\/?$/, "");
}

export async function testDriveCommand(
  options: TestDriveOptions,
  dependencies: TestDriveDependencies = {
    run: runCommand,
    createApi: (apiBase) => new PaperclipApiClient({ apiBase }),
    openBrowser: openUrl,
  },
): Promise<void> {
  // Commander has already copied the value into options. Remove it from the
  // JavaScript argv view before logging, telemetry, diagnostics, or startup.
  redactTestDriveArgv(options.apiKey);
  const dataDir = path.resolve(process.env.PAPERCLIP_HOME ?? resolveTestDriveDataDir(options.dataDir));
  const linkedWorktree = process.env.PAPERCLIP_IN_WORKTREE === "true";
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID ?? "default";
  // Resolve environment-backed credentials against the CLI environment as it
  // exists before server startup. In-process server initialization must not
  // change which credential the post-listen bootstrap observes.
  const bootstrapEnv = { ...process.env };
  const possibleCredentials = [
    options.apiKey,
    options.apiKeyEnv ? bootstrapEnv[options.apiKeyEnv.trim()] : undefined,
    bootstrapEnv[HARNESS_DEFINITIONS[options.harness ?? "claude"].credentialTarget],
  ];

  p.log.message(pc.dim(`数据目录：${dataDir}`));
  p.log.message(pc.dim("Alice 退出后会保留该数据目录。"));
  if (options.apiKey !== undefined) {
    p.log.warn("通过 --api-key 传入的密钥可能出现在进程参数和终端历史记录中。" );
  }

  try {
    await dependencies.run({
      repair: true,
      yes: true,
      bind: "loopback",
      installService: false,
      // Auto-created directories are private to this process. Explicitly reused
      // directories retain the normal guard against an already-managed instance.
      skipServiceManagerCheck: !options.dataDir?.trim(),
      introLabel: "paperclipai test-drive",
      afterStart: async (server) => {
        const api = dependencies.createApi(server.apiUrl);
        const result = await bootstrapTestDrive({
          api,
          options,
          linkedWorktree,
          instanceId,
          env: bootstrapEnv,
        });
        if (result.reused) {
          p.log.message(
            `正在使用 ${pc.cyan(result.company.name)} 的现有数据；初始化参数已忽略。`,
          );
        } else {
          p.log.success(
            `已创建 ${pc.cyan(result.company.name)}，智能体为 ${pc.cyan(result.agent?.name ?? "CEO")}。`,
          );
        }
        if (linkedWorktree) {
          p.log.success("此实例已启用“在此工作区运行任务”。");
        }

        const url = dashboardUrl(server);
        if (options.browser === false) {
          p.log.success(`Alice 已就绪：${pc.cyan(url)}。`);
          return;
        }
        const opened = await dependencies.openBrowser(url);
        if (opened) {
          p.log.success(`Alice 已就绪，并已在浏览器中打开：${pc.cyan(url)}。`);
        } else {
          p.log.warn(`Alice 已就绪，但无法打开浏览器。请访问 ${url}。`);
        }
      },
    });
  } catch (error) {
    throw new Error(redactTestDriveText(errorMessage(error), possibleCredentials), { cause: error });
  }
}

export function registerTestDriveCommand(program: Command): void {
  program
    .command("test-drive")
    .description("启动一个独立且已初始化的 Alice 实例，用于手动测试")
    .option("-d, --data-dir <path>", "要创建或复用的 Alice 数据目录")
    .option("--company-name <name>", "初始公司名称", "测试公司")
    .option("--agent-name <name>", "初始 CEO 智能体名称", "CEO")
    .addOption(
      new Option("--harness <harness>", "初始智能体执行环境")
        .choices(TEST_DRIVE_HARNESSES)
        .default("claude"),
    )
    .option("--model <model-id>", "初始智能体模型")
    .addOption(
      new Option("--api-key-env <variable>", "从环境变量读取服务商密钥")
        .conflicts("apiKey"),
    )
    .addOption(
      new Option("--api-key <value>", "服务商 API 密钥")
        .conflicts("apiKeyEnv"),
    )
    .option("--no-browser", "不在浏览器中打开初始化后的实例")
    .action(async (options: TestDriveOptions) => {
      await testDriveCommand(options);
    });
}
