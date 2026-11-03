import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

const AWS_CREDENTIAL_SOURCE_HINT =
  "请通过 AWS SDK 默认凭据链提供 AWS 运行时凭据：IAM 角色/工作负载身份、AWS_PROFILE/SSO/共享凭据、Web 身份、容器/实例元数据，或短期终端凭据";

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

function withStrictModeNote(
  base: Pick<CheckResult, "name" | "status" | "message" | "canRepair" | "repair" | "repairHint">,
  config: PaperclipConfig,
): CheckResult {
  const strictModeDisabledInDeployedSetup =
    config.database.mode === "postgres" && config.secrets.strictMode === false;
  if (!strictModeDisabledInDeployedSetup) return base;

  if (base.status === "fail") return base;
  return {
    ...base,
    status: "warn",
    message: `${base.message}；PostgreSQL 部署已关闭严格密钥模式`,
    repairHint: base.repairHint
      ? `${base.repairHint}。建议启用 secrets.strictMode`
      : "建议启用 secrets.strictMode",
  };
}

export function secretsCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const provider = config.secrets.provider;
  if (provider === "aws_secrets_manager") {
    return withStrictModeNote(awsSecretsManagerCheck(), config);
  }
  if (provider !== "local_encrypted") {
    return {
      name: "密钥适配器",
      status: "fail",
      message: `已配置 ${provider}，但此版本仅支持 local_encrypted 和 aws_secrets_manager`,
      canRepair: false,
      repairHint: "请运行 `paperclipai configure --section secrets`，并选择 local_encrypted 或 aws_secrets_manager",
    };
  }

  const envMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envMasterKey && envMasterKey.trim().length > 0) {
    if (!decodeMasterKey(envMasterKey)) {
      return {
        name: "密钥适配器",
        status: "fail",
        message:
          "PAPERCLIP_SECRETS_MASTER_KEY 无效（应为 32 字节 Base64、64 位十六进制或原始 32 字符字符串）",
        canRepair: false,
        repairHint: "请将 PAPERCLIP_SECRETS_MASTER_KEY 设置为有效密钥，或取消设置以使用密钥文件",
      };
    }

    return withStrictModeNote(
      {
        name: "密钥适配器",
        status: "pass",
        message: "已通过 PAPERCLIP_SECRETS_MASTER_KEY 配置本地加密服务商",
      },
      config,
    );
  }

  const keyFileOverride = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const configuredPath =
    keyFileOverride && keyFileOverride.trim().length > 0
      ? keyFileOverride.trim()
      : config.secrets.localEncrypted.keyFilePath;
  const keyFilePath = resolveRuntimeLikePath(configuredPath, configPath);

  if (!fs.existsSync(keyFilePath)) {
    return withStrictModeNote(
      {
        name: "密钥适配器",
        status: "warn",
        message: `密钥文件尚不存在：${keyFilePath}`,
        canRepair: true,
        repair: () => {
          fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
          fs.writeFileSync(keyFilePath, randomBytes(32).toString("base64"), {
            encoding: "utf8",
            mode: 0o600,
          });
          try {
            fs.chmodSync(keyFilePath, 0o600);
          } catch {
            // best effort
          }
        },
        repairHint: "请使用 --repair 运行，以创建本地加密密钥文件",
      },
      config,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(keyFilePath, "utf8");
  } catch (err) {
    return {
      name: "密钥适配器",
      status: "fail",
      message: `无法读取密钥文件：${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "请检查文件权限，或设置 PAPERCLIP_SECRETS_MASTER_KEY",
    };
  }

  if (!decodeMasterKey(raw)) {
    return {
      name: "密钥适配器",
      status: "fail",
      message: `${keyFilePath} 中的密钥材料无效`,
      canRepair: false,
      repairHint: "请替换为有效密钥材料，或删除该文件后运行 doctor --repair",
    };
  }

  const keyMode = fs.statSync(keyFilePath).mode & 0o777;
  const permissionWarning =
    (keyMode & 0o077) !== 0
      ? `；密钥文件权限为 ${keyMode.toString(8)}（请运行 chmod 600 ${keyFilePath}）`
      : "";

  return withStrictModeNote(
    {
      name: "密钥适配器",
      status: permissionWarning ? "warn" : "pass",
      message: `已使用密钥文件 ${keyFilePath} 配置本地加密服务商${permissionWarning}`,
      repairHint: permissionWarning
        ? "请将本地加密密钥文件限制为仅所有者可读写"
        : undefined,
    },
    config,
  );
}

function awsSecretsManagerCheck(): CheckResult {
  const missingConfig = missingAwsSecretsManagerConfig();
  if (missingConfig.length > 0) {
    return {
      name: "密钥适配器",
      status: "fail",
      message: `AWS Secrets Manager 服务商缺少非敏感配置：${missingConfig.join(", ")}`,
      canRepair: false,
      repairHint:
        `请在 Alice 服务运行环境中设置 ${missingConfig.join(", ")}。${AWS_CREDENTIAL_SOURCE_HINT}。不要在 Alice 密钥中存储 AWS 根凭据或长期 IAM 用户密钥。`,
    };
  }

  const staticEnvCredentials =
    process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const credentialSource = detectedAwsCredentialSources().join(", ");
  const message =
    `已为部署 ${process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID} 配置 AWS Secrets Manager 服务商；` +
    `运行时凭据来源：${credentialSource || "AWS SDK 默认凭据链"}`;

  if (staticEnvCredentials) {
    return {
      name: "密钥适配器",
      status: "warn",
      message,
      canRepair: false,
      repairHint:
        "检测到 AWS 静态环境凭据。本地仅使用短期终端凭据；托管部署优先使用 IAM 角色/工作负载身份，并且绝不要在 Alice 公司密钥中存储 AWS 访问密钥。",
    };
  }

  return {
    name: "密钥适配器",
    status: "pass",
    message,
  };
}

function missingAwsSecretsManagerConfig(): string[] {
  const missing: string[] = [];
  if (
    !(
      process.env.PAPERCLIP_SECRETS_AWS_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim()
    )
  ) {
    missing.push("PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION");
  }
  if (!process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim()) {
    missing.push("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
  }
  if (!process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim()) {
    missing.push("PAPERCLIP_SECRETS_AWS_KMS_KEY_ID");
  }
  return missing;
}

function detectedAwsCredentialSources(): string[] {
  const sources: string[] = [];
  if (process.env.AWS_PROFILE?.trim()) sources.push("AWS_PROFILE/共享配置");
  if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
    sources.push("临时 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY 环境凭据");
  }
  if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim() && process.env.AWS_ROLE_ARN?.trim()) {
    sources.push("AWS Web 身份令牌");
  }
  if (
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim() ||
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  ) {
    sources.push("AWS 容器凭据端点");
  }
  if (process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || process.env.AWS_CONFIG_FILE?.trim()) {
    sources.push("自定义 AWS 共享凭据/配置文件");
  }
  return sources;
}
