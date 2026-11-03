import * as p from "@clack/prompts";
import type { StorageConfig } from "../config/schema.js";
import { resolveDefaultStorageDir, resolvePaperclipInstanceId } from "../config/home.js";

function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export function defaultStorageConfig(): StorageConfig {
  return {
    provider: "local_disk",
    localDisk: {
      baseDir: defaultStorageBaseDir(),
    },
    s3: {
      bucket: "paperclip",
      region: "us-east-1",
      endpoint: undefined,
      prefix: "",
      forcePathStyle: false,
    },
  };
}

export async function promptStorage(current?: StorageConfig): Promise<StorageConfig> {
  const base = current ?? defaultStorageConfig();

  const provider = await p.select({
    message: "存储服务商",
    options: [
      {
        value: "local_disk" as const,
        label: "本地磁盘（推荐）",
        hint: "适合单用户本地部署",
      },
      {
        value: "s3" as const,
        label: "S3 兼容存储",
        hint: "适合云端或对象存储后端",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  if (provider === "local_disk") {
    const baseDirDefault = base.localDisk.baseDir || defaultStorageBaseDir();
    const baseDir = await p.text({
      message: "本地存储根目录",
      defaultValue: baseDirDefault,
      placeholder: defaultStorageBaseDir(),
      validate: (value) => {
        // Clack validates the raw input before applying defaultValue —
        // validate the value that will actually be submitted.
        if ((value || baseDirDefault).trim().length === 0) return "必须填写存储根目录";
      },
    });

    if (p.isCancel(baseDir)) {
      p.cancel("已取消设置。");
      process.exit(0);
    }

    return {
      provider: "local_disk",
      localDisk: {
        baseDir: baseDir.trim(),
      },
      s3: base.s3,
    };
  }

  const bucketDefault = base.s3.bucket || "paperclip";
  const regionDefault = base.s3.region || "us-east-1";
  const bucket = await p.text({
    message: "S3 存储桶",
    defaultValue: bucketDefault,
    placeholder: "paperclip",
    validate: (value) => {
      if ((value || bucketDefault).trim().length === 0) return "必须填写存储桶";
    },
  });

  if (p.isCancel(bucket)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const region = await p.text({
    message: "S3 区域",
    defaultValue: regionDefault,
    placeholder: "us-east-1",
    validate: (value) => {
      if ((value || regionDefault).trim().length === 0) return "必须填写区域";
    },
  });

  if (p.isCancel(region)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const endpoint = await p.text({
    message: "S3 端点（兼容后端可选）",
    defaultValue: base.s3.endpoint ?? "",
    placeholder: "https://s3.amazonaws.com",
  });

  if (p.isCancel(endpoint)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const prefix = await p.text({
    message: "对象键前缀（可选）",
    defaultValue: base.s3.prefix ?? "",
    placeholder: "paperclip/",
  });

  if (p.isCancel(prefix)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  const forcePathStyle = await p.confirm({
    message: "是否使用 S3 路径样式网址？",
    initialValue: base.s3.forcePathStyle ?? false,
  });

  if (p.isCancel(forcePathStyle)) {
    p.cancel("已取消设置。");
    process.exit(0);
  }

  return {
    provider: "s3",
    localDisk: base.localDisk,
    s3: {
      bucket: bucket.trim(),
      region: region.trim(),
      endpoint: endpoint.trim() || undefined,
      prefix: prefix.trim(),
      forcePathStyle,
    },
  };
}

