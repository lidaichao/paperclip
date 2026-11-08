import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, localAgentRunLeases } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { isClientPullRuntimeConfig } from "../services/local-agent-run-leases.js";

const localRunMutation = /^\/api\/agents\/me\/local-runs\/(?:claim|[0-9a-f-]{36}\/(?:renew|finish|events|comments|subtasks|review-accept|review-reject|issue\/(?:review-handoff|review-confirmation|completion-review-handoff|child-complete|defect-repair-handoff|defect-qa-verdict|po-verdict)))\/?$/i;

/**
 * Fail closed until each ordinary write endpoint can verify the lease inside
 * the same transaction as its business mutation. An auth-time lease check alone
 * would race a concurrent cancellation and permit a stale write.
 */
export function localAgentRunWriteGate(db: Db): RequestHandler {
  return async (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.actor.type !== "agent" ||
      !req.actor.agentId || !req.actor.companyId) return next();

    const [agent] = await db.select({ runtimeConfig: agents.runtimeConfig })
      .from(agents).where(and(eq(agents.id, req.actor.agentId), eq(agents.companyId, req.actor.companyId))).limit(1);
    // A long-lived key must never regain ordinary write powers merely because
    // the operator toggled executionMode off after a desktop lease ended.
    const [localHistory] = await db.select({ runId: localAgentRunLeases.runId })
      .from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.companyId, req.actor.companyId),
        eq(localAgentRunLeases.agentId, req.actor.agentId),
      )).limit(1);
    const [attributedRun] = req.actor.runId
      ? await db.select({ runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.companyId, req.actor.companyId),
          eq(heartbeatRuns.agentId, req.actor.agentId),
        )).limit(1)
      : [];
    if (isClientPullRuntimeConfig(agent?.runtimeConfig) || localHistory || attributedRun?.runtimeMode === "client_pull") {
      if (req.actor.source === "agent_key" && localRunMutation.test(req.path)) return next();
      res.status(403).json({
        error: "Client-pull run writes require a transaction-bound lease fence; this endpoint is not enabled",
        code: "CLIENT_PULL_WRITE_FENCED",
      });
      return;
    }
    next();
  };
}
