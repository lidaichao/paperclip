import type { LocalRunClaim, LocalRunLease } from "./paperclip-client.js";
import { performance } from "node:perf_hooks";

export interface LeaseSessionClient {
  renewLocalRun(lease: LocalRunLease): Promise<
    { leaseExpiresAt: string; cancelRequested: true } |
    { leaseExpiresAt: string; cancelRequested: false; leaseDeadlineMonotonicMs: number }
  >;
  controlLocalRun(lease: LocalRunLease): Promise<{ action: "continue" | "cancel"; generation: number; leaseExpiresAt: string }>;
  finishLocalRun(lease: LocalRunLease, outcome: "succeeded" | "failed" | "cancelled", exitCode: number | null): Promise<string>;
}

export interface LeaseSessionResult {
  outcome: "succeeded" | "failed" | "cancelled";
  status: string;
}

export async function runLeaseSession(input: {
  client: LeaseSessionClient;
  claim: LocalRunClaim;
  deviceId: string;
  execute: (signal: AbortSignal) => Promise<{ succeeded: boolean; exitCode: number | null }>;
  signal?: AbortSignal;
  renewIntervalMs?: number;
  stopTimeoutMs?: number;
  now?: () => number;
}): Promise<LeaseSessionResult> {
  const now = input.now ?? (() => performance.now());
  const renewIntervalMs = input.renewIntervalMs ?? 20_000;
  const stopTimeoutMs = input.stopTimeoutMs ?? 20_000;
  if (renewIntervalMs <= 0 || stopTimeoutMs <= 0) throw new Error("lease timers must be positive");
  const lease: LocalRunLease = {
    deviceId: input.deviceId,
    runId: input.claim.runId,
    leaseId: input.claim.leaseId,
    generation: input.claim.generation,
  };
  let deadline = input.claim.leaseDeadlineMonotonicMs;
  if (!Number.isFinite(deadline) || deadline <= now() + 5_000) throw new Error("server lease is expired or too close to expiry");
  if (input.signal?.aborted) throw new Error("local run was cancelled before execution");

  const controller = new AbortController();
  let reason: "cancelled" | "lease_lost" | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = (nextReason: "cancelled" | "lease_lost") => {
    reason ??= nextReason;
    controller.abort();
    wake?.();
  };
  const onParentAbort = () => stop("cancelled");
  input.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (input.signal?.aborted) stop("cancelled");

  const sleep = (milliseconds: number) => new Promise<void>((resolve) => {
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    timer = setTimeout(() => wake?.(), milliseconds);
    timer.unref?.();
  });
  const renewLoop = (async () => {
    while (!finished && !controller.signal.aborted) {
      await sleep(Math.max(1, Math.min(renewIntervalMs, deadline - now() - 5_000)));
      if (finished || controller.signal.aborted) return;
      if (deadline <= now() + 5_000) { stop("lease_lost"); return; }
      try {
        const renewed = await input.client.renewLocalRun(lease);
        if (renewed.cancelRequested) { stop("cancelled"); return; }
        const nextDeadline = renewed.leaseDeadlineMonotonicMs;
        if (!Number.isFinite(nextDeadline) || nextDeadline <= now() + 5_000) { stop("lease_lost"); return; }
        deadline = nextDeadline;
      } catch (error) {
        // A rejection or network failure cannot prove the lease still belongs to us.
        // Stop local execution before its last known deadline; the server will
        // reconcile the expired run. No finish is sent with a stale lease.
        void error;
        stop("lease_lost");
        return;
      }
    }
  })();

  try {
    const execution = Promise.resolve().then(() => input.execute(controller.signal));
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      abortListener = () => resolve({ kind: "aborted" });
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const settled = await Promise.race([
      execution.then((result) => ({ kind: "settled" as const, result }), (error) => ({ kind: "error" as const, error })),
      aborted,
    ]);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    let result: { succeeded: boolean; exitCode: number | null } | null = null;
    if (settled.kind === "settled") result = settled.result;
    else if (settled.kind === "error") throw settled.error;
    else {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        execution.then((value) => ({ stopped: true as const, value }), () => ({ stopped: false as const })),
        new Promise<{ stopped: false }>((resolve) => { stopTimer = setTimeout(() => resolve({ stopped: false }), stopTimeoutMs); }),
      ]);
      clearTimeout(stopTimer);
      if (!stopped.stopped) throw new Error("local process stop was not confirmed; refusing finish");
      result = stopped.value;
    }
    if (reason === "lease_lost") throw new Error("server lease was lost; local process stopped without stale finish");
    let outcome: LeaseSessionResult["outcome"] = reason === "cancelled" ? "cancelled" : result?.succeeded ? "succeeded" : "failed";
    if (outcome !== "cancelled") {
      const control = await input.client.controlLocalRun(lease);
      if (control.action === "cancel") outcome = "cancelled";
    }
    let status: string;
    try { status = await input.client.finishLocalRun(lease, outcome, result?.exitCode ?? null); }
    catch (error) {
      if (outcome === "cancelled" || !(error instanceof Error) || !error.message.includes("HTTP 409")) throw error;
      const control = await input.client.controlLocalRun(lease);
      if (control.action !== "cancel") throw error;
      outcome = "cancelled";
      status = await input.client.finishLocalRun(lease, outcome, result?.exitCode ?? null);
    }
    return { outcome, status };
  } finally {
    finished = true;
    wake?.();
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
    await renewLoop;
  }
}
