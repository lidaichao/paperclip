import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "./config.js";
import { buildWorkerEnvironment } from "./environment.js";
import { loadMemberGbrainToken } from "./member-credential.js";
import { verifyGbrainIdentity } from "./gbrain-identity.js";
import { assertPrivateModelAuthReady } from "./model-readiness.js";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: launcher <config.json>");
  const config = await loadBridgeConfig(configPath);
  const memberToken = await loadMemberGbrainToken(config.agents[0], process.env);
  await verifyGbrainIdentity({ agent: config.agents[0], endpoint: config.gbrainMcpUrl, token: memberToken });
  const env = buildWorkerEnvironment(process.env, config, memberToken);
  for (const folder of [config.workerHome, env.HOME!,
    ...(config.modelAuthMode === "shared_user_codex" ? [] : [env.CODEX_HOME!]),
    env.CURSOR_HOME!, env.PAPERCLIP_HOME!, env.APPDATA!,
    env.LOCALAPPDATA!, env.TEMP!, env.XDG_CONFIG_HOME!]) {
    await mkdir(folder, { recursive: true });
  }
  await assertPrivateModelAuthReady(config, config.agents[0]);
  const runtime = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge.bundle.mjs");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, path.resolve(configPath)], {
      env, shell: false, windowsHide: true, stdio: "inherit",
    });
    child.once("error", () => reject(new Error("isolated worker could not start")));
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "isolated launcher failed"}\n`);
    process.exitCode = 1;
  });
}
