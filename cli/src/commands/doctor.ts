import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import {
  agentJwtSecretCheck,
  configCheck,
  databaseCheck,
  deploymentAuthCheck,
  llmCheck,
  logCheck,
  managedInstallChecks,
  nodeRuntimeCheck,
  portCheck,
  secretsCheck,
  serviceHealthChecks,
  storageCheck,
  type CheckResult,
} from "../checks/index.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { printUpdateNotice } from "../update-notice.js";

const STATUS_ICON = {
  pass: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
} as const;

export async function doctor(opts: {
  config?: string;
  repair?: boolean;
  yes?: boolean;
}): Promise<{ passed: number; warned: number; failed: number }> {
  await printUpdateNotice(opts.config);
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" Alice 诊断 ")));

  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const results: CheckResult[] = [];

  // 1. Config check (must pass before others)
  const cfgResult = configCheck(opts.config);
  results.push(cfgResult);
  printResult(cfgResult);

  if (cfgResult.status === "fail") {
    return printSummary(results);
  }

  let config: PaperclipConfig;
  try {
    config = readConfig(opts.config)!;
  } catch (err) {
    const readResult: CheckResult = {
      name: "配置文件",
      status: "fail",
      message: `无法读取配置：${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "请运行 `paperclipai configure --section database` 或 `paperclipai onboard`",
    };
    results.push(readResult);
    printResult(readResult);
    return printSummary(results);
  }

  // 2. Deployment/auth mode check
  const deploymentAuthResult = deploymentAuthCheck(config);
  results.push(deploymentAuthResult);
  printResult(deploymentAuthResult);

  // 3. Agent JWT check
  results.push(
    await runRepairableCheck({
      run: () => agentJwtSecretCheck(opts.config),
      configPath,
      opts,
    }),
  );

  // 4. Secrets adapter check
  results.push(
    await runRepairableCheck({
      run: () => secretsCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 5. Storage check
  results.push(
    await runRepairableCheck({
      run: () => storageCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 6. Database check
  results.push(
    await runRepairableCheck({
      run: () => databaseCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 7. LLM check
  const llmResult = await llmCheck(config);
  results.push(llmResult);
  printResult(llmResult);

  // 8. Log directory check
  results.push(
    await runRepairableCheck({
      run: () => logCheck(config, configPath),
      configPath,
      opts,
    }),
  );

  // 9. Port check
  const portResult = await portCheck(config);
  results.push(portResult);
  printResult(portResult);

  // 10. Runtime and managed install checks
  const nodeResult = nodeRuntimeCheck();
  results.push(nodeResult);
  printResult(nodeResult);
  for (const result of managedInstallChecks()) {
    results.push(result);
    printResult(result);
  }

  // 11. Background service checks
  for (const result of await serviceHealthChecks(config)) {
    results.push(result);
    printResult(result);
  }

  // Summary
  return printSummary(results);
}

function printResult(result: CheckResult): void {
  const icon = STATUS_ICON[result.status];
  p.log.message(`${icon} ${pc.bold(result.name)}: ${result.message}`);
  if (result.status !== "pass" && result.repairHint) {
    p.log.message(`  ${pc.dim(result.repairHint)}`);
  }
}

async function maybeRepair(
  result: CheckResult,
  opts: { repair?: boolean; yes?: boolean },
): Promise<boolean> {
  if (result.status === "pass" || !result.canRepair || !result.repair) return false;
  if (!opts.repair) return false;

  let shouldRepair = opts.yes;
  if (!shouldRepair) {
    const answer = await p.confirm({
      message: `是否修复“${result.name}”？`,
      initialValue: true,
    });
    if (p.isCancel(answer)) return false;
    shouldRepair = answer;
  }

  if (shouldRepair) {
    try {
      await result.repair();
      p.log.success(`已修复：${result.name}`);
      return true;
    } catch (err) {
      p.log.error(`修复失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return false;
}

async function runRepairableCheck(input: {
  run: () => CheckResult | Promise<CheckResult>;
  configPath: string;
  opts: { repair?: boolean; yes?: boolean };
}): Promise<CheckResult> {
  let result = await input.run();
  printResult(result);

  const repaired = await maybeRepair(result, input.opts);
  if (!repaired) return result;

  // Repairs may create/update the adjacent .env file or other local resources.
  loadPaperclipEnvFile(input.configPath);
  result = await input.run();
  printResult(result);
  return result;
}

function printSummary(results: CheckResult[]): { passed: number; warned: number; failed: number } {
  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  const parts: string[] = [];
  parts.push(pc.green(`${passed} 项通过`));
  if (warned) parts.push(pc.yellow(`${warned} 项警告`));
  if (failed) parts.push(pc.red(`${failed} 项失败`));

  p.note(parts.join("，"), "汇总");

  if (failed > 0) {
    p.outro(pc.red("部分检查失败。请修复上述问题后重新运行诊断。"));
  } else if (warned > 0) {
    p.outro(pc.yellow("所有关键检查均已通过，但仍有警告。"));
  } else {
    p.outro(pc.green("所有检查均已通过！"));
  }

  return { passed, warned, failed };
}
