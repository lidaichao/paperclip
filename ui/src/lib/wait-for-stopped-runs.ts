import { heartbeatsApi } from "../api/heartbeats";
import { l10n } from "../i18n";

const LIVE_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

/** A tree hold response acknowledges the hold, not necessarily runner termination. */
export async function waitForStoppedRuns(
  runIds: string[],
  options: {
    getRun?: typeof heartbeatsApi.get;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
) {
  const getRun = options.getRun ?? heartbeatsApi.get;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let remaining = [...new Set(runIds)];
  while (remaining.length > 0) {
    let states;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      states = await Promise.race([
        Promise.all(remaining.map((id) => getRun(id))),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(l10n("local.stop_verification_timed_out_10300030"))),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } catch {
      throw new Error(
        l10n("local.stop_requested_but_not_verified_10300031"),
      );
    } finally {
      clearTimeout(timeout);
    }
    remaining = states
      .filter((run) => {
        if (LIVE_STATUSES.has(run.status)) return true;
        const adapterCancellation = run.resultJson?.executionCancellation;
        if (adapterCancellation && typeof adapterCancellation === "object"
          && "state" in adapterCancellation && adapterCancellation.state !== "acknowledged") return true;
        if (!("runtimeMode" in run) || run.runtimeMode !== "native" || run.status !== "cancelled")
          return false;
        const cancellation = run.resultJson?.nativeCancellation;
        return (
          !cancellation ||
          typeof cancellation !== "object" ||
          !("dispatchState" in cancellation) ||
          cancellation.dispatchState !== "acknowledged"
        );
      })
      .map((run) => run.id);
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        l10n("local.work_is_still_stopping_10300032"),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? 500),
    );
  }
}
