import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issues,
  localAgentRunLeases,
} from "@paperclipai/db";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { accessService } from "./access.js";
import { assertBoundLocalDevice } from "./local-agent-device-bindings.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { issueReferenceService } from "./issue-references.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { executeReviewHandoff } from "./issue-review-handoff.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalRunOwner = {
  companyId: string;
  agentId: string;
  deviceId: string;
  keyId: string;
  leaseId: string;
  generation: number;
  runId: string;
};

export function isClientPullRuntimeConfig(config: Record<string, unknown> | null | undefined) {
  return config?.executionMode === "client_pull";
}

function requireDeviceId(deviceId: string) {
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(deviceId)) {
    throw badRequest("deviceId must be 8–128 safe characters");
  }
}

function requireOwner(input: LocalRunOwner) {
  requireDeviceId(input.deviceId);
  if (!UUID.test(input.runId) || !UUID.test(input.leaseId) || !UUID.test(input.keyId) ||
    !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw badRequest("Invalid local run lease identity");
  }
}

async function assertLeaseDevice(tx: Db, lease: typeof localAgentRunLeases.$inferSelect,
  input: LocalRunOwner, allowRevoked = false) {
  if (lease.deviceKeyId !== input.keyId) throw forbidden("Lease belongs to another device credential");
  return assertBoundLocalDevice(tx, input, { allowRevoked });
}

