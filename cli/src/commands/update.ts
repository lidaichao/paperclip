import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { assertManagedShimWritable, writeManagedShim, buildNextManifest, flipCurrentAtomic, isManagedExecutable, pruneInstallPayloads, readInstallManifest, resolveInstallStorePaths, withInstallStoreLock, writeInstallManifestAtomic, type InstallChannel, type InstallManifest, type InstallRecord, type InstallStorePaths } from "../install-store.js";
import { dbBackupCommand } from "./db-backup.js";
import { assertSupportedNodeVersion, installGitPayload, installNpmPayload, PUBLIC_NPM_REGISTRY, resolveGitHubRef, resolvePublishedVersion, type CommandRunner } from "./install.js";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../config/home.js";
import { resolveConfigPath } from "../config/store.js";
import { detectServiceManager } from "../services/service-manager.js";
import { restartManagedService } from "./service.js";
import { packageVersion } from "../version.js";

const execFileAsync = promisify(execFile);
export type InstallMode = "managed" | "global-npm" | "npx" | "source" | "unknown";
export type UpdateOptions = { canary?: boolean; latest?: boolean; version?: string; rollback?: boolean; check?: boolean; dryRun?: boolean; json?: boolean; yes?: boolean; backup?: boolean };
type Dependencies = { executablePath: string; runCommand: CommandRunner; backup: () => Promise<void>; confirm: (message: string) => Promise<boolean>; now: () => Date; paths: InstallStorePaths; restartActiveService: (expectedVersion: string) => Promise<boolean>; hasInstanceData: () => boolean };

const DATABASE_UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

function hasPaperclipInstanceData(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
    || fs.existsSync(resolveConfigPath())
    || fs.existsSync(resolvePaperclipInstanceRoot());
}

function isDatabaseUnreachableError(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      if (/\b(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b|connection refused/i.test(current)) return true;
      continue;
    }
    if (typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && DATABASE_UNREACHABLE_CODES.has(record.code)) return true;
    if (typeof record.message === "string" && /\b(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b|connection refused/i.test(record.message)) return true;
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
}

async function runPreUpdateBackup(options: UpdateOptions, backup: () => Promise<void>, hasInstanceData = hasPaperclipInstanceData): Promise<void> {
  if (!hasInstanceData()) {
    const message = "当前 Alice 实例尚未完成初始化，没有需要备份的数据，已跳过更新前备份。";
    if (options.json) console.error(message); else console.log(pc.yellow(message));
    return;
  }
  try {
    await backup();
  } catch (error) {
    if (isDatabaseUnreachableError(error)) {
      throw new Error(
        "Alice 数据库未运行或无法访问，因此无法执行更新前备份。请使用 `paperclipai service start` 启动服务后重试，或使用 `paperclipai update --no-backup` 跳过备份。",
        { cause: error },
      );
    }
    throw error;
  }
}

async function restartActiveManagedService(expectedVersion: string): Promise<boolean> {
  const instanceId = resolvePaperclipInstanceId();
  const detection = await detectServiceManager({ instanceId });
  if (!detection.supported || !(await detection.manager.status()).active) return false;
  await restartManagedService({ instanceId, expectedVersion });
  return true;
}

export function detectInstallMode(executablePath = process.argv[1] ?? "", paths = resolveInstallStorePaths()): InstallMode {
  const resolved = path.resolve(executablePath || ".");
  const manifest = readInstallManifest(paths);
  if (manifest && isManagedExecutable(resolved, manifest, paths)) return "managed";
  const normalized = resolved.split(path.sep).join("/");
  if (normalized.includes("/.npm/_npx/") || normalized.includes("/node_modules/.cache/npx/")) return "npx";
  if (normalized.includes("/node_modules/paperclipai/")) return "global-npm";
  let cursor = path.dirname(resolved);
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) return "source";
    cursor = path.dirname(cursor);
  }
  return "unknown";
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => { const [core, prerelease = ""] = value.replace(/^v/, "").split("-", 2); return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease }; };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) { const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0); if (delta !== 0) return Math.sign(delta); }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const leftPart = aParts[index];
    const rightPart = bParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function resolveUpdateRequest(manifest: InstallManifest | null, options: Pick<UpdateOptions, "canary" | "latest" | "version">): { spec: string; channel: InstallChannel; explicit: boolean } {
  const selected = Number(Boolean(options.canary)) + Number(Boolean(options.latest)) + Number(Boolean(options.version));
  if (selected > 1) throw new Error("--latest、--canary 和 --version 只能选择一个。");
  if (options.version) return { spec: options.version.trim(), channel: "pinned", explicit: true };
  if (options.canary) return { spec: "canary", channel: "canary", explicit: true };
  if (options.latest) return { spec: "latest", channel: "latest", explicit: true };
  if (manifest?.channel === "pinned") return { spec: manifest.version, channel: "pinned", explicit: false };
  const channel = manifest?.channel === "canary" ? "canary" : "latest";
  return { spec: channel, channel, explicit: false };
}

