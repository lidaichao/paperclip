import { setTimeout as delay } from "node:timers/promises";
import pc from "picocolors";
import type { Agent, HeartbeatRun, HeartbeatRunEvent, HeartbeatRunStatus } from "@paperclipai/shared";
import { getCLIAdapter } from "../adapters/index.js";
import { resolveCommandContext } from "./client/common.js";

const HEARTBEAT_SOURCES = ["timer", "assignment", "on_demand", "automation"] as const;
const HEARTBEAT_TRIGGERS = ["manual", "ping", "callback", "system"] as const;
const TERMINAL_STATUSES = new Set<HeartbeatRunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
const POLL_INTERVAL_MS = 200;

type HeartbeatSource = (typeof HEARTBEAT_SOURCES)[number];
type HeartbeatTrigger = (typeof HEARTBEAT_TRIGGERS)[number];
type InvokedHeartbeat = HeartbeatRun | { status: "skipped" };
interface HeartbeatRunEventRecord extends HeartbeatRunEvent {
  type?: string | null;
}

interface HeartbeatRunOptions {
  config?: string;
  context?: string;
  profile?: string;
  agentId: string;
  apiBase?: string;
  apiKey?: string;
  source: string;
  trigger: string;
  timeoutMs: string;
  debug?: boolean;
  json?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  if (!obj) return "";
  const message =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.error === "string" && obj.error) ||
    (typeof obj.code === "string" && obj.code) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

type AdapterType = string;

