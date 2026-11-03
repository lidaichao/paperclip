import { registerEmailCommands } from "./commands/client/email.js";
import { Command } from "commander";
import { warnIfUnsupportedNodeVersion } from "@paperclipai/shared/node-version";
import { onboard } from "./commands/onboard.js";
import { doctor } from "./commands/doctor.js";
import { envCommand } from "./commands/env.js";
import { channelsCommand } from "./commands/channels.js";
import { configure } from "./commands/configure.js";
import { addAllowedHostname } from "./commands/allowed-hostname.js";
import { heartbeatRun } from "./commands/heartbeat-run.js";
import { runCommand } from "./commands/run.js";
import { bootstrapCeoInvite } from "./commands/auth-bootstrap-ceo.js";
import { dbBackupCommand } from "./commands/db-backup.js";
import { dbRestoreCommand } from "./commands/db-restore.js";
import { registerEnvLabCommands } from "./commands/env-lab.js";
import { registerContextCommands } from "./commands/client/context.js";
import { registerCompanyCommands } from "./commands/client/company.js";
import { registerIssueCommands } from "./commands/client/issue.js";
import { registerAgentCommands } from "./commands/client/agent.js";
import { registerProjectCommands } from "./commands/client/project.js";
import { registerGoalCommands } from "./commands/client/goal.js";
import { registerApprovalCommands } from "./commands/client/approval.js";
import { registerActivityCommands } from "./commands/client/activity.js";
import { registerDashboardCommands } from "./commands/client/dashboard.js";
import { registerRoutineCommands } from "./commands/routines.js";
import { registerPipelineCommands } from "./commands/pipelines.js";
import { registerFeedbackCommands } from "./commands/client/feedback.js";
import { registerSecretCommands } from "./commands/client/secrets.js";
import { registerSkillsCommands } from "./commands/client/skills.js";
import { registerTeamCommands } from "./commands/client/teams.js";
import { applyDataDirOverride, type DataDirOptionLike } from "./config/data-dir.js";
import { loadPaperclipEnvFile } from "./config/env.js";
import { initTelemetryFromConfigFile, flushTelemetry } from "./telemetry.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerPluginCommands } from "./commands/client/plugin.js";
import { registerClientAuthCommands } from "./commands/client/auth.js";
import { registerConnectCommand } from "./commands/client/connect.js";
import { registerTokenCommands } from "./commands/client/token.js";
import { registerPromptCommands } from "./commands/client/prompt.js";
import { registerRunCommands } from "./commands/client/run.js";
import { registerCostCommands } from "./commands/client/cost.js";
import { registerWorkspaceCommands } from "./commands/client/workspace.js";
import { registerAccessCommands } from "./commands/client/access.js";
import { registerRoutineApiCommands } from "./commands/client/routine-api.js";
import { registerAdapterCommands } from "./commands/client/adapter.js";
import { registerManagedAgentCommands } from "./commands/managed-agent.js";
import { registerAssetCommands } from "./commands/client/asset.js";
import { registerSkillCommands } from "./commands/client/skill.js";
import { cliVersion } from "./version.js";
import { installCommand } from "./commands/install.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { updateCommand } from "./commands/update.js";
import { registerServiceCommands } from "./commands/service.js";
import { registerConnectionIntentCommands } from "./commands/client/connections.js";
import {
  assertTestDriveDatabaseIsolation,
  prepareTestDriveEnvironment,
  redactTestDriveArgv,
  registerTestDriveCommand,
  type TestDriveOptions,
} from "./commands/test-drive.js";

const program = new Command();
const DATA_DIR_OPTION_HELP =
  "Alice 数据目录根路径（与 ~/.paperclip 中的状态隔离）";

program.enablePositionalOptions();

program
  .name("paperclipai")
  .description("Alice 命令行工具——安装、诊断并配置你的实例")
  .version(cliVersion);