export function rollbackManagedInstall(paths = resolveInstallStorePaths()): InstallManifest {
  const manifest = readInstallManifest(paths);
  if (!manifest) throw new Error("未找到可回滚的托管安装。");
  const target = manifest.previous[0];
  if (!target) throw new Error("没有可用于回滚的上一版托管程序。");
  if (!fs.existsSync(target.payloadPath)) throw new Error(`上一版程序缺失：${target.payloadPath}`);
  const current: InstallRecord = { source: manifest.source, version: manifest.version, channel: manifest.channel, payloadPath: manifest.payloadPath, repo: manifest.repo, ref: manifest.ref, sha: manifest.sha, installedAt: manifest.installedAt };
  const next: InstallManifest = { schemaVersion: manifest.schemaVersion, ...target, previous: [current, ...manifest.previous.slice(1)].slice(0, 2) };
  const oldTarget = fs.readlinkSync(paths.currentPath);
  flipCurrentAtomic(target.payloadPath, paths);
  try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
  return next;
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await p.confirm({ message, initialValue: false });
  return !p.isCancel(answer) && answer === true;
}
function emit(options: UpdateOptions, value: Record<string, unknown>, message: string): void { if (options.json) console.log(JSON.stringify(value, null, 2)); else console.log(message); }

async function rollbackAfterServiceValidationFailure(
  paths: InstallStorePaths,
  restartActiveService: (expectedVersion: string) => Promise<boolean>,
  validationError: unknown,
  payloadLabel: string,
): Promise<never> {
  const rolledBack = await withInstallStoreLock(async () => rollbackManagedInstall(paths), paths);
  try {
    await restartActiveService(rolledBack.version);
  } catch (restartError) {
    throw new Error(
      `${payloadLabel}未通过服务验证，已回滚到 ${rolledBack.version}，但回滚后的服务也无法重启。`,
      { cause: new AggregateError([validationError, restartError]) },
    );
  }
  throw new Error(`${payloadLabel}未通过服务验证，已回滚到 ${rolledBack.version}。`, { cause: validationError });
}

