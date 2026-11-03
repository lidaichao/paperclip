import fs from "node:fs";
import path from "node:path";
import {
  MANAGED_SHIM_MARKER,
  readInstallManifest,
  resolveInstallStorePaths,
  type InstallStorePaths,
} from "../install-store.js";
import type { CheckResult } from "./index.js";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalized);
}

function hasManagedArtifacts(paths: InstallStorePaths): boolean {
  const persistentArtifacts = [
    paths.manifestPath,
    paths.markerPath,
    paths.currentPath,
    paths.shimPath,
  ].some((entry) => fs.existsSync(entry));
  if (persistentArtifacts) return true;
  try {
    return fs.readdirSync(paths.installsRoot).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

export function nodeRuntimeCheck(): CheckResult {
  return isSupportedNodeVersion(process.versions.node)
    ? { name: "Node.js 运行环境", status: "pass", message: `Node.js ${process.versions.node}` }
    : {
        name: "Node.js 运行环境",
        status: "fail",
        message: `不支持 Node.js ${process.versions.node}`,
        repairHint: `安装或运行 Alice 前，请安装 Node.js ${MINIMUM_NODE_VERSION} 或更高版本`,
      };
}

export function managedInstallChecks(
  paths = resolveInstallStorePaths(),
): CheckResult[] {
  if (!hasManagedArtifacts(paths)) {
    return [
      {
        name: "托管安装",
        status: "pass",
        message: "不存在（使用 npx、全局 npm 或源码检出时可选）",
      },
    ];
  }

  let manifest;
  try {
    manifest = readInstallManifest(paths);
  } catch (error) {
    return [
      {
        name: "托管安装清单",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
        repairHint: "请重新运行 `paperclipai install`，以重建托管安装元数据",
      },
    ];
  }

  if (!manifest) {
    return [
      {
        name: "托管安装清单",
        status: "fail",
        message: `托管安装产物存在，但缺少 ${paths.manifestPath}`,
        repairHint: "请重新运行 `paperclipai install`",
      },
    ];
  }

  const results: CheckResult[] = [];
  const payloadPath = path.resolve(manifest.payloadPath);
  const relativePayload = path.relative(paths.installsRoot, payloadPath);
  const payloadInStore = Boolean(relativePayload) && !relativePayload.startsWith("..") && !path.isAbsolute(relativePayload);
  const payloadExists = payloadInStore && fs.existsSync(payloadPath) && fs.statSync(payloadPath).isDirectory();
  let currentMatches = false;
  try {
    currentMatches = fs.lstatSync(paths.currentPath).isSymbolicLink()
      && fs.realpathSync(paths.currentPath) === fs.realpathSync(payloadPath);
  } catch {
    currentMatches = false;
  }

  results.push(
    payloadExists && currentMatches
      ? {
          name: "托管安装存储",
          status: "pass",
          message: `${manifest.source} ${manifest.version} 已启用`,
        }
      : {
          name: "托管安装存储",
          status: "fail",
          message: !payloadExists
            ? `清单中的程序缺失或位于安装存储之外：${manifest.payloadPath}`
            : `当前链接未指向 ${manifest.payloadPath}`,
          repairHint: "请重新运行 `paperclipai install`，或回滚到保留的程序版本",
        },
  );

  let shimValid = false;
  try {
    shimValid = fs.readFileSync(paths.shimPath, "utf8").includes(MANAGED_SHIM_MARKER);
  } catch {
    shimValid = false;
  }
  results.push(
    shimValid
      ? { name: "托管安装命令入口", status: "pass", message: paths.shimPath }
      : {
          name: "托管安装命令入口",
          status: "fail",
          message: `${paths.shimPath} 中的命令入口缺失或无法识别`,
          repairHint: "请重新运行 `paperclipai install`",
        },
  );

  const shimDirectory = path.dirname(paths.shimPath);
  results.push(
    pathContains(shimDirectory)
      ? { name: "托管安装 PATH", status: "pass", message: `${shimDirectory} 已加入 PATH` }
      : {
          name: "托管安装 PATH",
          status: "warn",
          message: `${shimDirectory} 未加入 PATH`,
          repairHint: '请运行 `export PATH="$HOME/.local/bin:$PATH"`，并将其加入终端启动文件',
        },
  );

  const retained = new Set(
    [manifest, ...manifest.previous].map((record) => path.resolve(record.payloadPath)),
  );
  const orphaned: string[] = [];
  for (const source of ["npm", "git"] as const) {
    const sourceRoot = path.join(paths.installsRoot, source);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of fs.readdirSync(sourceRoot)) {
      const candidate = path.join(sourceRoot, entry);
      if (!entry.startsWith(".") && !retained.has(path.resolve(candidate))) orphaned.push(candidate);
    }
  }
  results.push(
    orphaned.length === 0
      ? { name: "托管安装保留项", status: "pass", message: "没有孤立程序" }
      : {
          name: "托管安装保留项",
          status: "warn",
          message: `发现 ${orphaned.length} 个孤立程序`,
          repairHint: "成功执行 `paperclipai update` 后会清理未保留的程序",
        },
  );

  return results;
}
