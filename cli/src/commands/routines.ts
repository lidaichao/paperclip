import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  applyPendingMigrations,
  createDb,
  createEmbeddedPostgresLogBuffer,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  prepareEmbeddedPostgresNativeRuntime,
  routines,
} from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

type RoutinesDisableAllOptions = {
  config?: string;
  dataDir?: string;
  companyId?: string;
  json?: boolean;
};

type DisableAllRoutinesResult = {
  companyId: string;
  totalRoutines: number;
  pausedCount: number;
  alreadyPausedCount: number;
  archivedCount: number;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

type EmbeddedPostgresHandle = {
  port: number;
  startedByThisProcess: boolean;
  stop: () => Promise<void>;
};

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferredPort: number): Promise<number> {
  let port = Math.max(1, Math.trunc(preferredPort));
  while (!(await isPortAvailable(port))) {
    port += 1;
  }
  return port;
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!fs.existsSync(postmasterPidFile)) return null;
  try {
    const lines = fs.readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!fs.existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(fs.readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function ensureEmbeddedPostgres(dataDir: string, preferredPort: number): Promise<EmbeddedPostgresHandle> {
  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "内置 PostgreSQL 支持需要依赖 `embedded-postgres`，请重新安装依赖后重试。",
    );
  }
  await prepareEmbeddedPostgresNativeRuntime();

  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  if (runningPid) {
    return {
      port: readPidFilePort(postmasterPidFile) ?? preferredPort,
      startedByThisProcess: false,
      stop: async () => {},
    };
  }

  const port = await findAvailablePort(preferredPort);
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!fs.existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage: `无法在 ${dataDir} 初始化端口为 ${port} 的内置 PostgreSQL 集群`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }

  if (fs.existsSync(postmasterPidFile)) {
    fs.rmSync(postmasterPidFile, { force: true });
  }

  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `无法启动端口为 ${port} 的内置 PostgreSQL`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  return {
    port,
    startedByThisProcess: true,
    stop: async () => {
      await instance.stop();
    },
  };
}

async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

async function openConfiguredDb(configPath: string): Promise<{
  db: ClosableDb;
  stop: () => Promise<void>;
}> {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`未在 ${configPath} 找到配置。`);
  }

  let embeddedHandle: EmbeddedPostgresHandle | null = null;
  try {
    if (config.database.mode === "embedded-postgres") {
      embeddedHandle = await ensureEmbeddedPostgres(
        config.database.embeddedPostgresDataDir,
        config.database.embeddedPostgresPort,
      );
      const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${embeddedHandle.port}/postgres`;
      await ensurePostgresDatabase(adminConnectionString, "paperclip");
      const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${embeddedHandle.port}/paperclip`;
      await applyPendingMigrations(connectionString);
      const db = createDb(connectionString) as ClosableDb;
      return {
        db,
        stop: async () => {
          await closeDb(db);
          if (embeddedHandle?.startedByThisProcess) {
            await embeddedHandle.stop().catch(() => undefined);
          }
        },
      };
    }

    const connectionString = nonEmpty(config.database.connectionString);
    if (!connectionString) {
      throw new Error(`${configPath} 中的配置未定义数据库连接字符串。`);
    }

    await applyPendingMigrations(connectionString);
    const db = createDb(connectionString) as ClosableDb;
    return {
      db,
      stop: async () => {
        await closeDb(db);
      },
    };
  } catch (error) {
    if (embeddedHandle?.startedByThisProcess) {
      await embeddedHandle.stop().catch(() => undefined);
    }
    throw error;
  }
}

export async function disableAllRoutinesInConfig(
  options: Pick<RoutinesDisableAllOptions, "config" | "companyId">,
): Promise<DisableAllRoutinesResult> {
  const configPath = resolveConfigPath(options.config);
  loadPaperclipEnvFile(configPath);
  const companyId =
    nonEmpty(options.companyId)
    ?? nonEmpty(process.env.PAPERCLIP_COMPANY_ID)
    ?? null;
  if (!companyId) {
    throw new Error("必须提供公司编号。请传入 --company-id 或设置 PAPERCLIP_COMPANY_ID。");
  }

  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`未在 ${configPath} 找到配置。`);
  }

  let embeddedHandle: EmbeddedPostgresHandle | null = null;
  let db: ClosableDb | null = null;
  try {
    if (config.database.mode === "embedded-postgres") {
      embeddedHandle = await ensureEmbeddedPostgres(
        config.database.embeddedPostgresDataDir,
        config.database.embeddedPostgresPort,
      );
      const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${embeddedHandle.port}/postgres`;
      await ensurePostgresDatabase(adminConnectionString, "paperclip");
      const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${embeddedHandle.port}/paperclip`;
      await applyPendingMigrations(connectionString);
      db = createDb(connectionString) as ClosableDb;
    } else {
      const connectionString = nonEmpty(config.database.connectionString);
      if (!connectionString) {
        throw new Error(`${configPath} 中的配置未定义数据库连接字符串。`);
      }
      await applyPendingMigrations(connectionString);
      db = createDb(connectionString) as ClosableDb;
    }

    const existing = await db
      .select({
        id: routines.id,
        status: routines.status,
      })
      .from(routines)
      .where(eq(routines.companyId, companyId));

    const alreadyPausedCount = existing.filter((routine) => routine.status === "paused").length;
    const archivedCount = existing.filter((routine) => routine.status === "archived").length;
    const idsToPause = existing
      .filter((routine) => routine.status !== "paused" && routine.status !== "archived")
      .map((routine) => routine.id);

    if (idsToPause.length > 0) {
      await db
        .update(routines)
        .set({
          status: "paused",
          updatedAt: new Date(),
        })
        .where(inArray(routines.id, idsToPause));
    }

    return {
      companyId,
      totalRoutines: existing.length,
      pausedCount: idsToPause.length,
      alreadyPausedCount,
      archivedCount,
    };
  } finally {
    if (db) {
      await closeDb(db);
    }
    if (embeddedHandle?.startedByThisProcess) {
      await embeddedHandle.stop().catch(() => undefined);
    }
  }
}

export async function disableAllRoutinesCommand(options: RoutinesDisableAllOptions): Promise<void> {
  const result = await disableAllRoutinesInConfig(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.totalRoutines === 0) {
    console.log(pc.dim(`公司 ${result.companyId} 没有例行任务。`));
    return;
  }

  console.log(
    `已暂停公司 ${result.companyId} 的 ${result.pausedCount} 个例行任务` +
      `（${result.alreadyPausedCount} 个原已暂停，${result.archivedCount} 个已归档）。`,
  );
}

export function registerRoutineCommands(program: Command): void {
  const routinesCommand = program.command("routines").description("本地例行任务维护命令");

  routinesCommand
    .command("disable-all")
    .description("暂停本地实例中指定公司的所有未归档例行任务")
    .option("-c, --config <path>", "配置文件路径")
    .option("-d, --data-dir <path>", "Alice 数据目录根路径（与 ~/.paperclip 状态隔离）")
    .option("-C, --company-id <id>", "公司编号")
    .option("--json", "输出原始 JSON")
    .action(async (opts: RoutinesDisableAllOptions) => {
      try {
        await disableAllRoutinesCommand(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(message));
        process.exit(1);
      }
    });
}