export async function updateCommand(options: UpdateOptions, overrides: Partial<Dependencies> = {}): Promise<void> {
  const paths = overrides.paths ?? resolveInstallStorePaths();
  const executablePath = overrides.executablePath ?? process.argv[1] ?? "";
  const runCommand = overrides.runCommand ?? execFileAsync;
  const mode = detectInstallMode(executablePath, paths);
  const manifest = readInstallManifest(paths);
  if (options.rollback) {
    if (mode !== "managed") throw new Error("--rollback 仅适用于托管安装。");
    if (options.dryRun) { emit(options, { mode, action: "rollback", dryRun: true, target: manifest?.previous[0]?.version ?? null }, `将回滚到 ${manifest?.previous[0]?.version ?? "上一版程序"}。`); return; }
    const next = await withInstallStoreLock(async () => rollbackManagedInstall(paths), paths);
    const restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(next.version);
    emit(options, { mode, action: "rollback", version: next.version, restarted }, pc.green(`已回滚到 paperclipai ${next.version}${restarted ? "，并重启正在运行的服务" : ""}。数据库迁移不会自动回退；如有需要，请恢复更新前备份。`));
    return;
  }
  if (mode === "npx") { emit(options, { mode, action: "install" }, "这是临时 npx 安装。请先运行 `paperclipai install`，再通过托管命令入口使用 `paperclipai update`。"); return; }
  if (mode === "source" || mode === "unknown") { emit(options, { mode, action: "manual" }, "这似乎是源码检出。请依次运行 `git pull` 和 `pnpm install` 更新；Alice 不会修改该仓库。"); return; }
  if (!options.check && !options.dryRun) assertSupportedNodeVersion();
  const request = resolveUpdateRequest(mode === "managed" ? manifest : null, options);
  if (mode === "managed" && manifest?.source === "git") {
    if (!manifest.repo || !manifest.ref || !manifest.sha) throw new Error("托管 Git 安装的元数据不完整。");
    if (/^[0-9a-f]{7,40}$/i.test(manifest.ref)) { emit(options, { mode, source: "git", pinned: true, sha: manifest.sha }, `Git 安装已固定在 ${manifest.sha.slice(0, 12)}。`); return; }
    const targetSha = await resolveGitHubRef(manifest.repo, manifest.ref, runCommand);
    if (targetSha === manifest.sha) { emit(options, { mode, source: "git", changed: false, sha: targetSha, ref: manifest.ref }, `${manifest.repo}@${manifest.ref} 已是 ${targetSha.slice(0, 12)}。`); return; }
    if (options.check || options.dryRun) { emit(options, { mode, source: "git", changed: true, currentSha: manifest.sha, targetSha, ref: manifest.ref, dryRun: Boolean(options.dryRun) }, `有可用的 Git 更新：${manifest.sha.slice(0, 12)} → ${targetSha.slice(0, 12)}。`); if (options.check) process.exitCode = 10; return; }
    if (options.yes !== true) {
      const confirmed = await (overrides.confirm ?? defaultConfirm)(`是否从 ${manifest.repo}@${manifest.ref} 更新，并执行提交 ${targetSha.slice(0, 12)} 中的构建脚本？`);
      if (!confirmed) throw new Error("Git 更新已取消。如要确认执行更新后提交中的构建脚本，请使用 --yes 重新运行。");
    }
    if (options.backup !== false) await runPreUpdateBackup(options, overrides.backup ?? (() => dbBackupCommand({})), overrides.hasInstanceData);
    const installed = await withInstallStoreLock(async () => {
      assertManagedShimWritable(paths);
      const payload = await installGitPayload(manifest.repo!, targetSha, runCommand, paths);
      writeManagedShim(paths);
      const record: InstallRecord = { source: "git", version: payload.version, channel: "pinned", repo: manifest.repo, ref: manifest.ref, sha: targetSha, payloadPath: payload.payloadPath, installedAt: (overrides.now?.() ?? new Date()).toISOString() };
      const next = buildNextManifest(record, manifest); const oldTarget = fs.readlinkSync(paths.currentPath); flipCurrentAtomic(payload.payloadPath, paths);
      try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
      pruneInstallPayloads(next, paths); return payload;
    }, paths);
    let restarted: boolean;
    try {
      restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(installed.version);
    } catch (error) {
      return rollbackAfterServiceValidationFailure(
        paths,
        overrides.restartActiveService ?? restartActiveManagedService,
        error,
        "已更新 Git 程序",
      );
    }
    emit(options, { mode, source: "git", changed: true, currentSha: manifest.sha, targetSha, reused: installed.reused, restarted }, pc.yellow(`已从 ${manifest.repo}@${manifest.ref} 更新未发布的 Git 程序 ${manifest.sha.slice(0, 12)} → ${targetSha.slice(0, 12)}${restarted ? "，并重启正在运行的服务" : ""}。`));
    return;
  }
  const targetVersion = await resolvePublishedVersion(request.spec, runCommand);
  const currentVersion = manifest?.version ?? (mode === "global-npm" ? packageVersion : undefined);
  const comparison = currentVersion ? compareVersions(targetVersion, currentVersion) : 1;
  if (options.check) { emit(options, { mode, currentVersion: currentVersion ?? null, targetVersion, updateAvailable: comparison > 0, downgrade: comparison < 0, channel: request.channel }, comparison > 0 ? `有可用更新：${targetVersion}` : comparison < 0 ? `目标版本 ${targetVersion} 低于当前版本 ${currentVersion}。` : `paperclipai ${targetVersion} 已是当前版本。`); if (comparison > 0) process.exitCode = 10; return; }
  if (mode === "global-npm") {
    if (comparison < 0 && options.yes !== true) { const confirmed = await (overrides.confirm ?? defaultConfirm)(`是否将 paperclipai 从 ${currentVersion} 降级到 ${targetVersion}？`); if (!confirmed) throw new Error("降级已取消。如要明确确认，请使用 --yes 重新运行。"); }
    const args = ["install", "-g", `paperclipai@${targetVersion}`, `--registry=${PUBLIC_NPM_REGISTRY}`, `--@paperclipai:registry=${PUBLIC_NPM_REGISTRY}`]; console.log(`正在运行：npm ${args.join(" ")}`);
    if (!options.dryRun) {
      const npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-npm-"));
      const npmUserConfigPath = path.join(npmConfigDir, "npmrc");
      try {
        fs.writeFileSync(npmUserConfigPath, `registry=${PUBLIC_NPM_REGISTRY}\n@paperclipai:registry=${PUBLIC_NPM_REGISTRY}\n`, { mode: 0o600 });
        await runCommand("npm", args, {
          env: {
            ...process.env,
            npm_config_registry: PUBLIC_NPM_REGISTRY,
            NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
            npm_config_userconfig: npmUserConfigPath,
            NPM_CONFIG_USERCONFIG: npmUserConfigPath,
          },
          maxBuffer: 16 * 1024 * 1024,
        });
      } finally {
        fs.rmSync(npmConfigDir, { recursive: true, force: true });
      }
    }
    emit(options, { mode, action: "update", targetVersion, dryRun: Boolean(options.dryRun), command: ["npm", ...args] }, options.dryRun ? "试运行完成。" : pc.green(`已将全局 npm 安装更新到 ${targetVersion}。`)); return;
  }
  if (!manifest) throw new Error("托管安装元数据缺失。");
  if (comparison === 0) { emit(options, { mode, currentVersion, targetVersion, changed: false }, `paperclipai ${targetVersion} 已处于启用状态。`); return; }
  if (comparison < 0 && options.yes !== true) { const confirmed = await (overrides.confirm ?? defaultConfirm)(`是否将 paperclipai 从 ${currentVersion} 降级到 ${targetVersion}？`); if (!confirmed) throw new Error("降级已取消。如要明确确认，请使用 --yes 重新运行。"); }
  if (options.dryRun) { emit(options, { mode, currentVersion, targetVersion, action: comparison < 0 ? "downgrade" : "update", backup: options.backup !== false, dryRun: true }, `将${comparison < 0 ? "降级" : "更新"} paperclipai ${currentVersion} → ${targetVersion}${options.backup === false ? "，不执行备份" : "，先执行数据库备份"}。`); return; }
  if (options.backup !== false) await runPreUpdateBackup(options, overrides.backup ?? (() => dbBackupCommand({})), overrides.hasInstanceData);
  const installed = await withInstallStoreLock(async () => {
    assertManagedShimWritable(paths);
    const payload = await installNpmPayload(targetVersion, runCommand, paths);
    writeManagedShim(paths);
    const record: InstallRecord = { source: "npm", version: targetVersion, channel: request.channel, payloadPath: payload.payloadPath, installedAt: (overrides.now?.() ?? new Date()).toISOString() };
    const next = buildNextManifest(record, manifest); const oldTarget = fs.readlinkSync(paths.currentPath); flipCurrentAtomic(payload.payloadPath, paths);
    try { writeInstallManifestAtomic(next, paths); } catch (error) { flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); throw error; }
    pruneInstallPayloads(next, paths); return payload;
  }, paths);
  let restarted: boolean;
  try {
    restarted = await (overrides.restartActiveService ?? restartActiveManagedService)(targetVersion);
  } catch (error) {
    return rollbackAfterServiceValidationFailure(
      paths,
      overrides.restartActiveService ?? restartActiveManagedService,
      error,
      "已更新程序",
    );
  }
  emit(options, { mode, currentVersion, targetVersion, changed: true, reused: installed.reused, restarted }, pc.green(`已更新 paperclipai ${currentVersion} → ${targetVersion}${restarted ? "，并重启正在运行的服务" : ""}。如需立即回滚程序，请运行 \`paperclipai update --rollback\`。`));
}