export async function heartbeatRun(opts: HeartbeatRunOptions): Promise<void> {
  const debug = Boolean(opts.debug);
  const parsedTimeout = Number.parseInt(opts.timeoutMs, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : 0;
  const source = HEARTBEAT_SOURCES.includes(opts.source as HeartbeatSource)
    ? (opts.source as HeartbeatSource)
    : "on_demand";
  const triggerDetail = HEARTBEAT_TRIGGERS.includes(opts.trigger as HeartbeatTrigger)
    ? (opts.trigger as HeartbeatTrigger)
    : "manual";

  const ctx = resolveCommandContext({
    config: opts.config,
    context: opts.context,
    profile: opts.profile,
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    json: opts.json,
  });
  const api = ctx.api;

  const agent = await api.get<Agent>(`/api/agents/${opts.agentId}`);
  if (!agent || typeof agent !== "object" || !agent.id) {
    console.error(pc.red(`未找到智能体：${opts.agentId}`));
    return;
  }

  const invokeRes = await api.post<InvokedHeartbeat>(
    `/api/agents/${opts.agentId}/wakeup`,
    {
      source: source,
      triggerDetail: triggerDetail,
    },
  );
  if (!invokeRes) {
    console.error(pc.red("触发心跳失败"));
    return;
  }
  if ((invokeRes as { status?: string }).status === "skipped") {
    console.log(pc.yellow("已跳过心跳触发"));
    return;
  }

  const run = invokeRes as HeartbeatRun;
  console.log(pc.cyan(`已为智能体 ${agent.name}（${agent.id}）触发心跳运行 ${run.id}`));

  const runId = run.id;
  let activeRunId: string | null = null;
  let lastEventSeq = 0;
  let logOffset = 0;
  let stdoutJsonBuffer = "";

  const printRawChunk = (stream: "stdout" | "stderr" | "system", chunk: string) => {
    if (stream === "stdout") process.stdout.write(pc.green("[stdout] ") + chunk);
    else if (stream === "stderr") process.stdout.write(pc.red("[stderr] ") + chunk);
    else process.stdout.write(pc.yellow("[system] ") + chunk);
  };

  const printAdapterInvoke = (payload: Record<string, unknown>) => {
    const adapterType = typeof payload.adapterType === "string" ? payload.adapterType : "unknown";
    const command = typeof payload.command === "string" ? payload.command : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const args =
      Array.isArray(payload.commandArgs) &&
      (payload.commandArgs as unknown[]).every((v) => typeof v === "string")
        ? (payload.commandArgs as string[])
        : [];
    const env =
      typeof payload.env === "object" && payload.env !== null && !Array.isArray(payload.env)
        ? (payload.env as Record<string, unknown>)
        : null;
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const context =
      typeof payload.context === "object" && payload.context !== null && !Array.isArray(payload.context)
        ? (payload.context as Record<string, unknown>)
        : null;

    console.log(pc.cyan(`适配器：${adapterType}`));
    if (cwd) console.log(pc.cyan(`工作目录：${cwd}`));
    if (command) {
      const rendered = args.length > 0 ? `${command} ${args.join(" ")}` : command;
      console.log(pc.cyan(`命令：${rendered}`));
    }
    if (env) {
      console.log(pc.cyan("环境变量："));
      console.log(pc.gray(JSON.stringify(env, null, 2)));
    }
    if (context) {
      console.log(pc.cyan("上下文："));
      console.log(pc.gray(JSON.stringify(context, null, 2)));
    }
    if (prompt) {
      console.log(pc.cyan("提示词："));
      console.log(prompt);
    }
  };

  const adapterType: AdapterType = agent.adapterType ?? "claude_local";
  const cliAdapter = getCLIAdapter(adapterType);

  const handleStreamChunk = (stream: "stdout" | "stderr" | "system", chunk: string) => {
    if (debug) {
      printRawChunk(stream, chunk);
      return;
    }

    if (stream !== "stdout") {
      printRawChunk(stream, chunk);
      return;
    }

    const combined = stdoutJsonBuffer + chunk;
    const lines = combined.split(/\r?\n/);
    stdoutJsonBuffer = lines.pop() ?? "";
    for (const line of lines) {
      cliAdapter.formatStdoutEvent(line, debug);
    }
  };

  const handleEvent = (event: HeartbeatRunEventRecord) => {
    const payload = normalizePayload(event.payload);
    if (event.runId !== runId) return;
    const eventType = typeof event.eventType === "string"
      ? event.eventType
      : typeof event.type === "string"
      ? event.type
      : "";

    if (eventType === "heartbeat.run.status") {
      const status = typeof payload.status === "string" ? payload.status : null;
      if (status) {
        console.log(pc.blue(`[状态] ${status}`));
      }
    } else if (eventType === "adapter.invoke") {
      printAdapterInvoke(payload);
    } else if (eventType === "heartbeat.run.log") {
      const stream = typeof payload.stream === "string" ? payload.stream : "system";
      const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
      if (!chunk) return;
      if (stream === "stdout" || stream === "stderr" || stream === "system") {
        handleStreamChunk(stream, chunk);
      }
    } else if (typeof event.message === "string") {
      console.log(pc.gray(`[事件] ${eventType || "heartbeat.run.event"}：${event.message}`));
    }

    lastEventSeq = Math.max(lastEventSeq, event.seq ?? 0);
  };

  activeRunId = runId;
  let finalStatus: string | null = null;
  let finalError: string | null = null;
  let finalRun: HeartbeatRun | null = null;

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  if (!activeRunId) {
    console.error(pc.red("未能获取心跳运行编号"));
    return;
  }

  while (true) {
      const events = await api.get<HeartbeatRunEvent[]>(
        `/api/heartbeat-runs/${activeRunId}/events?afterSeq=${lastEventSeq}&limit=100`,
      );
    for (const event of Array.isArray(events) ? (events as HeartbeatRunEventRecord[]) : []) {
      handleEvent(event);
    }

      const runList = (await api.get<(HeartbeatRun | null)[]>(
        `/api/companies/${agent.companyId}/heartbeat-runs?agentId=${agent.id}`,
      )) || [];
      const currentRun = runList.find((r) => r && r.id === activeRunId) ?? null;

    if (!currentRun) {
      console.error(pc.red("心跳运行已消失"));
      break;
    }

    const currentStatus = currentRun.status as HeartbeatRunStatus | undefined;
    if (currentStatus !== finalStatus && currentStatus) {
      finalStatus = currentStatus;
      console.log(pc.blue(`状态：${currentStatus}`));
    }

    if (currentStatus && TERMINAL_STATUSES.has(currentStatus)) {
      finalStatus = currentRun.status;
      finalError = currentRun.error;
      finalRun = currentRun;
      break;
    }

    if (deadline && Date.now() >= deadline) {
      finalError = `CLI 在 ${timeoutMs} 毫秒后超时`;
      finalStatus = "timed_out";
      console.error(pc.yellow(finalError));
      break;
    }

    const logResult = await api.get<{ content: string; nextOffset?: number }>(
      `/api/heartbeat-runs/${activeRunId}/log?offset=${logOffset}&limitBytes=16384`,
      { ignoreNotFound: true },
    );
    if (logResult && logResult.content) {
      for (const chunk of logResult.content.split(/\r?\n/)) {
        if (!chunk) continue;
        const parsed = safeParseLogLine(chunk);
        if (!parsed) continue;
        handleStreamChunk(parsed.stream, parsed.chunk);
      }
      if (typeof logResult.nextOffset === "number") {
        logOffset = logResult.nextOffset;
      } else if (logResult.content) {
        logOffset += Buffer.byteLength(logResult.content, "utf8");
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  if (finalStatus) {
    if (!debug && stdoutJsonBuffer.trim()) {
      cliAdapter.formatStdoutEvent(stdoutJsonBuffer, debug);
      stdoutJsonBuffer = "";
    }
    const label = `运行 ${activeRunId} 已结束，状态：${finalStatus}`;
    if (finalStatus === "succeeded") {
      console.log(pc.green(label));
      return;
    }

    console.log(pc.red(label));
    if (finalError) {
      console.log(pc.red(`错误：${finalError}`));
    }
    if (finalRun) {
      const resultObj = asRecord(finalRun.resultJson);
      if (resultObj) {
        const subtype = typeof resultObj.subtype === "string" ? resultObj.subtype : "";
        const isError = resultObj.is_error === true;
        const errors = Array.isArray(resultObj.errors) ? resultObj.errors.map(asErrorText).filter(Boolean) : [];
        const resultText = typeof resultObj.result === "string" ? resultObj.result.trim() : "";
        if (subtype || isError || errors.length > 0 || resultText) {
          console.log(pc.red("Claude 结果详情："));
          if (subtype) console.log(pc.red(`  子类型：${subtype}`));
          if (isError) console.log(pc.red("  是否错误：是"));
          if (errors.length > 0) console.log(pc.red(`  错误：${errors.join(" | ")}`));
          if (resultText) console.log(pc.red(`  结果：${resultText}`));
        }
      }

      const stderrExcerpt = typeof finalRun.stderrExcerpt === "string" ? finalRun.stderrExcerpt.trim() : "";
      const stdoutExcerpt = typeof finalRun.stdoutExcerpt === "string" ? finalRun.stdoutExcerpt.trim() : "";
      if (stderrExcerpt) {
        console.log(pc.red("标准错误摘要："));
        console.log(stderrExcerpt);
      }
      if (stdoutExcerpt && (debug || !stderrExcerpt)) {
        console.log(pc.gray("标准输出摘要："));
        console.log(stdoutExcerpt);
      }
    }
    process.exitCode = 1;
  } else {
    process.exitCode = 1;
    console.log(pc.gray("心跳流已结束，但没有最终状态"));
  }
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function safeParseLogLine(line: string): { stream: "stdout" | "stderr" | "system"; chunk: string } | null {
  try {
    const parsed = JSON.parse(line) as { stream?: unknown; chunk?: unknown };
    const stream =
      parsed.stream === "stdout" || parsed.stream === "stderr" || parsed.stream === "system"
        ? parsed.stream
        : "system";
    const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";

    if (!chunk) return null;
    return { stream, chunk };
  } catch {
    return null;
  }
}
