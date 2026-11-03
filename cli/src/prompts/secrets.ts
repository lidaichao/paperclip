import * as p from "@clack/prompts";
import type { SecretProvider } from "@paperclipai/shared";
import type { SecretsConfig } from "../config/schema.js";
import { resolveDefaultSecretsKeyFilePath, resolvePaperclipInstanceId } from "../config/home.js";

function defaultKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolvePaperclipInstanceId());
}

export function defaultSecretsConfig(): SecretsConfig {
  const keyFilePath = defaultKeyFilePath();
  return {
    provider: "local_encrypted",
    strictMode: false,
    localEncrypted: {
      keyFilePath,
    },
  };
}

export async function promptSecrets(current?: SecretsConfig): Promise<SecretsConfig> {
  const base = current ?? defaultSecretsConfig();

  const provider = await p.select({
    message: "密钥服务商",
    options: [
      {
        value: "local_encrypted" as const,
        label: "本地加密（推荐）",
        hint: "适合单开发者安装",
      },
      {
        value: "aws_secrets_manager" as const,
        label: "AWS Secrets Manager",
        hint: "需要运行时 AWS 凭据和服务商环境配置",
      },
      {
        value: "gcp_secret_manager" as const,
        label: "GCP Secret Manager",
        hint: "需要集成外部适配器",
      },
      {
        value: "vault" as const,
        label: "HashiCorp Vault",
        hint: "需要集成外部适配器",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const strictMode = await p.confirm({
    message: "敏感环境变量是否必须使用密钥引用？",
    initialValue: base.strictMode,
  });

  if (p.isCancel(strictMode)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const fallbackDefault = defaultKeyFilePath();
  let keyFilePath = base.localEncrypted.keyFilePath || fallbackDefault;
  if (provider === "local_encrypted") {
    const keyPath = await p.text({
      message: "本地加密密钥文件路径",
      defaultValue: keyFilePath,
      placeholder: fallbackDefault,
      validate: (value) => {
        // Clack validates the raw input before applying defaultValue —
        // validate the value that will actually be submitted.
        if ((value || keyFilePath).trim().length === 0) return "必须填写密钥文件路径";
      },
    });

    if (p.isCancel(keyPath)) {
      p.cancel("已取消设置。");
      process.exit(0);
    }
    keyFilePath = keyPath.trim();
  }

  if (provider !== "local_encrypted") {
    p.note(
      provider === "aws_secrets_manager"
        ? "AWS 凭据必须来自 Alice 服务器运行环境（IAM 角色/工作负载身份、AWS_PROFILE/SSO/共享凭据或短期终端环境变量），不能来自 Alice 公司密钥。"
        : `此版本尚未完整接入 ${provider}。除非正在开发对应适配器，否则请继续使用 local_encrypted。`,
      "注意",
    );
  }

  return {
    provider: provider as SecretProvider,
    strictMode,
    localEncrypted: {
      keyFilePath,
    },
  };
}
