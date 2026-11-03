import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PaperclipConfig } from "../config/schema.js";
import { configExists, readConfig, resolveConfigPath } from "../config/store.js";
import {
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

type EnvSource = "env" | "config" | "file" | "default" | "missing";

type EnvVarRow = {
  key: string;
  value: string;
  source: EnvSource;
  required: boolean;
  note: string;
};

const DEFAULT_AGENT_JWT_TTL_SECONDS = "172800";
const DEFAULT_AGENT_JWT_ISSUER = "paperclip";
const DEFAULT_AGENT_JWT_AUDIENCE = "paperclip-api";
const DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS = "30000";
const DEFAULT_SECRETS_PROVIDER = "local_encrypted";
const DEFAULT_STORAGE_PROVIDER = "local_disk";
function defaultSecretsKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolvePaperclipInstanceId());
}
function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export async function envCommand(opts: { config?: string }): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Alice 环境变量 ")));

  const configPath = resolveConfigPath(opts.config);
  let config: PaperclipConfig | null = null;
  let configReadError: string | null = null;

  if (configExists(opts.config)) {
    p.log.message(pc.dim(`配置文件：${configPath}`));
    try {
      config = readConfig(opts.config);
    } catch (err) {
      configReadError = err instanceof Error ? err.message : String(err);
      p.log.message(pc.yellow(`无法解析配置：${configReadError}`));
    }
  } else {
    p.log.message(pc.dim(`配置文件不存在：${configPath}`));
  }

  const rows = collectDeploymentEnvRows(config, configPath);
  const missingRequired = rows.filter((row) => row.required && row.source === "missing");
  const sortedRows = rows.sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key));

  const requiredRows = sortedRows.filter((row) => row.required);
  const optionalRows = sortedRows.filter((row) => !row.required);

  const formatSection = (title: string, entries: EnvVarRow[]) => {
    if (entries.length === 0) return;

    p.log.message(pc.bold(title));
    for (const entry of entries) {
      const status = entry.source === "missing" ? pc.red("缺失") : entry.source === "default" ? pc.yellow("默认") : pc.green("已设置");
      const sourceNote = {
        env: "环境变量",
        config: "配置",
        file: "文件",
        default: "默认",
        missing: "缺失",
      }[entry.source];
      p.log.message(
        `${pc.cyan(entry.key)} ${status.padEnd(7)} ${pc.dim(`[${sourceNote}] ${entry.note}`)}${entry.source === "missing" ? "" : ` ${pc.dim("=>")} ${pc.white(quoteShellValue(entry.value))}`}`,
      );
    }
  };

  formatSection("必需环境变量", requiredRows);
  formatSection("可选环境变量", optionalRows);

  const exportRows = rows.map((row) => (row.source === "missing" ? { ...row, value: "<请设置此值>" } : row));
  const uniqueRows = uniqueByKey(exportRows);
  const exportBlock = uniqueRows.map((row) => `export ${row.key}=${quoteShellValue(row.value)}`).join("\n");

  if (configReadError) {
    p.log.error(`无法完整加载配置：${configReadError}`);
  }

  p.note(
    exportBlock || "未检测到值，请手动设置必需变量。",
    "部署导出内容",
  );

  if (missingRequired.length > 0) {
    p.log.message(
      pc.yellow(
        `缺少必需值：${missingRequired.map((row) => row.key).join(", ")}。请在部署前设置。`,
      ),
    );
  } else {
    p.log.message(pc.green("部署所需变量均已设置。"));
  }
  p.outro("完成");
}

