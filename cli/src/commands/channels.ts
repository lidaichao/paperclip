import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";
import { resolvePublishedVersion, type CommandRunner } from "./install.js";
import { packageVersion } from "../version.js";

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = (command, args, options) =>
  execFileAsync(command, args, { ...options, encoding: "utf8" });

export type ChannelName = "stable" | "beta" | "nightly" | "canary";

export type ChannelDescriptor = {
  channel: ChannelName;
  distTag: string;
  cadence: string;
  audience: string;
};

// Ordered from most to least stable — the order users should consider them.
export const RELEASE_CHANNELS: readonly ChannelDescriptor[] = [
  {
    channel: "stable",
    distTag: "latest",
    cadence: "手动发布，已在 beta 通道验证至少 3 天",
    audience: "适合绝大多数用户的推荐版本",
  },
  {
    channel: "beta",
    distTag: "beta",
    cadence: "通过审批门禁后手动晋级",
    audience: "候选版本：通常会在数天后成为 stable",
  },
  {
    channel: "nightly",
    distTag: "nightly",
    cadence: "每晚一次，通过冒烟测试门禁",
    audience: "将前一天合并的更改作为整体进行测试",
  },
  {
    channel: "canary",
    distTag: "canary",
    cadence: "每次合并到 master 后发布",
    audience: "最新但风险最高的版本",
  },
];

const CALVER_RE = /^\d{4}\.\d{1,4}\.\d+$/;
const PRERELEASE_RE = /^\d{4}\.\d{1,4}\.\d+-(canary|nightly|beta)\.\d+$/;

// Published versions carry their lane in the version string; the source
// checkout's package.json holds a placeholder that matches neither form.
export function channelForVersion(version: string): ChannelName | "unknown" {
  const prerelease = version.match(PRERELEASE_RE);
  if (prerelease) return prerelease[1] as ChannelName;
  if (CALVER_RE.test(version)) return "stable";
  return "unknown";
}

export type ChannelState = ChannelDescriptor & { version: string | null };

export async function collectChannelState(
  runCommand: CommandRunner = defaultRunCommand,
): Promise<ChannelState[]> {
  const resolved = await Promise.allSettled(
    RELEASE_CHANNELS.map((entry) => resolvePublishedVersion(entry.distTag, runCommand)),
  );
  return RELEASE_CHANNELS.map((entry, index) => {
    const outcome = resolved[index];
    return {
      ...entry,
      version: outcome.status === "fulfilled" ? outcome.value : null,
    };
  });
}

export type ChannelsOptions = { json?: boolean };

export async function channelsCommand(
  options: ChannelsOptions = {},
  runCommand: CommandRunner = defaultRunCommand,
): Promise<void> {
  const state = await collectChannelState(runCommand);
  const currentChannel = channelForVersion(packageVersion);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          current: { version: packageVersion, channel: currentChannel },
          channels: state,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(pc.bold("Alice 发布通道"));
  console.log("");
  for (const entry of state) {
    const version = entry.version ?? pc.yellow("不可用");
    console.log(`  ${pc.bold(entry.channel.padEnd(8))} ${version}`);
    console.log(`  ${" ".repeat(8)} ${pc.dim(`${entry.cadence} — ${entry.audience}`)}`);
    console.log(`  ${" ".repeat(8)} ${pc.dim(`npx paperclipai@${entry.distTag} onboard`)}`);
    console.log("");
  }

  if (currentChannel === "unknown") {
    console.log(
      `当前安装报告的版本为 ${pc.bold(packageVersion)}，无法映射到已发布通道（源码检出会报告仓库占位版本）。`,
    );
  } else {
    console.log(`当前安装版本为 ${pc.bold(packageVersion)}，位于 ${pc.bold(currentChannel)} 通道。`);
  }
  console.log(`Docker 镜像使用相同标签：ghcr.io/paperclipai/paperclip:{latest,beta,nightly,canary}`);
}