function issueIdFromRun(run: typeof heartbeatRuns.$inferSelect) {
  const value = run.contextSnapshot?.issueId;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function wakeReasonFromRun(run: typeof heartbeatRuns.$inferSelect) {
  const value = run.contextSnapshot?.wakeReason;
  return typeof value === "string" && value.trim() ? value : "assignment";
}

export function localAgentRunLeaseService(
  db: Db,
  deps: { syncCommentReferences?: (commentId: string) => Promise<void> } = {},
) {
  async function leaseTtlMs(tx: Db, runId: string) {
    const [row] = await tx.select({
      value: sql<number>`greatest(0, floor(extract(epoch from (${localAgentRunLeases.expiresAt} - now())) * 1000))::integer`,
    }).from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, runId));
    return row?.value ?? 0;
  }

  async function claim(input: {
    companyId: string;
    agentId: string;
    deviceId: string;
    keyId: string;
    idempotencyKey: string;
  }) {
    requireDeviceId(input.deviceId);
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
      throw badRequest("Idempotency-Key must be 8–128 safe characters");
    }
    return db.transaction(async (tx) => {
      // The agent lock serializes all claims for this agent across server replicas.
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
      )).for("update");
      if (!agent) throw notFound("Agent not found");
      if (!isClientPullRuntimeConfig(agent.runtimeConfig)) throw forbidden("Client-pull execution is not enabled for this agent");
      if (["terminated", "pending_approval", "paused"].includes(agent.status)) throw forbidden("Agent is not available for execution");
      await assertBoundLocalDevice(tx as unknown as Db, input);

      const [sameClaim] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.companyId, input.companyId),
        eq(localAgentRunLeases.agentId, input.agentId),
        eq(localAgentRunLeases.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (sameClaim) {
        if (sameClaim.deviceId !== input.deviceId || sameClaim.deviceKeyId !== input.keyId ||
          sameClaim.releasedAt) throw conflict("Claim key belongs to another or completed lease");
        const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sameClaim.runId)).limit(1);
        const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
          .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, sameClaim.runId));
        if (!run || run.status !== "running" || sameClaim.cancelRequestedAt || !live?.live) {
          throw conflict("The original claim is no longer executable");
        }
        return {
          runId: run.id, issueId: sameClaim.issueId, agentId: input.agentId,
          leaseId: sameClaim.leaseId, generation: sameClaim.generation,
          leaseExpiresAt: sameClaim.expiresAt, wakeReason: wakeReasonFromRun(run),
          leaseTtlMs: await leaseTtlMs(tx as unknown as Db, run.id),
          workspacePolicy: "agent_home" as const,
        };
      }

      const [active] = await tx.select({ runId: localAgentRunLeases.runId })
        .from(localAgentRunLeases).where(and(
          eq(localAgentRunLeases.companyId, input.companyId),
          eq(localAgentRunLeases.agentId, input.agentId),
          isNull(localAgentRunLeases.releasedAt),
        )).limit(1);
      // Even an expired lease reserves this slot until the old process reports
      // stopped. Expiration is a write fence, not proof of process death.
      if (active) throw conflict("Agent already has an unacknowledged local run", { runId: active.runId });

      const [serverRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
      )).limit(1);
      if (serverRun) throw conflict("Agent already has a running server run");

      async function* queuedCandidates() {
        let cursor: { createdAt: Date; id: string } | null = null;
        while (true) {
          const page: Array<typeof heartbeatRuns.$inferSelect> = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
            eq(heartbeatRuns.status, "queued"),
            cursor ? or(
              gt(heartbeatRuns.createdAt, cursor.createdAt),
              and(eq(heartbeatRuns.createdAt, cursor.createdAt), gt(heartbeatRuns.id, cursor.id)),
            ) : undefined,
          )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
            .limit(20).for("update", { skipLocked: true });
          if (page.length === 0) return;
          for (const candidate of page) yield candidate;
          const last = page[page.length - 1]!;
          cursor = { createdAt: last.createdAt, id: last.id };
          if (page.length < 20) return;
        }
      }

      for await (const run of queuedCandidates()) {
        const issueId = issueIdFromRun(run);
        if (!issueId || run.runtimeMode === "native") continue;
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, issueId), eq(issues.companyId, input.companyId),
        )).for("update");
        if (!issue || issue.assigneeAgentId !== input.agentId || !["todo", "in_progress"].includes(issue.status) ||
          (issue.executionRunId && issue.executionRunId !== run.id) ||
          (issue.checkoutRunId && issue.checkoutRunId !== run.id)) continue;
        // Reuse the scheduler's own suppression, cutoff, org-chain, budget and
        // daily-limit decisions before a desktop process can be admitted.
        const { heartbeatService } = await import("./heartbeat.js");
        await heartbeatService(db).assertClientPullClaimAdmission(run, agent, issue, tx as unknown as Db);
        const [otherRunning] = await tx.select({ id: heartbeatRuns.id })
          .from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.status, "running"),
            ne(heartbeatRuns.id, run.id),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
          )).limit(1);
        if (otherRunning) continue;
        const dependency = await issueService(db).getDependencyReadiness(issueId, tx);
        if (!dependency.isDependencyReady || await getExecutionBlocker(tx as unknown as Db, input.companyId, issueId)) continue;
        const [otherLease] = await tx.select({ runId: localAgentRunLeases.runId })
          .from(localAgentRunLeases).where(and(
            eq(localAgentRunLeases.companyId, input.companyId),
            eq(localAgentRunLeases.issueId, issueId),
            isNull(localAgentRunLeases.releasedAt),
          )).limit(1);
        if (otherLease) continue;

        if (run.wakeupRequestId) {
          const [wake] = await tx.select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId)).for("update");
          if (!wake || wake.status !== "queued") continue;
        }

        const [claimed] = await tx.update(heartbeatRuns).set({
          status: "running", runtimeMode: "client_pull", startedAt: sql`now()`, updatedAt: sql`now()`,
        }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued"))).returning();
        if (!claimed) continue;
        await tx.update(issues).set({
          executionRunId: run.id, executionLockedAt: sql`now()`, updatedAt: sql`now()`,
        }).where(eq(issues.id, issueId));
        if (run.wakeupRequestId) {
          await tx.update(agentWakeupRequests).set({
            status: "claimed", claimedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
        }
        const [lease] = await tx.insert(localAgentRunLeases).values({
          runId: run.id, companyId: input.companyId, agentId: input.agentId,
          issueId, deviceId: input.deviceId, deviceKeyId: input.keyId,
          idempotencyKey: input.idempotencyKey,
          expiresAt: sql`now() + interval '90 seconds'`,
        }).returning();
        return {
          runId: run.id, issueId, agentId: input.agentId,
          leaseId: lease.leaseId, generation: lease.generation,
          leaseExpiresAt: lease.expiresAt, wakeReason: wakeReasonFromRun(run),
          leaseTtlMs: await leaseTtlMs(tx as unknown as Db, run.id),
          workspacePolicy: "agent_home" as const,
        };
      }
      return null;
    });
  }

  async function lockedOwner(input: LocalRunOwner) {
    requireOwner(input);
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      if (!run || !lease || lease.companyId !== input.companyId || lease.agentId !== input.agentId ||
        lease.deviceId !== input.deviceId || lease.leaseId !== input.leaseId || lease.generation !== input.generation) {
        throw forbidden("Local run lease owner mismatch");
      }
      const binding = await assertLeaseDevice(tx as unknown as Db, lease, input, true);
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      const shouldStop = run.status !== "running" || !live?.live || Boolean(lease.cancelRequestedAt) ||
        Boolean(lease.releasedAt) || Boolean(binding.revokedAt);
      const currentLease = shouldStop && !lease.cancelRequestedAt && !lease.releasedAt
        ? (await tx.update(localAgentRunLeases).set({
            cancelRequestedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(eq(localAgentRunLeases.runId, input.runId)).returning())[0]
        : lease;
      return { run, lease: currentLease, shouldStop };
    });
  }

  async function renew(input: LocalRunOwner) {
    requireOwner(input);
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      if (!run || !lease || lease.companyId !== input.companyId || lease.agentId !== input.agentId ||
        lease.deviceId !== input.deviceId || lease.leaseId !== input.leaseId || lease.generation !== input.generation) {
        throw forbidden("Local run lease owner mismatch");
      }
      const binding = await assertLeaseDevice(tx as unknown as Db, lease, input, true);
      if (lease.releasedAt) throw conflict("Local run already finished");
      if (run.status !== "running" || lease.cancelRequestedAt || binding.revokedAt) {
        if (!lease.cancelRequestedAt) await tx.update(localAgentRunLeases)
          .set({ cancelRequestedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(localAgentRunLeases.runId, input.runId));
        return { leaseExpiresAt: lease.expiresAt, cancelRequested: true };
      }
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      if (!live?.live) throw conflict("Local run lease expired; stop the process and acknowledge it");
      const [renewed] = await tx.update(localAgentRunLeases).set({
        expiresAt: sql`now() + interval '90 seconds'`,
        lastRenewedAt: sql`now()`, updatedAt: sql`now()`,
      }).where(eq(localAgentRunLeases.runId, input.runId)).returning();
      return { leaseExpiresAt: renewed.expiresAt,
        leaseTtlMs: await leaseTtlMs(tx as unknown as Db, input.runId), cancelRequested: false };
    });
  }

  async function control(input: LocalRunOwner) {
    const { lease, shouldStop } = await lockedOwner(input);
    return {
      action: shouldStop ? "cancel" as const : "continue" as const,
      generation: lease.generation,
      leaseExpiresAt: lease.expiresAt,
    };
  }

  async function finish(input: LocalRunOwner & {
    outcome: "succeeded" | "failed" | "cancelled";
    exitCode: number | null;
    processStopped: true;
    clientRequestId?: string;
    summary?: string;
  }) {
    requireOwner(input);
    if (input.clientRequestId !== undefined && !UUID.test(input.clientRequestId)) throw badRequest("clientRequestId must be a UUID");
    if (input.summary !== undefined && (!input.clientRequestId || typeof input.summary !== "string" ||
      Buffer.byteLength(input.summary, "utf8") > 4096)) {
      throw badRequest("summary requires clientRequestId and at most 4096 UTF-8 bytes");
    }
    if (input.processStopped !== true) throw badRequest("Process-stop acknowledgement is required");
    if (input.exitCode !== null && (!Number.isSafeInteger(input.exitCode) || input.exitCode < -1 || input.exitCode > 255)) {
      throw badRequest("Invalid exitCode");
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      if (!run || !lease || lease.companyId !== input.companyId || lease.agentId !== input.agentId ||
        lease.deviceId !== input.deviceId || lease.leaseId !== input.leaseId || lease.generation !== input.generation) {
        throw forbidden("Local run lease owner mismatch");
      }
      const binding = await assertLeaseDevice(tx as unknown as Db, lease, input, true);
      if (binding.revokedAt && input.outcome !== "cancelled") {
        throw conflict("Revoked device can only acknowledge cancellation");
      }
      if (lease.releasedAt) {
        if (lease.outcome !== input.outcome) throw conflict("Run already finished with another outcome");
        if (input.clientRequestId) {
          const saved = run.resultJson?.localWorkerFinish;
          if (!saved || typeof saved !== "object" ||
            (saved as Record<string, unknown>).clientRequestId !== input.clientRequestId ||
            (saved as Record<string, unknown>).outcome !== input.outcome ||
            (saved as Record<string, unknown>).exitCode !== input.exitCode ||
            (saved as Record<string, unknown>).summary !== (input.summary ?? null)) {
            throw conflict("Run finish request changed after completion");
          }
        }
        return { runId: run.id, status: run.status };
      }
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      const cancelled = run.status !== "running" || lease.cancelRequestedAt || !live?.live || Boolean(binding.revokedAt);
      if (cancelled && input.outcome !== "cancelled") throw conflict("Cancelled or expired run cannot report success");
      const status = cancelled ? "cancelled" : input.outcome;
      await tx.update(localAgentRunLeases).set({
        stopAcknowledgedAt: sql`now()`, releasedAt: sql`now()`, outcome: input.outcome,
        updatedAt: sql`now()`,
      }).where(eq(localAgentRunLeases.runId, input.runId));
      if (run.status === "running" || input.clientRequestId) {
        await tx.update(heartbeatRuns).set({
          ...(run.status === "running" ? {
            status, exitCode: input.exitCode, finishedAt: sql`now()`,
          } : {}),
          updatedAt: sql`now()`,
          ...(input.clientRequestId ? { resultJson: {
            ...(run.resultJson ?? {}),
            localWorkerFinish: {
              clientRequestId: input.clientRequestId, outcome: input.outcome,
              exitCode: input.exitCode, summary: input.summary ?? null,
            },
          } } : {}),
        }).where(eq(heartbeatRuns.id, input.runId));
      }
      await tx.update(issues).set({
        executionRunId: null, executionLockedAt: null, updatedAt: sql`now()`,
      }).where(and(eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
        eq(issues.executionRunId, input.runId)));
      if (run.wakeupRequestId) {
        await tx.update(agentWakeupRequests).set({
          status: status === "succeeded" ? "completed" : status,
          finishedAt: sql`now()`, updatedAt: sql`now()`,
        }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
      }
      return { runId: run.id, status };
    });
  }

  async function appendFencedEvent(
    input: LocalRunOwner & { issueId: string; clientRequestId: string;
      stream: "stdout" | "stderr" | "system"; level: "info" | "warn" | "error"; message: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.clientRequestId)) throw badRequest("clientRequestId must be a UUID");
    if (!(["stdout", "stderr", "system"] as string[]).includes(input.stream) ||
      !(["info", "warn", "error"] as string[]).includes(input.level) ||
      typeof input.message !== "string" || !input.message.trim() ||
      Buffer.byteLength(input.message, "utf8") > 8192) {
      throw badRequest("Invalid run event or message over 8192 UTF-8 bytes");
    }
    requireOwner(input);
    if (!UUID.test(input.issueId)) throw badRequest("Invalid issueId");
    if (actor.type !== "agent" || actor.source !== "agent_key" ||
      actor.agentId !== input.agentId || actor.companyId !== input.companyId ||
      actor.keyId !== input.keyId ||
      (actor.runId && actor.runId !== input.runId)) {
      throw forbidden("An agent's own run and API key are required");
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      if (!run || !lease || lease.companyId !== input.companyId || lease.agentId !== input.agentId ||
        lease.issueId !== input.issueId || lease.deviceId !== input.deviceId ||
        lease.leaseId !== input.leaseId || lease.generation !== input.generation ||
        issueIdFromRun(run) !== input.issueId) {
        throw forbidden("Local run event owner mismatch");
      }
      await assertLeaseDevice(tx as unknown as Db, lease, input);
      const [existing] = await tx.select().from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, input.runId),
        eq(heartbeatRunEvents.sourceEventId, input.clientRequestId),
      )).limit(1);
      if (existing) {
        if (existing.sourceInstanceId !== input.deviceId || existing.stream !== input.stream ||
          existing.level !== input.level || existing.message !== input.message) {
          throw conflict("clientRequestId already belongs to different run event content");
        }
        return existing;
      }
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      if (run.status !== "running" || lease.cancelRequestedAt || lease.releasedAt || !live?.live) {
        throw conflict("Run event lease is cancelled, expired, or released");
      }
      const [issue] = await tx.select({ assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId, conversationAgentId: issues.conversationAgentId })
        .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .for("update");
      if (!issue || issue.assigneeAgentId !== input.agentId ||
        issue.executionRunId !== input.runId || issue.conversationAgentId) {
        throw forbidden("Local run no longer owns this task");
      }
      const [sequence] = await tx.select({ next: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0) + 1` })
        .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, input.runId));
      const [saved] = await tx.insert(heartbeatRunEvents).values({
        companyId: input.companyId, agentId: input.agentId, runId: input.runId,
        seq: Number(sequence?.next ?? 1), eventType: "log", stream: input.stream,
        level: input.level, message: input.message,
        sourceInstanceId: input.deviceId, sourceEventId: input.clientRequestId,
      }).returning();
      return saved;
    });
  }

  async function withFencedIssueWrite<T>(
    input: LocalRunOwner & { issueId: string },
    actor: Express.Request["actor"],
    action: "issue:comment" | "issue:mutate",
    write: (tx: Db, issue: typeof issues.$inferSelect, authorizationReason: string) => Promise<T>,
    options: { allowReviewReplay?: boolean } = {},
  ) {
    requireOwner(input);
    if (!UUID.test(input.issueId)) throw badRequest("Invalid issueId");
    if (actor.type !== "agent" || actor.source !== "agent_key" ||
      actor.agentId !== input.agentId || actor.companyId !== input.companyId ||
      actor.keyId !== input.keyId ||
      (actor.runId && actor.runId !== input.runId)) {
      throw forbidden("An agent's own run and API key are required");
    }
    // The run lock serializes cancellation and finish with the content write.
    // All checks and the business mutation use the same transaction and locks.
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      if (!run || !lease || run.status !== "running" || !live?.live ||
        lease.companyId !== input.companyId || lease.agentId !== input.agentId ||
        lease.issueId !== input.issueId || lease.deviceId !== input.deviceId ||
        lease.leaseId !== input.leaseId || lease.generation !== input.generation ||
        lease.cancelRequestedAt || lease.releasedAt || issueIdFromRun(run) !== input.issueId) {
        throw forbidden("Local run write lease is no longer valid");
      }
      await assertLeaseDevice(tx as unknown as Db, lease, input);
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      )).for("update");
      const reviewReplay = options.allowReviewReplay && issue?.status === "in_review" &&
        issue.executionRunId === null;
      if (!issue || issue.assigneeAgentId !== input.agentId ||
        (!reviewReplay && (issue.executionRunId !== input.runId ||
          !["todo", "in_progress"].includes(issue.status))) ||
        issue.conversationAgentId) {
        throw forbidden("Local run no longer owns this open task");
      }
      if (reviewReplay) return write(tx as unknown as Db, issue, "review_handoff_replay");
      const decision = await accessService(tx as unknown as Db).decide({
        actor: { ...actor, runId: input.runId }, action,
        resource: {
          type: "issue", companyId: issue.companyId, issueId: issue.id,
          projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId, status: issue.status,
        },
        scope: {
          issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        },
      });
      if (!decision.allowed) throw forbidden("Issue write permission denied");
      return write(tx as unknown as Db, issue, decision.reason ?? "local_run_assignee");
    });
  }

  async function addFencedComment(
    input: LocalRunOwner & { issueId: string; body: string; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (typeof input.body !== "string" || !input.body.trim()) throw badRequest("Comment body is required");
    if (!UUID.test(input.clientRequestId)) throw badRequest("clientRequestId must be a UUID");
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:comment", async (tx, issue, authorizationReason) => {
      const [existing] = await tx.select().from(issueComments).where(and(
        eq(issueComments.issueId, issue.id), eq(issueComments.createdByRunId, input.runId),
        eq(issueComments.authorAgentId, input.agentId), eq(issueComments.clientRequestId, input.clientRequestId),
      )).limit(1);
      if (existing) {
        const enabled = (await instanceSettingsService(tx).getGeneral()).censorUsernameInLogs;
        if (existing.body !== redactCurrentUserText(input.body, { enabled })) {
          throw conflict("clientRequestId already belongs to different comment content");
        }
        return { comment: existing, inserted: false };
      }
      const sourceTrust = await resolveActorSourceTrustForIssue({
        db: tx, issue,
        actor: { actorType: "agent", actorId: input.agentId, agentId: input.agentId, runId: input.runId },
      });
      const saved = await issueService(db).addComment(input.issueId, input.body,
        { agentId: input.agentId, runId: input.runId, onBehalfOfUserId: actor.onBehalfOfUserId },
        { authorType: "agent", authorizationReason, sourceTrust,
          clientRequestId: input.clientRequestId }, tx);
      await logActivity(tx, {
        companyId: input.companyId, actorType: "agent", actorId: input.agentId,
        agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
        action: "issue.comment_added", entityType: "issue", entityId: issue.id,
        details: { commentId: saved.id, bodySnippet: saved.body.slice(0, 120),
          identifier: issue.identifier, issueTitle: issue.title, authorizationReason },
      }, publications);
      return { comment: saved, inserted: true };
    });
    for (const publication of publications) publishActivity(publication);
    // Retry the idempotent projection even when the content command already
    // committed. A previous post-commit failure must not strand references.
    await (deps.syncCommentReferences ?? issueReferenceService(db).syncComment)(result.comment.id);
    return result.comment;
  }

  async function createFencedReviewConfirmation(
    input: LocalRunOwner & { issueId: string; prompt: string; clientRequestId: string;
      reviewerAgentId?: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.clientRequestId)) throw badRequest("clientRequestId must be a UUID");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1000) {
      throw badRequest("A review prompt of at most 1000 characters is required");
    }
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue) => {
        if (input.reviewerAgentId !== undefined) {
          // The canonical interaction creator persists the card, but its
          // addressed-agent wake is still fire-and-forget in the ordinary route.
          // Never leave an agent review card without a durable wake owner.
          throw unprocessable("Agent review requires durable wake delivery", {
            code: "local_run_agent_review_delivery_unavailable",
          });
        }
        if (issue.status !== "in_progress") {
          throw conflict("Review confirmation requires an in-progress task");
        }
        const [existing] = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.idempotencyKey, input.clientRequestId),
          )).limit(1);
        // The existing interaction service owns governance, target validation,
        // supersession and durable chat publication. Passing the locked tx
        // keeps its savepoint and all resulting rows inside the lease fence.
        const interaction = await issueThreadInteractionService(tx).create(issue, {
          kind: "request_confirmation",
          idempotencyKey: input.clientRequestId,
          sourceRunId: input.runId,
          continuationPolicy: "wake_assignee",
          resolverPolicy: "human_only",
          payload: { version: 1, prompt: input.prompt, allowDeclineReason: true },
        }, { agentId: input.agentId, identityContextId: actor.identityContextId ?? null });
        if (!existing) {
          await logActivity(tx, {
            companyId: issue.companyId, actorType: "agent", actorId: input.agentId,
            agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
            action: "issue.thread_interaction_created", entityType: "issue", entityId: issue.id,
            details: {
              interactionId: interaction.id, interactionKind: interaction.kind,
              interactionStatus: interaction.status,
              continuationPolicy: interaction.continuationPolicy,
              addresseeAgentId: null, addresseeUserId: null,
              requestedResolverPolicy: interaction.requestedResolverPolicy,
              effectiveResolverPolicy: interaction.effectiveResolverPolicy,
              resolverPolicyProvenance: interaction.resolverPolicyProvenance,
              effectiveResolverPolicySource: interaction.effectiveResolverPolicySource,
            },
          }, publications);
        }
        return { interaction, replayed: Boolean(existing) };
      });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function reviewFencedIssue(
    input: LocalRunOwner & { issueId: string; body: string;
      reviewInteractionId: string; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.reviewInteractionId) || !UUID.test(input.clientRequestId)) {
      throw badRequest("Review interaction and client request IDs must be UUIDs");
    }
    if (!input.body.trim() || /@|https?:\/\//i.test(input.body)) {
      throw badRequest("Review handoff requires a plain comment without mentions or external links");
    }
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue, authorizationReason) => {
        if (issue.status === "in_review") {
          // The issue execution lock is intentionally cleared by the status
          // transition. Only the exact committed command may replay here.
          const [comment] = await tx.select().from(issueComments).where(and(
            eq(issueComments.issueId, input.issueId),
            eq(issueComments.authorAgentId, input.agentId),
            eq(issueComments.createdByRunId, input.runId),
            eq(issueComments.clientRequestId, input.clientRequestId),
          )).limit(1);
          const enabled = (await instanceSettingsService(tx).getGeneral()).censorUsernameInLogs;
          const [receipt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.entityId, input.issueId),
            eq(activityLog.runId, input.runId),
            eq(activityLog.action, "issue.updated"),
            sql`${activityLog.details}->>'clientRequestId' = ${input.clientRequestId}`,
            sql`${activityLog.details}->>'reviewInteractionId' = ${input.reviewInteractionId}`,
          )).limit(1);
          if (!comment || !receipt || comment.body !== redactCurrentUserText(input.body, { enabled })) {
            throw conflict("Review handoff request differs from the committed command");
          }
          return { issue, comment, replayed: true };
        }
        if (issue.status !== "in_progress") throw conflict("Review handoff requires an in-progress task");
        const lockedIssue = await issueService(db).getByIdForUpdate(input.issueId, tx);
        if (!lockedIssue) throw notFound("Issue not found");
        const handoff = await executeReviewHandoff({
          db, tx, existing: lockedIssue,
          patch: { status: "in_review", actorAgentId: input.agentId,
            companyGuard: input.companyId },
          commentBody: input.body, clientRequestId: input.clientRequestId,
          reviewInteractionId: input.reviewInteractionId,
          actor: {
            agentId: input.agentId, runId: input.runId,
            agentApiKeyId: actor.keyId,
            responsibleUserId: actor.onBehalfOfUserId,
          },
          authorizationReason, publications,
        });
        return { ...handoff, replayed: false };
      }, { allowReviewReplay: true });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function patchFencedIssue(
    input: LocalRunOwner & { issueId: string; title?: string; description?: string | null; priority?: string },
    actor: Express.Request["actor"],
  ) {
    const publications: ActivityPublication[] = [];
    const updated = await withFencedIssueWrite(input, actor, "issue:mutate", async (tx, issue, authorizationReason) => {
      const { issueId, title, description, priority } = input;
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(priority !== undefined ? { priority } : {}),
        actorAgentId: input.agentId, companyGuard: input.companyId,
      };
      const saved = await issueService(db).update(issueId, patch, tx, publications);
      if (!saved) throw notFound("Issue not found");
      const changes = saved.changes ?? {};
      await logActivity(tx, {
        companyId: input.companyId, actorType: "agent", actorId: input.agentId,
        agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
        action: "issue.updated", entityType: "issue", entityId: issue.id,
        details: { identifier: issue.identifier, authorizationReason, changes,
          _previous: Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.from])) },
      }, publications);
      return saved;
    });
    for (const publication of publications) publishActivity(publication);
    return updated;
  }

  return { claim, renew, control, finish, appendFencedEvent,
    addFencedComment, createFencedReviewConfirmation, reviewFencedIssue, patchFencedIssue };
}