program
  .command("install")
  .description("将 Alice 安装到按用户管理的命令行存储中")
  .option("--canary", "安装 npm 预览通道版本")
  .option("--version <version>", "安装指定的已发布 npm 版本")
  .option("--ref <ref>", "安装指定的 GitHub 分支、标签或提交 SHA")
  .option("--repo <owner/name>", "覆盖 --ref 使用的 GitHub 仓库")
  .option("-y, --yes", "不再询问，直接同意执行 Git 引用代码并更新受支持终端的 PATH")
  .action(installCommand);

program
  .command("uninstall")
  .description("移除托管的命令行安装，但保留用户数据")
  .action(uninstallCommand);

program
  .command("update")
  .alias("upgrade")
  .description("检查、更新或回滚 Alice 命令行工具")
  .option("--latest", "切换到最新稳定通道")
  .option("--canary", "切换到预览通道")
  .option("--version <version>", "安装指定的已发布版本")
  .option("--rollback", "切换回保留的上一版托管程序")
  .option("--check", "仅检查可用更新，不执行更新")
  .option("--dry-run", "仅打印将执行的操作，不做任何修改")
  .option("--json", "输出便于程序读取的 JSON")
  .option("-y, --yes", "确认执行明确指定的降级")
  .option("--no-backup", "跳过更新前的数据库备份")
  .action(updateCommand);

program.hook("preAction", async (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as DataDirOptionLike & TestDriveOptions;
  let dataDirOptions: DataDirOptionLike = options;
  if (actionCommand.name() === "test-drive") {
    redactTestDriveArgv(options.apiKey);
    const prepared = await prepareTestDriveEnvironment({
      dataDir: options.dataDir,
      apiKeyEnv: options.apiKeyEnv,
    });
    dataDirOptions = { ...options, dataDir: prepared.dataDir };
  }
  const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
  applyDataDirOverride(dataDirOptions, {
    hasConfigOption: optionNames.has("config"),
    hasContextOption: optionNames.has("context"),
  });
  loadPaperclipEnvFile(options.config);
  if (actionCommand.name() === "test-drive") {
    assertTestDriveDatabaseIsolation(options.config);
  }
  initTelemetryFromConfigFile(options.config);
});

registerTestDriveCommand(program);

program
  .command("onboard")
  .description("首次运行的交互式设置向导")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--bind <mode>", "快速设置的访问范围预设（loopback、lan、tailnet）")
  .option("-y, --yes", "接受快速设置默认值（除非指定 --bind，否则仅信任本机回环地址）并立即启动", false)
  .option("--install-service", "设置完成后安装并启动后台服务")
  .option("--no-install-service", "不安装也不建议安装后台服务")
  .option("--run", "保存配置后立即启动 Alice", false)
  .action(onboard);

program
  .command("doctor")
  .description("诊断 Alice 的安装与配置")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--repair", "尝试自动修复问题")
  .alias("--fix")
  .option("-y, --yes", "跳过修复确认提示")
  .action(async (opts) => {
    await doctor(opts);
  });

program
  .command("env")
  .description("输出部署所需的环境变量")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(envCommand);

program
  .command("channels")
  .description("显示发布通道以及当前安装所跟随的通道")
  .option("--json", "输出便于程序读取的 JSON")
  .action(async (opts) => {
    await channelsCommand(opts);
  });

program
  .command("configure")
  .description("更新配置项")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-s, --section <section>", "要配置的部分（llm、database、logging、server、storage、secrets）")
  .action(configure);

program
  .command("db:backup")
  .description("使用当前配置创建一次数据库备份")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--dir <path>", "备份输出目录（覆盖配置文件设置）")
  .option("--retention-days <days>", "清理备份时使用的保留天数", (value) => Number(value))
  .option("--filename-prefix <prefix>", "备份文件名前缀", "paperclip")
  .option("--json", "以 JSON 输出备份元数据")
  .action(async (opts) => {
    await dbBackupCommand(opts);
  });

