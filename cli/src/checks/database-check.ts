import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

function isInsideOsTmpDir(targetPath: string): boolean {
  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(targetPath);
  return resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`);
}

export async function databaseCheck(config: PaperclipConfig, configPath?: string): Promise<CheckResult> {
  if (config.database.mode === "postgres") {
    if (!config.database.connectionString) {
      return {
        name: "数据库",
        status: "fail",
        message: "已选择 PostgreSQL 模式，但未配置连接字符串",
        canRepair: false,
        repairHint: "请运行 `paperclipai configure --section database`",
      };
    }

    try {
      const { createDb } = await import("@paperclipai/db");
      const db = createDb(config.database.connectionString);
      await db.execute("SELECT 1");
      return {
        name: "数据库",
        status: "pass",
        message: "PostgreSQL 连接成功",
      };
    } catch (err) {
      return {
        name: "数据库",
        status: "fail",
        message: `无法连接 PostgreSQL：${err instanceof Error ? err.message : String(err)}`,
        canRepair: false,
        repairHint: "请检查连接字符串，并确认 PostgreSQL 正在运行",
      };
    }
  }

  if (config.database.mode === "embedded-postgres") {
    const dataDir = resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath);

    // A worktree-mode instance whose data dir lives under the OS temp dir is a red
    // flag: this is what happens when PAPERCLIP_HOME / PAPERCLIP_IN_WORKTREE leak
    // into a PRIMARY instance's environment and silently relocate it to a throwaway
    // temp home, so it boots an empty DB and locks everyone out. (Intentional
    // ephemeral/CI instances that don't set PAPERCLIP_IN_WORKTREE are not flagged.)
    // Check BEFORE creating the dir so we don't bootstrap the very temp location
    // we're warning about.
    if (isInsideOsTmpDir(dataDir) && process.env.PAPERCLIP_IN_WORKTREE === "true") {
      return {
        name: "数据库",
        status: "warn",
        message:
          `内置 PostgreSQL 数据目录位于系统临时目录中（${dataDir}），` +
          "且当前以工作区模式运行（PAPERCLIP_IN_WORKTREE=true）。这里的数据是临时的，" +
          "重启或清理临时文件后会丢失。如果这是主实例，PAPERCLIP_HOME / PAPERCLIP_IN_WORKTREE " +
          "可能意外泄漏到其环境变量中，导致实例指向一次性工作区目录，而非真实数据目录。",
        canRepair: false,
        repairHint:
          "如果这是主实例，请取消设置 PAPERCLIP_HOME 和 PAPERCLIP_IN_WORKTREE " +
          "（或传入 --data-dir <持久化路径>）并重启，使其使用持久化实例。",
      };
    }

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    return {
      name: "数据库",
      status: "pass",
      message: `已在 ${dataDir} 配置内置 PostgreSQL（端口 ${config.database.embeddedPostgresPort}）`,
    };
  }

  return {
    name: "数据库",
    status: "fail",
    message: `未知数据库模式：${String(config.database.mode)}`,
    canRepair: false,
    repairHint: "请运行 `paperclipai configure --section database`",
  };
}