function collectDeploymentEnvRows(config: PaperclipConfig | null, configPath: string): EnvVarRow[] {
  const agentJwtEnvFile = resolveAgentJwtEnvFile(configPath);
  const jwtEnv = readAgentJwtSecretFromEnv(configPath);
  const jwtFile = jwtEnv ? null : readAgentJwtSecretFromEnvFile(agentJwtEnvFile);
  const jwtSource = jwtEnv ? "env" : jwtFile ? "file" : "missing";

  const dbUrl = process.env.DATABASE_URL ?? config?.database?.connectionString ?? "";
  const databaseMode = config?.database?.mode ?? "embedded-postgres";
  const dbUrlSource: EnvSource = process.env.DATABASE_URL ? "env" : config?.database?.connectionString ? "config" : "missing";
  const publicUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    config?.auth?.publicBaseUrl ??
    "";
  const publicUrlSource: EnvSource =
    process.env.PAPERCLIP_PUBLIC_URL
      ? "env"
      : process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_BASE_URL
        ? "env"
        : config?.auth?.publicBaseUrl
          ? "config"
          : "missing";
  let trustedOriginsDefault = "";
  if (publicUrl) {
    try {
      trustedOriginsDefault = new URL(publicUrl).origin;
    } catch {
      trustedOriginsDefault = "";
    }
  }

  const heartbeatInterval = process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ?? DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS;
  const heartbeatEnabled = process.env.HEARTBEAT_SCHEDULER_ENABLED ?? "true";
  const secretsProvider =
    process.env.PAPERCLIP_SECRETS_PROVIDER ??
    config?.secrets?.provider ??
    DEFAULT_SECRETS_PROVIDER;
  const secretsStrictMode =
    process.env.PAPERCLIP_SECRETS_STRICT_MODE ??
    String(config?.secrets?.strictMode ?? false);
  const secretsKeyFilePath =
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
    config?.secrets?.localEncrypted?.keyFilePath ??
    defaultSecretsKeyFilePath();
  const storageProvider =
    process.env.PAPERCLIP_STORAGE_PROVIDER ??
    config?.storage?.provider ??
    DEFAULT_STORAGE_PROVIDER;
  const storageLocalDir =
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
    config?.storage?.localDisk?.baseDir ??
    defaultStorageBaseDir();
  const storageS3Bucket =
    process.env.PAPERCLIP_STORAGE_S3_BUCKET ??
    config?.storage?.s3?.bucket ??
    "paperclip";
  const storageS3Region =
    process.env.PAPERCLIP_STORAGE_S3_REGION ??
    config?.storage?.s3?.region ??
    "us-east-1";
  const storageS3Endpoint =
    process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ??
    config?.storage?.s3?.endpoint ??
    "";
  const storageS3Prefix =
    process.env.PAPERCLIP_STORAGE_S3_PREFIX ??
    config?.storage?.s3?.prefix ??
    "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE ??
    String(config?.storage?.s3?.forcePathStyle ?? false);

  const rows: EnvVarRow[] = [
    {
      key: "PAPERCLIP_AGENT_JWT_SECRET",
      value: jwtEnv ?? jwtFile ?? "",
      source: jwtSource,
      required: true,
      note:
        jwtSource === "missing"
          ? "在初始设置时生成或手动设置（本地适配器认证必需）"
          : jwtSource === "env"
            ? "已在进程环境中设置"
            : `已在 ${agentJwtEnvFile} 中设置`,
    },
    {
      key: "DATABASE_URL",
      value: dbUrl,
      source: dbUrlSource,
      required: true,
      note:
        databaseMode === "postgres"
          ? "PostgreSQL 模式已配置（必需）"
          : "使用托管 PostgreSQL 正式部署时必需",
    },
    {
      key: "PORT",
      value:
        process.env.PORT ??
        (config?.server?.port !== undefined ? String(config.server.port) : "3100"),
      source: process.env.PORT ? "env" : config?.server?.port !== undefined ? "config" : "default",
      required: false,
      note: "HTTP 监听端口",
    },
    {
      key: "PAPERCLIP_PUBLIC_URL",
      value: publicUrl,
      source: publicUrlSource,
      required: false,
      note: "认证、回调和邀请来源所使用的标准公网网址",
    },
    {
      key: "BETTER_AUTH_TRUSTED_ORIGINS",
      value: process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? trustedOriginsDefault,
      source: process.env.BETTER_AUTH_TRUSTED_ORIGINS
        ? "env"
        : trustedOriginsDefault
          ? "default"
          : "missing",
      required: false,
      note: "用逗号分隔的认证来源允许列表（可从 PAPERCLIP_PUBLIC_URL 自动推导）",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_TTL_SECONDS",
      value: process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS ?? DEFAULT_AGENT_JWT_TTL_SECONDS,
      source: process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS ? "env" : "default",
      required: false,
      note: "JWT 有效期（秒）",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_ISSUER",
      value: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? DEFAULT_AGENT_JWT_ISSUER,
      source: process.env.PAPERCLIP_AGENT_JWT_ISSUER ? "env" : "default",
      required: false,
      note: "JWT 签发方",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_AUDIENCE",
      value: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? DEFAULT_AGENT_JWT_AUDIENCE,
      source: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ? "env" : "default",
      required: false,
      note: "JWT 接收方",
    },
    {
      key: "HEARTBEAT_SCHEDULER_INTERVAL_MS",
      value: heartbeatInterval,
      source: process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ? "env" : "default",
      required: false,
      note: "心跳工作器间隔（毫秒）",
    },
    {
      key: "HEARTBEAT_SCHEDULER_ENABLED",
      value: heartbeatEnabled,
      source: process.env.HEARTBEAT_SCHEDULER_ENABLED ? "env" : "default",
      required: false,
      note: "设为 `false` 可禁用定时调度",
    },
    {
      key: "PAPERCLIP_SECRETS_PROVIDER",
      value: secretsProvider,
      source: process.env.PAPERCLIP_SECRETS_PROVIDER
        ? "env"
        : config?.secrets?.provider
          ? "config"
          : "default",
      required: false,
      note: "新密钥的默认服务商",
    },
    {
      key: "PAPERCLIP_SECRETS_STRICT_MODE",
      value: secretsStrictMode,
      source: process.env.PAPERCLIP_SECRETS_STRICT_MODE
        ? "env"
        : config?.secrets?.strictMode !== undefined
          ? "config"
          : "default",
      required: false,
      note: "敏感环境变量必须使用密钥引用",
    },
    {
      key: "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
      value: secretsKeyFilePath,
      source: process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE
        ? "env"
        : config?.secrets?.localEncrypted?.keyFilePath
          ? "config"
          : "default",
      required: false,
      note: "本地加密密钥文件路径",
    },
    {
      key: "PAPERCLIP_STORAGE_PROVIDER",
      value: storageProvider,
      source: process.env.PAPERCLIP_STORAGE_PROVIDER
        ? "env"
        : config?.storage?.provider
          ? "config"
          : "default",
      required: false,
      note: "存储服务商（local_disk 或 s3）",
    },
    {
      key: "PAPERCLIP_STORAGE_LOCAL_DIR",
      value: storageLocalDir,
      source: process.env.PAPERCLIP_STORAGE_LOCAL_DIR
        ? "env"
        : config?.storage?.localDisk?.baseDir
          ? "config"
          : "default",
      required: false,
      note: "local_disk 服务商的本地存储根目录",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_BUCKET",
      value: storageS3Bucket,
      source: process.env.PAPERCLIP_STORAGE_S3_BUCKET
        ? "env"
        : config?.storage?.s3?.bucket
          ? "config"
          : "default",
      required: false,
      note: "s3 服务商的 S3 存储桶名称",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_REGION",
      value: storageS3Region,
      source: process.env.PAPERCLIP_STORAGE_S3_REGION
        ? "env"
        : config?.storage?.s3?.region
          ? "config"
          : "default",
      required: false,
      note: "s3 服务商的 S3 区域",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_ENDPOINT",
      value: storageS3Endpoint,
      source: process.env.PAPERCLIP_STORAGE_S3_ENDPOINT
        ? "env"
        : config?.storage?.s3?.endpoint
          ? "config"
          : "default",
      required: false,
      note: "S3 兼容服务商的自定义端点（可选）",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_PREFIX",
      value: storageS3Prefix,
      source: process.env.PAPERCLIP_STORAGE_S3_PREFIX
        ? "env"
        : config?.storage?.s3?.prefix
          ? "config"
          : "default",
      required: false,
      note: "对象键前缀（可选）",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
      value: storageS3ForcePathStyle,
      source: process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE
        ? "env"
        : config?.storage?.s3?.forcePathStyle !== undefined
          ? "config"
          : "default",
      required: false,
      note: "兼容服务商使用路径样式访问时设为 true",
    },
  ];

  const defaultConfigPath = resolveConfigPath();
  if (process.env.PAPERCLIP_CONFIG || configPath !== defaultConfigPath) {
    rows.push({
      key: "PAPERCLIP_CONFIG",
      value: process.env.PAPERCLIP_CONFIG ?? configPath,
      source: process.env.PAPERCLIP_CONFIG ? "env" : "default",
      required: false,
      note: "覆盖配置文件路径（可选）",
    });
  }

  return rows;
}

function uniqueByKey(rows: EnvVarRow[]): EnvVarRow[] {
  const seen = new Set<string>();
  const result: EnvVarRow[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    result.push(row);
  }
  return result;
}

function quoteShellValue(value: string): string {
  if (value === "") return "\"\"";
  return `'${value.replaceAll("'", "'\\''")}'`;
}