program
  .command("db:restore")
  .description("验证已批准的数据库备份，或将其恢复到空目标中")
  .requiredOption("--backup <path>", "已批准的 .sql 或 .sql.gz 备份文件")
  .requiredOption("--expected-sha256 <sha256>", "已批准备份的 SHA-256")
  .option("-c, --config <path>", "目标配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--secrets-key-file <path>", "与备份匹配的本地加密密钥主文件")
  .option("--expected-secrets-key-sha256 <sha256>", "已批准密钥文件的 SHA-256")
  .option("--expected-company-id <uuid>", "恢复后必须存在的公司")
  .option("--apply", "预检后执行恢复；默认仅试运行")
  .option("-y, --yes", "确认将已批准备份恢复到空目标中（破坏性操作）")
  .option("--json", "输出便于程序读取的验证证据")
  .action(async (opts) => {
    await dbRestoreCommand(opts);
  });

program
  .command("allowed-hostname")
  .description("允许指定主机名访问认证/私有模式实例")
  .argument("<host>", "要允许的主机名（例如 dotta-macbook-pro）")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(addAllowedHostname);

const run = program
  .command("run")
  .description("完成本地初始化（设置 + 诊断）并运行 Alice")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-i, --instance <id>", "本地实例编号（默认：default）")
  .option("--bind <mode>", "首次运行时使用访问范围预设（loopback、lan、tailnet）")
  .option("--repair", "诊断时尝试自动修复", true)
  .option("--no-repair", "诊断时禁止自动修复")
  .option("--force", "即使服务管理器中已有同一实例在运行，也强制启动")
  .action(runCommand);

registerRunCommands(run);
registerServiceCommands(program);

const heartbeat = program.command("heartbeat").description("智能体心跳工具");

heartbeat
  .command("run")
  .description("执行一次智能体心跳并持续输出实时日志")
  .requiredOption("-a, --agent-id <agentId>", "要唤醒的智能体编号")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--context <path>", "命令行上下文文件路径")
  .option("--profile <name>", "命令行上下文配置名称")
  .option("--api-base <url>", "Alice 服务端 API 的基础地址")
  .option("--api-key <token>", "用于智能体认证调用的 Bearer 令牌")
  .option(
    "--source <source>",
    "唤醒来源（timer | assignment | on_demand | automation）",
    "on_demand",
  )
  .option("--trigger <trigger>", "触发方式（manual | ping | callback | system）", "manual")
  .option("--timeout-ms <ms>", "放弃前的最长等待时间", "0")
  .option("--json", "适用时输出原始 JSON")
  .option("--debug", "显示适配器标准输出/错误输出中的原始 JSON 数据块")
  .action(heartbeatRun);

registerContextCommands(program);
registerConnectCommand(program);
registerConnectionIntentCommands(program);
registerEmailCommands(program);
registerCompanyCommands(program);
registerIssueCommands(program);
registerAgentCommands(program);
registerProjectCommands(program);
registerGoalCommands(program);
registerTokenCommands(program);
registerPromptCommands(program);
registerApprovalCommands(program);
registerActivityCommands(program);
registerDashboardCommands(program);
registerCostCommands(program);
registerWorkspaceCommands(program);
registerAccessCommands(program);
registerRoutineApiCommands(program);
registerAdapterCommands(program);
registerManagedAgentCommands(program);
registerAssetCommands(program);
registerSkillCommands(program);
registerRoutineCommands(program);
registerPipelineCommands(program);
registerFeedbackCommands(program);
registerSecretCommands(program);
registerSkillsCommands(program);
registerTeamCommands(program);
registerWorktreeCommands(program);
registerEnvLabCommands(program);
registerPluginCommands(program);

const auth = program.command("auth").description("认证与初始化工具");

auth
  .command("bootstrap-ceo")
  .description("为实例的首位管理员创建一次性初始化邀请链接")
  .option("-c, --config <path>", "配置文件路径")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--force", "即使管理员已存在，也创建新邀请", false)
  .option("--expires-hours <hours>", "邀请有效时长（小时）", (value) => Number(value))
  .option("--base-url <url>", "生成邀请链接时使用的公开基础地址")
  .action(bootstrapCeoInvite);

registerClientAuthCommands(auth);

async function main(): Promise<void> {
  warnIfUnsupportedNodeVersion(process.versions.node, (message) => console.warn(message));

  let failed = false;
  try {
    await program.parseAsync();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await flushTelemetry();
  }

  if (failed) {
    process.exit(1);
  }
}

void main();
