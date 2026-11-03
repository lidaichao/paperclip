import * as p from "@clack/prompts";
import type { DatabaseConfig } from "../config/schema.js";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

export async function promptDatabase(current?: DatabaseConfig): Promise<DatabaseConfig> {
  const instanceId = resolvePaperclipInstanceId();
  const defaultEmbeddedDir = resolveDefaultEmbeddedPostgresDir(instanceId);
  const defaultBackupDir = resolveDefaultBackupDir(instanceId);
  const base: DatabaseConfig = current ?? {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: defaultEmbeddedDir,
    embeddedPostgresPort: 54329,
    backup: {
      enabled: true,
      intervalMinutes: 60,
      retentionDays: 30,
      dir: defaultBackupDir,
    },
  };

  const mode = await p.select({
    message: "数据库模式",
    options: [
      { value: "embedded-postgres" as const, label: "内置 PostgreSQL（本机管理）", hint: "推荐" },
      { value: "postgres" as const, label: "PostgreSQL（外部服务器）" },
    ],
    initialValue: base.mode,
  });

  if (p.isCancel(mode)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  let connectionString: string | undefined = base.connectionString;
  let embeddedPostgresDataDir = base.embeddedPostgresDataDir || defaultEmbeddedDir;
  let embeddedPostgresPort = base.embeddedPostgresPort || 54329;
  const embeddedPortDefault = String(base.embeddedPostgresPort || 54329);

  if (mode === "postgres") {
    // Clack validates the raw input before applying defaultValue, so an
    // Enter press hands the validator an empty string. Validate the value
    // that will actually be submitted — the typed input, or the default.
    const connectionStringDefault = base.connectionString ?? "";
    const value = await p.text({
      message: "PostgreSQL 连接字符串",
      defaultValue: connectionStringDefault,
      placeholder: "postgres://user:pass@localhost:5432/paperclip",
      validate: (val) => {
        const candidate = val || connectionStringDefault;
        if (!candidate) return "PostgreSQL 模式必须填写连接字符串";
        if (!candidate.startsWith("postgres")) return "网址必须以 postgres:// 或 postgresql:// 开头";
      },
    });

    if (p.isCancel(value)) {
      p.cancel("已取消设置。");
      process.exit(0);
    }

    connectionString = value;
  } else {
    const dataDir = await p.text({
      message: "内置 PostgreSQL 数据目录",
      defaultValue: base.embeddedPostgresDataDir || defaultEmbeddedDir,
      placeholder: defaultEmbeddedDir,
    });

    if (p.isCancel(dataDir)) {
      p.cancel("已取消设置。");
      process.exit(0);
    }

    embeddedPostgresDataDir = dataDir || defaultEmbeddedDir;

    const portValue = await p.text({
      message: "内置 PostgreSQL 端口",
      defaultValue: embeddedPortDefault,
      placeholder: "54329",
      validate: (val) => {
        const n = Number(val || embeddedPortDefault);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return "端口必须是 1 到 65535 之间的整数";
      },
    });

    if (p.isCancel(portValue)) {
      p.cancel("已取消设置。");
      process.exit(0);
    }

    embeddedPostgresPort = Number(portValue || embeddedPortDefault);
    connectionString = undefined;
  }

  const backupEnabled = await p.confirm({
    message: "是否启用数据库自动备份？",
    initialValue: base.backup.enabled,
  });
  if (p.isCancel(backupEnabled)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const backupDirDefault = base.backup.dir || defaultBackupDir;
  const backupDirInput = await p.text({
    message: "备份目录",
    defaultValue: backupDirDefault,
    placeholder: defaultBackupDir,
    validate: (val) => ((val || backupDirDefault).trim().length === 0 ? "必须填写备份目录" : undefined),
  });
  if (p.isCancel(backupDirInput)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const backupIntervalDefault = String(base.backup.intervalMinutes || 60);
  const backupRetentionDefault = String(base.backup.retentionDays || 30);
  const backupIntervalInput = await p.text({
    message: "备份间隔（分钟）",
    defaultValue: backupIntervalDefault,
    placeholder: "60",
    validate: (val) => {
      const n = Number(val || backupIntervalDefault);
      if (!Number.isInteger(n) || n < 1) return "备份间隔必须是正整数";
      if (n > 10080) return "备份间隔不得超过 10080 分钟（7 天）";
      return undefined;
    },
  });
  if (p.isCancel(backupIntervalInput)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const backupRetentionInput = await p.text({
    message: "备份保留时间（天）",
    defaultValue: backupRetentionDefault,
    placeholder: "30",
    validate: (val) => {
      const n = Number(val || backupRetentionDefault);
      if (!Number.isInteger(n) || n < 1) return "保留时间必须是正整数";
      if (n > 3650) return "保留时间不得超过 3650 天";
      return undefined;
    },
  });
  if (p.isCancel(backupRetentionInput)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  return {
    mode,
    connectionString,
    embeddedPostgresDataDir,
    embeddedPostgresPort,
    backup: {
      enabled: backupEnabled,
      intervalMinutes: Number(backupIntervalInput || backupIntervalDefault),
      retentionDays: Number(backupRetentionInput || backupRetentionDefault),
      dir: backupDirInput || defaultBackupDir,
    },
  };
}
