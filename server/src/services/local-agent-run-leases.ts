import type { Db } from "@paperclipai/db";
import { createHash, randomUUID } from "node:crypto";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  agentSessionWriteGrants,
  agentSessionWriteReceipts,
  heartbeatRuns,
  heartbeatRunEvents,
  issueCommandDeliveries,
  issueCompletionReviews,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  localAgentRunLeases,
  localRunWriteReceipts,
  localRunFinishReceipts,
  localIssueCompletionCommands,
  localDefectRepairHandoffs,
  localDefectQaVerdictCommands,
  localPoVerdictCommands,
  workRecordIssueLinks,
  workRecordDispatchBatches,
  workRecordDispatchBatchItems,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordExecutionIntents,
  workRecords,
} from "@paperclipai/db";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { HttpError, badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { accessService } from "./access.js";
import { assertBoundLocalDevice } from "./local-agent-device-bindings.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { externalObjectService } from "./external-objects.js";
import { issueService, type IssuePostCommitAction } from "./issues.js";
import { issueReferenceService } from "./issue-references.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { executeReviewHandoff } from "./issue-review-handoff.js";
import { issueCommandDeliveryService } from "./issue-command-deliveries.js";
import { ISSUE_COMPLETION_REVIEW_TARGET_KEY } from "./issue-completion-review-contract.js";
import { assertClientPullAcceptedReviewContext, assertClientPullRejectedReviewContext,
  assertClientPullReviewClaimCandidate,
  assertClientPullReviewEventContext,
  CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON,
  retireStaleClientPullReviewQueuedRun,
  STALE_REVIEW_CLAIM_CODE } from "./local-agent-review-claim.js";
import { assertDefectQaClaimCandidate, CLIENT_PULL_DEFECT_QA_WAKE_REASON,
  defectQaRunChanged, deliverPendingDefectQaForAgent,
  readClaimedDefectQaContext, retireStaleDefectQaQueuedRun,
  settleFailedDefectQaRun } from "./local-agent-defect-qa.js";
import { instanceSettingsService } from "./instance-settings.js";
import { lockWorkRecordQualityAggregate, workRecordQualityService } from "./work-record-quality.js";
import { resolveWorkRecordWorkflowV2Rollout } from "./work-record-workflow-v2-rollout.js";
import { recordPoQualityVerdictSchema, recordQaQualityVerdictSchema,
  type RecordPoQualityVerdict } from "@paperclipai/shared";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

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

function localCommentIntentDigest(input: { runId: string; issueId: string;
  agentId: string; deviceId: string; body: string }) {
  return createHash("sha256").update(JSON.stringify({
    kind: "comment", runId: input.runId, issueId: input.issueId,
    agentId: input.agentId, deviceId: input.deviceId,
    canonicalContent: input.body,
  })).digest("hex");
}

function localFinishRequestDigest(input: LocalRunOwner & { issueId: string;
  outcome: "succeeded" | "failed" | "cancelled"; exitCode: number | null;
  summary?: string }) {
  return createHash("sha256").update(JSON.stringify({
    kind: "finish", runId: input.runId, issueId: input.issueId,
    agentId: input.agentId, deviceId: input.deviceId,
    canonicalContent: JSON.stringify({ outcome: input.outcome,
      exitCode: input.exitCode, processStopped: true,
      summary: input.summary ?? null }),
  })).digest("hex");
}

type PreparedWriteKind = "child_complete" | "defect_repair_handoff" |
  "po_verdict" | "defect_qa_verdict" | "completion_review_handoff" | "subtask_create";

async function recordPreparedWriteReceipt(tx: Db, input: LocalRunOwner & {
  issueId: string; clientRequestId: string }, kind: PreparedWriteKind,
  canonicalContent: string, sourceReceiptId: string) {
  const requestDigest = createHash("sha256").update(JSON.stringify({
    kind, runId: input.runId, issueId: input.issueId,
    agentId: input.agentId, deviceId: input.deviceId, canonicalContent,
  })).digest("hex");
  await tx.insert(localRunWriteReceipts).values({
    companyId: input.companyId, runId: input.runId, issueId: input.issueId,
    agentId: input.agentId, deviceId: input.deviceId,
    clientRequestId: input.clientRequestId, kind, requestDigest, sourceReceiptId,
  });
}

export function localAgentRunLeaseService(
  db: Db,
  deps: {
    syncCommentReferences?: (commentId: string, tx: Db) => Promise<void>;
    syncCommentExternalObjects?: (commentId: string, tx: Db) => Promise<void>;
    workRecordWorkflowV2WritesEnabled?: boolean;
  } = {},
) {
  async function leaseTtlMs(tx: Db, runId: string) {
    const [row] = await tx.select({
      value: sql<number>`greatest(0, floor(extract(epoch from (${localAgentRunLeases.expiresAt} - now())) * 1000))::integer`,
    }).from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, runId));
    return row?.value ?? 0;
  }

  async function dedicatedReviewChanged(tx: Db,
    run: typeof heartbeatRuns.$inferSelect,
    lease: typeof localAgentRunLeases.$inferSelect) {
    if (wakeReasonFromRun(run) !== CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON) return false;
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, lease.issueId), eq(issues.companyId, lease.companyId),
    )).for("update");
    if (!issue) return true;
    try {
      await assertClientPullReviewEventContext(tx, { run, issue });
      return false;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        try {
          await assertClientPullAcceptedReviewContext(tx, { run, issue });
          return false;
        } catch (acceptedError) {
          if (acceptedError instanceof HttpError && acceptedError.status === 409) {
            try {
              await assertClientPullRejectedReviewContext(tx, { run, issue });
              return false;
            } catch (rejectedError) {
              if (rejectedError instanceof HttpError && rejectedError.status === 409) return true;
              throw rejectedError;
            }
          }
          throw acceptedError;
        }
      }
      throw error;
    }
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
    const publications: ActivityPublication[] = [];
    const claimedRun = await db.transaction(async (tx) => {
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
        if (await defectQaRunChanged(tx as unknown as Db, run, sameClaim)) {
          throw conflict("Independent defect QA claim changed after its first receipt");
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

      const [pendingSessionWrite] = await tx.select({ id: agentSessionWriteReceipts.id })
        .from(agentSessionWriteReceipts)
        .innerJoin(agentSessionWriteGrants, eq(agentSessionWriteReceipts.grantId, agentSessionWriteGrants.id))
        .where(and(
          eq(agentSessionWriteReceipts.companyId, input.companyId),
          eq(agentSessionWriteReceipts.agentId, input.agentId),
          isNull(agentSessionWriteReceipts.completedAt),
          isNull(agentSessionWriteGrants.revokedAt),
          sql`${agentSessionWriteGrants.expiresAt} > now()`,
        )).limit(1);
      if (pendingSessionWrite) {
        throw conflict("An ordinary-session write is still in progress", {
          code: "SESSION_WRITE_IN_PROGRESS",
        });
      }

      const [serverRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
      )).limit(1);
      if (serverRun) throw conflict("Agent already has a running server run");

      await deliverPendingDefectQaForAgent(tx as unknown as Db, agent);

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
        if (wakeReasonFromRun(run) === CLIENT_PULL_DEFECT_QA_WAKE_REASON) {
          const candidate = await assertDefectQaClaimCandidate(db,
            tx as unknown as Db, { agent, run });
          if (candidate.kind === "stale") {
            await retireStaleDefectQaQueuedRun(tx as unknown as Db, run);
            continue;
          }
          if (candidate.kind === "blocked") continue;
          const { issue, wake } = candidate;
          if (issue.id !== issueId) throw conflict("Independent defect QA issue changed");
          const [claimed] = await tx.update(heartbeatRuns).set({
            status: "running", startedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(and(eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "queued"),
            eq(heartbeatRuns.runtimeMode, "client_pull"))).returning();
          if (!claimed) throw conflict("Independent defect QA run changed before claim");
          const [claimedWake] = await tx.update(agentWakeupRequests).set({
            status: "claimed", claimedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(and(eq(agentWakeupRequests.id, wake.id),
            eq(agentWakeupRequests.status, "queued"))).returning();
          if (!claimedWake || claimedWake.runId !== run.id) {
            throw conflict("Independent defect QA wake changed before claim");
          }
          const [owned] = await tx.update(issues).set({
            executionRunId: run.id, executionLockedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId),
            eq(issues.status, "in_review"), eq(issues.statusVersion, issue.statusVersion),
            eq(issues.assigneeAgentId, agent.id), isNull(issues.executionRunId))).returning();
          if (!owned) throw conflict("Independent defect QA ownership changed before claim");
          const [lease] = await tx.insert(localAgentRunLeases).values({
            runId: run.id, companyId: input.companyId, agentId: input.agentId,
            issueId, deviceId: input.deviceId, deviceKeyId: input.keyId,
            idempotencyKey: input.idempotencyKey,
            expiresAt: sql`now() + interval '90 seconds'`,
          }).returning();
          return { runId: run.id, issueId, agentId: input.agentId,
            leaseId: lease.leaseId, generation: lease.generation,
            leaseExpiresAt: lease.expiresAt, wakeReason: CLIENT_PULL_DEFECT_QA_WAKE_REASON,
            leaseTtlMs: await leaseTtlMs(tx as unknown as Db, run.id),
            workspacePolicy: "agent_home" as const };
        }
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, issueId), eq(issues.companyId, input.companyId),
        )).for("update");
        if (wakeReasonFromRun(run) === CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON) {
          if (!issue) throw conflict("Dedicated reviewer task no longer exists");
          // A reviewer is deliberately not the issue assignee. Keep the source
          // issue's execution ownership untouched throughout this claim.
          try {
            await assertClientPullReviewClaimCandidate(db, tx as unknown as Db,
              { agent, run, issue });
          } catch (error) {
            if (error instanceof HttpError && error.status === 409 &&
              (error.details as { code?: unknown } | undefined)?.code === STALE_REVIEW_CLAIM_CODE) {
              await retireStaleClientPullReviewQueuedRun(tx as unknown as Db, run);
              continue;
            }
            throw error;
          }
          const dependency = await issueService(db).getDependencyReadiness(issueId, tx);
          if (!dependency.isDependencyReady ||
            await getExecutionBlocker(tx as unknown as Db, input.companyId, issueId)) {
            throw conflict("Dedicated review task is blocked");
          }
          const [claimed] = await tx.update(heartbeatRuns).set({
            status: "running", startedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(and(eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "queued"),
            eq(heartbeatRuns.runtimeMode, "client_pull"))).returning();
          if (!claimed) throw conflict("Dedicated reviewer run changed before claim");
          const [wake] = await tx.update(agentWakeupRequests).set({
            status: "claimed", claimedAt: sql`now()`, updatedAt: sql`now()`,
          }).where(and(eq(agentWakeupRequests.id, run.wakeupRequestId!),
            eq(agentWakeupRequests.status, "queued"))).returning();
          if (!wake || wake.runId !== run.id) {
            throw conflict("Dedicated reviewer wake changed before claim");
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
        if (issue.status === "todo") {
          const postCommitActions: IssuePostCommitAction[] = [];
          const started = await issueService(db).update(issue.id, {
            companyGuard: input.companyId, actorAgentId: input.agentId,
            status: "in_progress",
          }, tx, publications, postCommitActions);
          if (!started || started.status !== "in_progress" ||
            started.statusVersion !== issue.statusVersion + 1 ||
            postCommitActions.length > 0) {
            throw conflict("Could not safely start the claimed local task");
          }
        }
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
    for (const publication of publications) publishActivity(publication);
    return claimedRun;
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
        Boolean(lease.releasedAt) || Boolean(binding.revokedAt) ||
        await dedicatedReviewChanged(tx as unknown as Db, run, lease) ||
        await defectQaRunChanged(tx as unknown as Db, run, lease);
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
      if (await dedicatedReviewChanged(tx as unknown as Db, run, lease) ||
        await defectQaRunChanged(tx as unknown as Db, run, lease)) {
        await tx.update(localAgentRunLeases).set({
          cancelRequestedAt: sql`now()`, updatedAt: sql`now()`,
        }).where(eq(localAgentRunLeases.runId, input.runId));
        return { leaseExpiresAt: lease.expiresAt, cancelRequested: true };
      }
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
    const publications: ActivityPublication[] = [];
    const finished = await db.transaction(async (tx) => {
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
      // A source run can create one dedicated review before it stops. The run
      // lock prevents another source command from adding a review meanwhile.
      const reviews = await tx.select().from(issueCompletionReviews).where(and(
        eq(issueCompletionReviews.companyId, input.companyId),
        eq(issueCompletionReviews.issueId, lease.issueId),
        eq(issueCompletionReviews.sourceRunId, input.runId),
        eq(issueCompletionReviews.sourceKind, "client_pull"),
      )).limit(2);
      if (reviews.length > 1) throw conflict("Run has multiple completion reviews; reconcile before finishing");
      const reviewHint = reviews[0] ?? null;
      const childCompletions = await tx.select().from(localIssueCompletionCommands).where(and(
        eq(localIssueCompletionCommands.companyId, input.companyId),
        eq(localIssueCompletionCommands.issueId, lease.issueId),
        eq(localIssueCompletionCommands.runId, input.runId),
      )).limit(2);
      if (childCompletions.length > 1 || (childCompletions.length > 0 && reviewHint)) {
        throw conflict("Run has conflicting completion dispositions");
      }
      const childCompletion = childCompletions[0] ?? null;
      const poCommands = await tx.select().from(localPoVerdictCommands).where(and(
        eq(localPoVerdictCommands.companyId, input.companyId),
        eq(localPoVerdictCommands.issueId, lease.issueId),
        eq(localPoVerdictCommands.runId, input.runId),
      )).limit(2);
      if (poCommands.length > 1 || (poCommands.length > 0 &&
        (reviewHint || childCompletion))) {
        throw conflict("Run has conflicting quality dispositions");
      }
      const poCommand = poCommands[0] ?? null;
      const defectHandoffs = await tx.select().from(localDefectRepairHandoffs).where(and(
        eq(localDefectRepairHandoffs.companyId, input.companyId),
        eq(localDefectRepairHandoffs.issueId, lease.issueId),
        eq(localDefectRepairHandoffs.runId, input.runId),
      )).limit(2);
      if (defectHandoffs.length > 1 || (defectHandoffs.length > 0 &&
        (reviewHint || childCompletion || poCommand))) {
        throw conflict("Run has conflicting defect repair dispositions");
      }
      const defectHandoff = defectHandoffs[0] ?? null;
      const qaCommands = await tx.select().from(localDefectQaVerdictCommands).where(and(
        eq(localDefectQaVerdictCommands.companyId, input.companyId),
        eq(localDefectQaVerdictCommands.issueId, lease.issueId),
        eq(localDefectQaVerdictCommands.runId, input.runId),
      )).limit(2);
      if (qaCommands.length > 1 || (qaCommands.length > 0 &&
        (reviewHint || childCompletion || poCommand || defectHandoff))) {
        throw conflict("Run has conflicting QA dispositions");
      }
      const qaCommand = qaCommands[0] ?? null;
      const reviewerRun = wakeReasonFromRun(run) === CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON;
      const qaRun = wakeReasonFromRun(run) === CLIENT_PULL_DEFECT_QA_WAKE_REASON;
      if ((qaRun && input.outcome === "succeeded" && !qaCommand) ||
        (qaCommand && !qaRun)) {
        throw conflict("Independent defect QA cannot finish successfully without a fenced verdict");
      }
      const reviewerReviewId = reviewerRun ? run.contextSnapshot?.reviewId : null;
      if (reviewerRun && typeof reviewerReviewId !== "string") {
        throw conflict("Dedicated reviewer run lacks a review identity");
      }
      if ((reviewHint || reviewerRun || childCompletion || poCommand || defectHandoff || qaCommand || qaRun) &&
        !input.clientRequestId) {
        throw badRequest("Completion finish requires clientRequestId");
      }
      if (lease.releasedAt) {
        if (lease.outcome !== input.outcome) throw conflict("Run already finished with another outcome");
        if (input.clientRequestId || reviewHint || reviewerRun || childCompletion || poCommand || defectHandoff || qaCommand || qaRun) {
          const saved = run.resultJson?.localWorkerFinish;
          const [savedDelivery] = reviewHint ? await tx.select({ id: issueCommandDeliveries.id })
            .from(issueCommandDeliveries).where(and(
              eq(issueCommandDeliveries.companyId, input.companyId),
              eq(issueCommandDeliveries.reviewId, reviewHint.id),
              eq(issueCommandDeliveries.kind, "completion_review"),
            )) : [];
          if (!saved || typeof saved !== "object" ||
            (saved as Record<string, unknown>).clientRequestId !== input.clientRequestId ||
            (saved as Record<string, unknown>).outcome !== input.outcome ||
            (saved as Record<string, unknown>).exitCode !== input.exitCode ||
            (saved as Record<string, unknown>).summary !== (input.summary ?? null) ||
            ((saved as Record<string, unknown>).requestDigest !== undefined &&
              (saved as Record<string, unknown>).requestDigest !== localFinishRequestDigest({
                ...input, issueId: lease.issueId })) ||
            (reviewerRun && ((saved as Record<string, unknown>).reviewerReviewId !== reviewerReviewId ||
              (input.outcome === "succeeded"
                ? !["accepted", "rejected"].includes(String(
                    (saved as Record<string, unknown>).reviewerDisposition))
                : !["accepted", "rejected", "blocked", "preserved"].includes(String(
                    (saved as Record<string, unknown>).reviewerDisposition))))) ||
            (childCompletion && ((saved as Record<string, unknown>).childCompletionId !== childCompletion.id ||
              (saved as Record<string, unknown>).childCompletionDisposition !== childCompletion.state)) ||
            (poCommand && ((saved as Record<string, unknown>).poCommandId !== poCommand.id ||
              (saved as Record<string, unknown>).poDisposition !== poCommand.state ||
              (poCommand.state === "committed" &&
                (saved as Record<string, unknown>).poVerdictId !== poCommand.verdictId))) ||
            (defectHandoff && ((saved as Record<string, unknown>).defectHandoffId !== defectHandoff.id ||
              (saved as Record<string, unknown>).defectHandoffDisposition !== defectHandoff.state ||
              (defectHandoff.state === "submitted" &&
                (saved as Record<string, unknown>).defectSubmittedStatusVersion !== defectHandoff.submittedStatusVersion))) ||
            (qaCommand && ((saved as Record<string, unknown>).qaCommandId !== qaCommand.id ||
              (saved as Record<string, unknown>).qaDisposition !== qaCommand.state ||
              (qaCommand.state === "committed" &&
                ((saved as Record<string, unknown>).qaVerdictId !== qaCommand.verdictId ||
                  (saved as Record<string, unknown>).qaEscalated !== qaCommand.escalated)))) ||
            (reviewHint && ((saved as Record<string, unknown>).reviewId !== reviewHint.id ||
              (saved as Record<string, unknown>).deliveryId !== savedDelivery?.id ||
              !["ready", "blocked", "preserved"].includes(String((saved as Record<string, unknown>).disposition))))) {
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
      let reviewReceipt: { reviewId: string; deliveryId: string; issueStatus: string;
        issueStatusVersion: number; disposition: "ready" | "blocked" | "preserved" } | null = null;
      let reviewerReceipt: { reviewerReviewId: string;
        reviewerDisposition: "accepted" | "rejected" | "blocked" | "preserved";
        decisionRequestId?: string; issueStatus?: string; issueStatusVersion?: number } | null = null;
      let childReceipt: { childCompletionId: string;
        childCompletionDisposition: "completed" | "aborted";
        childCompletedStatusVersion?: number } | null = null;
      let poReceipt: { poCommandId: string; poDisposition: "committed" | "aborted";
        poVerdictId?: string; poNextCycleId?: string | null } | null = null;
      let defectReceipt: { defectHandoffId: string;
        defectHandoffDisposition: "submitted" | "aborted";
        defectSubmittedStatusVersion?: number } | null = null;
      let qaReceipt: { qaCommandId: string; qaDisposition: "committed" | "aborted";
        qaVerdictId?: string; qaNextCycleId?: string | null; qaEscalated?: boolean } | null = null;
      let qaDeliveryDisposition: "retry_ready" | "attention_required" | null = null;
      if (reviewerRun) {
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
        )).for("update");
        if (!issue) throw conflict("Dedicated review issue is missing");
        if (input.outcome === "succeeded") {
          if (cancelled) throw conflict("Cancelled reviewer run cannot finish successfully");
          try {
            const accepted = await assertClientPullAcceptedReviewContext(tx as unknown as Db, { run, issue });
            reviewerReceipt = { reviewerReviewId: accepted.reviewId,
              reviewerDisposition: "accepted", decisionRequestId: accepted.decisionRequestId };
          } catch (acceptedError) {
            if (!(acceptedError instanceof HttpError) || acceptedError.status !== 409) throw acceptedError;
            const rejected = await assertClientPullRejectedReviewContext(tx as unknown as Db, { run, issue });
            reviewerReceipt = { reviewerReviewId: rejected.reviewId,
              reviewerDisposition: "rejected", decisionRequestId: rejected.decisionRequestId };
          }
        } else {
          const [decidedReview] = await tx.select({ state: issueCompletionReviews.state })
            .from(issueCompletionReviews).where(and(
              eq(issueCompletionReviews.id, reviewerReviewId as string),
              eq(issueCompletionReviews.companyId, input.companyId),
              eq(issueCompletionReviews.issueId, issue.id),
            )).limit(1);
          if (decidedReview?.state === "accepted") {
            const accepted = await assertClientPullAcceptedReviewContext(tx as unknown as Db, { run, issue });
            reviewerReceipt = { reviewerReviewId: accepted.reviewId,
              reviewerDisposition: "accepted", decisionRequestId: accepted.decisionRequestId };
          } else if (decidedReview?.state === "rejected") {
            const rejected = await assertClientPullRejectedReviewContext(tx as unknown as Db, { run, issue });
            reviewerReceipt = { reviewerReviewId: rejected.reviewId,
              reviewerDisposition: "rejected", decisionRequestId: rejected.decisionRequestId };
          } else {
          const context = run.contextSnapshot ?? {};
          const [delivery] = await tx.select().from(issueCommandDeliveries).where(and(
            eq(issueCommandDeliveries.companyId, input.companyId),
            eq(issueCommandDeliveries.issueId, issue.id),
            eq(issueCommandDeliveries.reviewId, reviewerReviewId as string),
            eq(issueCommandDeliveries.kind, "completion_review"),
          )).for("update");
          const [review] = await tx.select().from(issueCompletionReviews).where(and(
            eq(issueCompletionReviews.id, reviewerReviewId as string),
            eq(issueCompletionReviews.companyId, input.companyId),
            eq(issueCompletionReviews.issueId, issue.id),
          )).for("update");
          const [card] = review ? await tx.select().from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.id, review.interactionId),
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
          )).for("update") : [];
          const payload = card?.payload && typeof card.payload === "object"
            ? card.payload as unknown as Record<string, unknown> : {};
          const target = payload.target && typeof payload.target === "object"
            ? payload.target as Record<string, unknown> : {};
          if (!review || !card || !delivery ||
            context.issueId !== issue.id || context.reviewId !== review.id ||
            context.interactionId !== card.id || context.sourceRunId !== review.sourceRunId ||
            review.sourceKind !== "client_pull" || review.companyId !== input.companyId ||
            review.reviewerAgentId !== input.agentId || review.sourceAgentId !== issue.assigneeAgentId ||
            review.clientPullLeaseRunId !== review.sourceRunId ||
            delivery.interactionId !== card.id || delivery.targetAgentId !== input.agentId ||
            delivery.sourceRunId !== review.sourceRunId || delivery.status !== "delivered" ||
            card.kind !== "request_confirmation" || card.sourceRunId !== review.sourceRunId ||
            card.createdByAgentId !== review.sourceAgentId || card.addresseeAgentId !== input.agentId ||
            card.addresseeUserId !== null || card.effectiveResolverPolicy !== "not_creator" ||
            target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
            target.revisionId !== review.id) {
            throw conflict("Dedicated reviewer evidence changed before unsuccessful finish");
          }
          const current = issue.status === "in_review" &&
            issue.statusVersion === review.issueStatusVersion &&
            issue.executionRunId === null && review.state === "pending" &&
            card.status === "pending";
          if (current) {
            await assertClientPullReviewEventContext(tx as unknown as Db, { run, issue });
            const postCommitActions: IssuePostCommitAction[] = [];
            const blocked = await issueService(db).update(issue.id, {
              status: "blocked", actorAgentId: input.agentId, companyGuard: input.companyId,
            }, tx, publications, postCommitActions);
            if (!blocked || blocked.status !== "blocked" || postCommitActions.length > 0) {
              throw conflict("Could not safely block the failed reviewer task");
            }
            const [cancelledReview] = await tx.select({ state: issueCompletionReviews.state })
              .from(issueCompletionReviews).where(eq(issueCompletionReviews.id, review.id));
            const [expiredCard] = await tx.select({ status: issueThreadInteractions.status })
              .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
            if (cancelledReview?.state !== "cancelled" || expiredCard?.status !== "expired") {
              throw conflict("Failed reviewer card was not cancelled with the task");
            }
            await logActivity(tx as unknown as Db, {
              companyId: input.companyId, actorType: "agent", actorId: input.agentId,
              agentId: input.agentId, runId: input.runId,
              action: "issue.completion_review_reviewer_run_failed", entityType: "issue",
              entityId: issue.id, issueId: issue.id,
              details: { reviewId: review.id, interactionId: card.id,
                outcome: input.outcome, exitCode: input.exitCode,
                reason: "reviewer_process_stopped_before_decision" },
            }, publications);
            reviewerReceipt = { reviewerReviewId: review.id,
              reviewerDisposition: "blocked", issueStatus: blocked.status,
              issueStatusVersion: blocked.statusVersion };
          } else if (review.state === "cancelled" &&
            ["cancelled", "expired"].includes(card.status) &&
            (issue.status !== "in_review" || issue.statusVersion !== review.issueStatusVersion ||
              issue.assigneeAgentId !== review.sourceAgentId)) {
            reviewerReceipt = { reviewerReviewId: review.id,
              reviewerDisposition: "preserved", issueStatus: issue.status,
              issueStatusVersion: issue.statusVersion };
          } else {
            throw conflict("Pending or accepted reviewer decision cannot finish unsuccessfully");
          }
          }
        }
      }
      if (reviewHint) {
        // The issue lock serializes human edits and review decisions. Other
        // paths use issue -> delivery -> review -> interaction ordering too.
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
        )).for("update");
        const [delivery] = await tx.select().from(issueCommandDeliveries).where(and(
          eq(issueCommandDeliveries.companyId, input.companyId),
          eq(issueCommandDeliveries.issueId, lease.issueId),
          eq(issueCommandDeliveries.reviewId, reviewHint.id),
          eq(issueCommandDeliveries.kind, "completion_review"),
        )).for("update");
        const [review] = await tx.select().from(issueCompletionReviews).where(and(
          eq(issueCompletionReviews.id, reviewHint.id),
          eq(issueCompletionReviews.companyId, input.companyId),
        )).for("update");
        const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, reviewHint.interactionId),
          eq(issueThreadInteractions.companyId, input.companyId),
        )).for("update");
        const payload = interaction?.payload && typeof interaction.payload === "object"
          ? interaction.payload as unknown as Record<string, unknown> : {};
        const target = payload.target && typeof payload.target === "object"
          ? payload.target as Record<string, unknown> : {};
        if (!issue || !delivery || !review || !interaction ||
          review.issueId !== issue.id || review.companyId !== input.companyId ||
          delivery.companyId !== input.companyId || delivery.issueId !== issue.id ||
          interaction.companyId !== input.companyId || interaction.issueId !== issue.id ||
          review.sourceAgentId !== input.agentId || review.clientPullLeaseRunId !== input.runId ||
          review.interactionId !== interaction.id || review.reviewerAgentId !== delivery.targetAgentId ||
          delivery.interactionId !== interaction.id || delivery.sourceRunId !== input.runId ||
          interaction.kind !== "request_confirmation" ||
          interaction.sourceRunId !== input.runId ||
          interaction.createdByAgentId !== input.agentId ||
          interaction.addresseeAgentId !== review.reviewerAgentId ||
          interaction.addresseeUserId !== null ||
          interaction.effectiveResolverPolicy !== "not_creator" ||
          target.type !== "custom" || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
          target.revisionId !== review.id) {
          throw conflict("Dedicated review evidence changed before finish");
        }
        const current = issue.status === "in_review" &&
          issue.statusVersion === review.issueStatusVersion &&
          issue.assigneeAgentId === input.agentId && review.state === "pending" &&
          interaction.status === "pending" && delivery.status === "awaiting_handoff";
        if (current && status === "succeeded") {
          reviewReceipt = { reviewId: review.id, deliveryId: delivery.id,
            issueStatus: issue.status, issueStatusVersion: issue.statusVersion,
            disposition: "ready" };
        } else if (current) {
          const blocked = await issueService(db).update(issue.id, {
            status: "blocked", actorAgentId: input.agentId, companyGuard: input.companyId,
          }, tx, publications);
          if (!blocked || blocked.status !== "blocked") {
            throw conflict("Could not return failed review handoff to a recoverable task");
          }
          reviewReceipt = { reviewId: review.id, deliveryId: delivery.id,
            issueStatus: blocked.status, issueStatusVersion: blocked.statusVersion,
            disposition: "blocked" };
        } else {
          // A human already changed the task or review. Stop the process but
          // never overwrite their newer state.
          if (issue.status === "in_review" &&
            issue.statusVersion === review.issueStatusVersion &&
            issue.assigneeAgentId === input.agentId) {
            throw conflict("Current review evidence is incomplete; reconcile before finishing");
          }
          if (review.state === "pending" && interaction.status === "pending") {
            throw conflict("Review revision changed without cancellation; reconcile before finishing");
          }
          reviewReceipt = { reviewId: review.id, deliveryId: delivery.id,
            issueStatus: issue.status, issueStatusVersion: issue.statusVersion,
            disposition: "preserved" };
        }
      }
      if (childCompletion) {
        if (childCompletion.state !== "prepared" || reviewerRun ||
          childCompletion.companyId !== input.companyId ||
          childCompletion.issueId !== lease.issueId) {
          throw conflict("Child completion receipt is no longer prepared");
        }
        if (status === "succeeded") {
          const [issue] = await tx.select().from(issues).where(and(
            eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
          )).for("update");
          const [comment] = childCompletion.commentId
            ? await tx.select({ id: issueComments.id }).from(issueComments).where(and(
                eq(issueComments.id, childCompletion.commentId),
                eq(issueComments.companyId, input.companyId),
                eq(issueComments.issueId, lease.issueId),
              )) : [];
          if (!issue || !comment || issue.status !== "in_progress" ||
            issue.statusVersion !== childCompletion.preparedStatusVersion ||
            issue.assigneeAgentId !== input.agentId || issue.executionRunId !== input.runId) {
            throw conflict("Child task changed before its process stopped");
          }
          const postCommitActions: IssuePostCommitAction[] = [];
          const completed = await issueService(db).update(issue.id, {
            status: "done", actorAgentId: input.agentId,
            companyGuard: input.companyId,
          }, tx, publications, postCommitActions);
          if (!completed || completed.status !== "done" ||
            completed.statusVersion !== issue.statusVersion + 1 ||
            postCommitActions.length > 0) {
            throw conflict("Could not safely complete the stopped child process");
          }
          await tx.update(localIssueCompletionCommands).set({
            state: "completed", completedStatusVersion: completed.statusVersion,
          }).where(eq(localIssueCompletionCommands.id, childCompletion.id));
          await logActivity(tx as unknown as Db, {
            companyId: input.companyId, actorType: "agent", actorId: input.agentId,
            agentId: input.agentId, runId: input.runId,
            action: "work_record.child_execution_completed", entityType: "issue",
            entityId: issue.id, issueId: issue.id,
            details: { recordId: childCompletion.recordId,
              receiptId: childCompletion.id,
              statusVersion: completed.statusVersion },
          }, publications);
          childReceipt = { childCompletionId: childCompletion.id,
            childCompletionDisposition: "completed",
            childCompletedStatusVersion: completed.statusVersion };
        } else {
          await tx.update(localIssueCompletionCommands).set({ state: "aborted" })
            .where(eq(localIssueCompletionCommands.id, childCompletion.id));
          childReceipt = { childCompletionId: childCompletion.id,
            childCompletionDisposition: "aborted" };
        }
      }
      if (poCommand) {
        if (poCommand.state !== "prepared" || reviewerRun ||
          poCommand.companyId !== input.companyId || poCommand.issueId !== lease.issueId) {
          throw conflict("PO decision receipt is no longer prepared");
        }
        if (status === "succeeded") {
          // The quality domain takes its advisory lock before cycle, item and
          // issue locks. Keep that order here; it rechecks every revision.
          await lockWorkRecordQualityAggregate(tx, input.companyId, poCommand.recordId);
          await tx.select({ id: workRecordQualityCycles.id })
            .from(workRecordQualityCycles).where(and(
              eq(workRecordQualityCycles.companyId, input.companyId),
              eq(workRecordQualityCycles.id, poCommand.payload.cycleId),
            )).for("update");
          await tx.select({ id: workRecordQualityItems.id })
            .from(workRecordQualityItems).where(and(
              eq(workRecordQualityItems.companyId, input.companyId),
              eq(workRecordQualityItems.id, poCommand.payload.itemId),
            )).for("update");
          const [current] = await tx.select({
            status: issues.status, statusVersion: issues.statusVersion,
            executionRunId: issues.executionRunId,
            assigneeAgentId: issues.assigneeAgentId,
          }).from(issues).where(and(
            eq(issues.id, poCommand.issueId), eq(issues.companyId, input.companyId),
          )).for("update");
          if (!current || current.status !== "in_progress" ||
            current.statusVersion !== poCommand.preparedStatusVersion ||
            current.executionRunId !== input.runId ||
            current.assigneeAgentId !== input.agentId) {
            throw conflict("PO package task changed before its process stopped");
          }
          const decided = await workRecordQualityService(db, {
            writesEnabled: deps.workRecordWorkflowV2WritesEnabled,
          }).commitPoVerdictInTransaction(tx, input.companyId,
            poCommand.projectId, poCommand.recordId, poCommand.payload,
            { actorType: "agent", actorId: input.agentId,
              agentId: input.agentId, runId: input.runId });
          if (decided.replayed) throw conflict("PO verdict was already committed outside this run");
          await tx.update(localPoVerdictCommands).set({ state: "committed",
            verdictId: decided.verdict.id, committedAt: sql`now()` })
            .where(eq(localPoVerdictCommands.id, poCommand.id));
          poReceipt = { poCommandId: poCommand.id, poDisposition: "committed",
            poVerdictId: decided.verdict.id, poNextCycleId: decided.nextCycleId };
        } else {
          await tx.update(localPoVerdictCommands).set({ state: "aborted" })
            .where(eq(localPoVerdictCommands.id, poCommand.id));
          poReceipt = { poCommandId: poCommand.id, poDisposition: "aborted" };
        }
      }
      if (defectHandoff) {
        if (defectHandoff.state !== "prepared" || reviewerRun ||
          defectHandoff.companyId !== input.companyId ||
          defectHandoff.issueId !== lease.issueId) {
          throw conflict("Defect repair handoff is no longer prepared");
        }
        if (status === "succeeded") {
          await lockWorkRecordQualityAggregate(tx, input.companyId, defectHandoff.recordId);
          const [cycle] = await tx.select().from(workRecordQualityCycles).where(and(
            eq(workRecordQualityCycles.companyId, input.companyId),
            eq(workRecordQualityCycles.id, defectHandoff.cycleId),
          )).for("update");
          const items = await tx.select().from(workRecordQualityItems).where(and(
            eq(workRecordQualityItems.companyId, input.companyId),
            inArray(workRecordQualityItems.id,
              [defectHandoff.repairItemId, defectHandoff.qaItemId]),
          )).orderBy(asc(workRecordQualityItems.id)).for("update");
          const repair = items.find((item) => item.id === defectHandoff.repairItemId);
          const qa = items.find((item) => item.id === defectHandoff.qaItemId);
          const [record] = await tx.select().from(workRecords).where(and(
            eq(workRecords.companyId, input.companyId),
            eq(workRecords.id, defectHandoff.recordId),
          )).for("update");
          const [link] = await tx.select().from(workRecordIssueLinks).where(and(
            eq(workRecordIssueLinks.companyId, input.companyId),
            eq(workRecordIssueLinks.projectId, defectHandoff.projectId),
            eq(workRecordIssueLinks.recordId, defectHandoff.recordId),
            eq(workRecordIssueLinks.issueId, defectHandoff.issueId),
            eq(workRecordIssueLinks.purpose, "primary"),
          )).for("update");
          const [issue] = await tx.select().from(issues).where(and(
            eq(issues.companyId, input.companyId),
            eq(issues.id, defectHandoff.issueId),
          )).for("update");
          const [comment] = await tx.select().from(issueComments).where(and(
            eq(issueComments.id, defectHandoff.commentId),
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.issueId, defectHandoff.issueId),
            eq(issueComments.authorAgentId, input.agentId),
            eq(issueComments.createdByRunId, input.runId),
          ));
          const [oldReview] = await tx.select({ id: issueCompletionReviews.id })
            .from(issueCompletionReviews).where(and(
              eq(issueCompletionReviews.companyId, input.companyId),
              eq(issueCompletionReviews.issueId, defectHandoff.issueId),
              eq(issueCompletionReviews.state, "pending"),
            )).limit(1);
          if (!cycle || cycle.projectId !== defectHandoff.projectId ||
            cycle.kind !== "independent_defect" || cycle.state !== "open" ||
            cycle.qualityPhase !== "waiting_fix" ||
            cycle.aggregateRecordId !== defectHandoff.recordId ||
            cycle.revision !== defectHandoff.preparedCycleRevision ||
            !repair || repair.cycleId !== cycle.id || repair.projectId !== cycle.projectId ||
            repair.recordId !== defectHandoff.recordId ||
            repair.defectRecordId !== defectHandoff.recordId || repair.role !== "repair" ||
            !repair.required || repair.issueLinkId !== link?.id ||
            !["ready", "active"].includes(repair.state) ||
            !qa || qa.cycleId !== cycle.id || qa.projectId !== cycle.projectId ||
            qa.recordId !== defectHandoff.recordId ||
            qa.defectRecordId !== defectHandoff.recordId || qa.role !== "qa" ||
            !qa.required || qa.issueLinkId !== link?.id ||
            !["blocked", "waiting"].includes(qa.state) ||
            !record || record.kind !== "defect" || record.parentRecordId ||
            record.projectId !== defectHandoff.projectId ||
            record.assigneeAgentId !== input.agentId ||
            record.qaAssigneeAgentId !== defectHandoff.qaAgentId ||
            record.dispatchState === "not_dispatched" || !link ||
            !issue || issue.projectId !== defectHandoff.projectId ||
            issue.status !== "in_progress" ||
            issue.statusVersion !== defectHandoff.preparedStatusVersion ||
            issue.assigneeAgentId !== input.agentId ||
            issue.executionRunId !== input.runId ||
            !comment || oldReview) {
            throw conflict("Defect repair or QA assignment changed before process stop");
          }
          const [oldCard] = await tx.select({ id: issueThreadInteractions.id })
            .from(issueThreadInteractions).where(and(
              eq(issueThreadInteractions.companyId, input.companyId),
              eq(issueThreadInteractions.issueId, issue.id),
              eq(issueThreadInteractions.status, "pending"),
              sql`${issueThreadInteractions.payload}->'target'->>'key' = ${ISSUE_COMPLETION_REVIEW_TARGET_KEY}`,
            )).limit(1);
          if (oldCard) throw conflict("Old completion review card blocks defect QA handoff");
          const transition = applyIssueExecutionPolicyTransition({
            issue, policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
            requestedStatus: "done", requestedAssigneePatch: {},
            actor: { agentId: input.agentId, userId: null },
            allowBoardOverride: false, commentBody: comment.body,
          });
          const pending = transition.patch.executionState as Record<string, unknown> | null | undefined;
          const participant = pending?.currentParticipant as Record<string, unknown> | undefined;
          if (transition.patch.status !== "in_review" ||
            transition.patch.assigneeAgentId !== defectHandoff.qaAgentId ||
            pending?.status !== "pending" || participant?.agentId !== defectHandoff.qaAgentId) {
            throw conflict("Native execution policy did not assign the QA stage");
          }
          const postCommitActions: IssuePostCommitAction[] = [];
          const submitted = await issueService(db).update(issue.id, {
            companyGuard: input.companyId, status: "done", ...transition.patch,
            actorAgentId: input.agentId,
          }, tx, publications, postCommitActions);
          const submittedParticipant = submitted?.executionState?.currentParticipant as
            Record<string, unknown> | null | undefined;
          if (!submitted || submitted.status !== "in_review" ||
            submitted.statusVersion !== issue.statusVersion + 1 ||
            submitted.assigneeAgentId !== defectHandoff.qaAgentId ||
            submitted.executionState?.status !== "pending" ||
            submittedParticipant?.agentId !== defectHandoff.qaAgentId ||
            postCommitActions.length > 0) {
            throw conflict("Native defect QA handoff did not commit after process stop");
          }
          const now = new Date();
          await tx.update(workRecordQualityItems).set({ state: "accepted",
            revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
            .where(eq(workRecordQualityItems.id, repair.id));
          await tx.update(workRecordQualityItems).set({ state: "active",
            revision: sql`${workRecordQualityItems.revision} + 1`, updatedAt: now })
            .where(eq(workRecordQualityItems.id, qa.id));
          await tx.update(workRecordQualityCycles).set({ qualityPhase: "qa_retest",
            revision: cycle.revision + 1, updatedAt: now })
            .where(eq(workRecordQualityCycles.id, cycle.id));
          await tx.update(workRecords).set({ businessStatus: "in_review",
            statusVersion: sql`${workRecords.statusVersion} + 1`, updatedAt: now })
            .where(eq(workRecords.id, record.id));
          await tx.update(localDefectRepairHandoffs).set({ state: "submitted",
            submittedStatusVersion: submitted.statusVersion })
            .where(eq(localDefectRepairHandoffs.id, defectHandoff.id));
          defectReceipt = { defectHandoffId: defectHandoff.id,
            defectHandoffDisposition: "submitted",
            defectSubmittedStatusVersion: submitted.statusVersion };
        } else {
          await tx.update(localDefectRepairHandoffs).set({ state: "aborted" })
            .where(eq(localDefectRepairHandoffs.id, defectHandoff.id));
          defectReceipt = { defectHandoffId: defectHandoff.id,
            defectHandoffDisposition: "aborted" };
        }
      }
      if (qaCommand) {
        if (qaCommand.state !== "prepared" || !qaRun ||
          qaCommand.companyId !== input.companyId ||
          qaCommand.issueId !== lease.issueId ||
          qaCommand.qaAgentId !== input.agentId ||
          qaCommand.payload.clientRequestId !== qaCommand.clientRequestId ||
          qaCommand.payload.requestPayloadDigest !== qaCommand.requestDigest ||
          qaCommand.payload.cycleId !== qaCommand.cycleId ||
          qaCommand.payload.itemId !== qaCommand.itemId ||
          qaCommand.payload.expectedCycleRevision !== qaCommand.preparedCycleRevision ||
          qaCommand.payload.defectRecordId !== qaCommand.recordId ||
          qaCommand.payload.repairRecordId !==
            (qaCommand.payload.outcome === "return" ? qaCommand.recordId : null)) {
          throw conflict("Independent defect QA decision receipt changed");
        }
        if (status === "succeeded") {
          const ready = await readClaimedDefectQaContext(tx as unknown as Db, run, lease);
          if (!ready || ready.issue.id !== qaCommand.issueId ||
            ready.handoff.id !== qaCommand.handoffId ||
            ready.handoff.projectId !== qaCommand.projectId ||
            ready.handoff.recordId !== qaCommand.recordId ||
            ready.cycle.id !== qaCommand.cycleId ||
            ready.qa.id !== qaCommand.itemId ||
            ready.issue.statusVersion !== qaCommand.preparedStatusVersion ||
            ready.cycle.revision !== qaCommand.preparedCycleRevision ||
            ready.qa.revision !== qaCommand.preparedItemRevision) {
            throw conflict("Independent defect QA changed before its process stopped");
          }
          const decided = await workRecordQualityService(db, {
            writesEnabled: deps.workRecordWorkflowV2WritesEnabled,
          }).commitQaVerdictInTransaction(tx, input.companyId,
            qaCommand.projectId, qaCommand.recordId, qaCommand.payload,
            { actorType: "agent", actorId: input.agentId,
              agentId: input.agentId, runId: input.runId });
          if (decided.replayed ||
            (decided.escalated && qaCommand.payload.outcome !== "return")) {
            throw conflict("Independent defect QA could not complete its native decision");
          }
          const [afterIssue] = await tx.select().from(issues).where(and(
            eq(issues.id, qaCommand.issueId), eq(issues.companyId, input.companyId),
          ));
          const expectedStatus = decided.escalated ? "in_review" :
            qaCommand.payload.outcome === "pass" ? "done" : "in_progress";
          const expectedVersion = ready.issue.statusVersion + (decided.escalated ? 0 : 1);
          if (!afterIssue || afterIssue.statusVersion !== expectedVersion ||
            afterIssue.status !== expectedStatus) {
            throw conflict("Independent defect QA native issue did not commit");
          }
          let nextCycleId: string | null = null;
          if (decided.escalated) {
            const [attention] = await tx.select().from(workRecordQualityCycles)
              .where(eq(workRecordQualityCycles.id, qaCommand.cycleId));
            if (!attention || attention.qualityPhase !== "attention_required" ||
              attention.reason !== "review_round_limit_reached") {
              throw conflict("Independent defect QA review limit did not become visible");
            }
          } else if (qaCommand.payload.outcome === "return") {
            const [record] = await tx.select({ repairAgentId: workRecords.assigneeAgentId })
              .from(workRecords).where(eq(workRecords.id, qaCommand.recordId));
            const [next] = await tx.select().from(workRecordQualityCycles).where(and(
              eq(workRecordQualityCycles.companyId, input.companyId),
              eq(workRecordQualityCycles.aggregateRecordId, qaCommand.recordId),
              eq(workRecordQualityCycles.kind, "independent_defect"),
              eq(workRecordQualityCycles.state, "open"),
              eq(workRecordQualityCycles.cycleNumber, ready.cycle.cycleNumber + 1),
            )).limit(1);
            const [repairItem] = next ? await tx.select().from(workRecordQualityItems)
              .where(and(eq(workRecordQualityItems.cycleId, next.id),
                eq(workRecordQualityItems.role, "repair"))).limit(1) : [];
            const [intent] = repairItem ? await tx.select().from(workRecordExecutionIntents)
              .where(and(eq(workRecordExecutionIntents.companyId, input.companyId),
                eq(workRecordExecutionIntents.issueId, qaCommand.issueId),
                eq(workRecordExecutionIntents.qualityItemId, repairItem.id),
                eq(workRecordExecutionIntents.kind, "rework_release"))).limit(1) : [];
            if (!record?.repairAgentId || afterIssue.assigneeAgentId !== record.repairAgentId ||
              !next || next.qualityPhase !== "waiting_fix" || !repairItem ||
              repairItem.state !== "ready" || !intent ||
              intent.state !== "waiting_dependencies" ||
              intent.expectedIssueStatusVersion !== afterIssue.statusVersion) {
              throw conflict("Independent defect QA return did not prepare original repairer wake");
            }
            nextCycleId = next.id;
          }
          const [committed] = await tx.update(localDefectQaVerdictCommands).set({
            state: "committed", verdictId: decided.verdict.id,
            escalated: decided.escalated, committedAt: sql`now()`,
          }).where(and(eq(localDefectQaVerdictCommands.id, qaCommand.id),
            eq(localDefectQaVerdictCommands.state, "prepared"))).returning();
          if (!committed) throw conflict("Independent defect QA receipt changed before commit");
          qaReceipt = { qaCommandId: qaCommand.id, qaDisposition: "committed",
            qaVerdictId: decided.verdict.id, qaNextCycleId: nextCycleId,
            qaEscalated: decided.escalated };
        } else {
          const [aborted] = await tx.update(localDefectQaVerdictCommands)
            .set({ state: "aborted" }).where(and(
              eq(localDefectQaVerdictCommands.id, qaCommand.id),
              eq(localDefectQaVerdictCommands.state, "prepared"),
            )).returning();
          if (!aborted) throw conflict("Independent defect QA receipt changed before abort");
          qaReceipt = { qaCommandId: qaCommand.id, qaDisposition: "aborted" };
        }
      }
      if (qaRun && status !== "succeeded") {
        qaDeliveryDisposition = (await settleFailedDefectQaRun(
          tx as unknown as Db, run, lease)).disposition;
      }
      // A local process result is not a business completion. Without an atomic
      // handoff, releasing any source run would strand an in_progress task.
      // Preserve a human's newer state if they changed it.
      if (!reviewHint && !reviewerRun) {
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
        )).for("update");
        if (issue?.status === "in_progress" && issue.assigneeAgentId === input.agentId &&
          issue.executionRunId === input.runId) {
          const blocked = await issueService(db).update(issue.id, {
            status: "blocked", actorAgentId: input.agentId, companyGuard: input.companyId,
          }, tx, publications);
          if (!blocked || blocked.status !== "blocked") {
            throw conflict("Could not recover a local run without a review handoff");
          }
          await logActivity(tx as unknown as Db, {
            companyId: input.companyId, actorType: "agent", actorId: input.agentId,
            agentId: input.agentId, runId: input.runId,
            action: "issue.local_run_missing_review_handoff", entityType: "issue",
            entityId: issue.id, issueId: issue.id,
            details: { reason: status === "succeeded"
              ? "successful_process_without_business_handoff"
              : "unsuccessful_process_without_business_handoff" },
          }, publications);
        }
      }
      await tx.insert(localRunFinishReceipts).values({
        companyId: input.companyId, runId: input.runId, issueId: lease.issueId,
        agentId: input.agentId, deviceId: input.deviceId,
        leaseId: input.leaseId, generation: input.generation,
        clientRequestId: input.clientRequestId ?? null,
        requestDigest: input.clientRequestId
          ? localFinishRequestDigest({ ...input, issueId: lease.issueId }) : null,
        outcome: input.outcome, exitCode: input.exitCode,
      });
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
              requestDigest: localFinishRequestDigest({ ...input, issueId: lease.issueId }),
              ...(reviewReceipt ?? {}),
              ...(reviewerReceipt ?? {}),
              ...(childReceipt ?? {}),
              ...(poReceipt ?? {}),
              ...(defectReceipt ?? {}),
               ...(qaReceipt ?? {}),
               ...(qaDeliveryDisposition ? { qaDeliveryDisposition } : {}),
            },
          } } : {}),
        }).where(eq(heartbeatRuns.id, input.runId));
      }
      await tx.update(issues).set({
        executionRunId: null, executionLockedAt: null, updatedAt: sql`now()`,
      }).where(and(eq(issues.id, lease.issueId), eq(issues.companyId, input.companyId),
        eq(issues.executionRunId, input.runId)));
      if (reviewReceipt?.disposition === "ready") {
        const [ready] = await tx.update(issueCommandDeliveries).set({
          status: "ready", updatedAt: sql`now()`,
        }).where(and(
          eq(issueCommandDeliveries.id, reviewReceipt.deliveryId),
          eq(issueCommandDeliveries.status, "awaiting_handoff"),
        )).returning({ id: issueCommandDeliveries.id });
        if (!ready) throw conflict("Dedicated review notification changed before finish");
      }
      if (run.wakeupRequestId) {
        await tx.update(agentWakeupRequests).set({
          status: status === "succeeded" ? "completed" : status,
          finishedAt: sql`now()`, updatedAt: sql`now()`,
        }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
      }
      return { runId: run.id, status };
    });
    for (const publication of publications) publishActivity(publication);
    return finished;
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
      if (await defectQaRunChanged(tx as unknown as Db, run, lease)) {
        throw conflict("Independent defect QA event context changed");
      }
      const [issue] = await tx.select().from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .for("update");
      if (!issue) throw forbidden("Local run no longer owns this task");
      if (wakeReasonFromRun(run) === CLIENT_PULL_COMPLETION_REVIEW_WAKE_REASON) {
        await assertClientPullReviewEventContext(tx as unknown as Db, { run, issue });
      } else if (issue.assigneeAgentId !== input.agentId ||
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
    options: { allowReviewReplay?: boolean; allowPoPreparedReplay?: boolean;
      allowDefectPreparedReplay?: boolean } = {},
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
      const [preparedPo] = await tx.select({ id: localPoVerdictCommands.id })
        .from(localPoVerdictCommands).where(and(
          eq(localPoVerdictCommands.companyId, input.companyId),
          eq(localPoVerdictCommands.runId, input.runId),
          eq(localPoVerdictCommands.state, "prepared"),
        )).limit(1);
      if (preparedPo && !options.allowPoPreparedReplay) {
        throw conflict("This local PO run already prepared its final decision");
      }
      const [preparedDefect] = await tx.select({ id: localDefectRepairHandoffs.id })
        .from(localDefectRepairHandoffs).where(and(
          eq(localDefectRepairHandoffs.companyId, input.companyId),
          eq(localDefectRepairHandoffs.runId, input.runId),
          eq(localDefectRepairHandoffs.state, "prepared"),
        )).limit(1);
      if (preparedDefect && !options.allowDefectPreparedReplay) {
        throw conflict("This local defect run already prepared its final handoff");
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

  async function withFencedDefectQaRun<T>(input: LocalRunOwner,
    actor: Express.Request["actor"], write: (tx: Db,
      context: NonNullable<Awaited<ReturnType<typeof readClaimedDefectQaContext>>>) => Promise<T>) {
    requireOwner(input);
    if (actor.type !== "agent" || actor.source !== "agent_key" ||
      actor.agentId !== input.agentId || actor.companyId !== input.companyId ||
      actor.keyId !== input.keyId ||
      (actor.runId && actor.runId !== input.runId)) {
      throw forbidden("Independent defect QA requires its own run and API key");
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases)
        .where(eq(localAgentRunLeases.runId, input.runId)).for("update");
      if (!run || !lease || lease.companyId !== input.companyId ||
        lease.agentId !== input.agentId || lease.deviceId !== input.deviceId ||
        lease.deviceKeyId !== input.keyId || lease.leaseId !== input.leaseId ||
        lease.generation !== input.generation || lease.releasedAt ||
        lease.cancelRequestedAt || run.status !== "running" ||
        wakeReasonFromRun(run) !== CLIENT_PULL_DEFECT_QA_WAKE_REASON) {
        throw forbidden("Independent defect QA lease is no longer owned by this device");
      }
      await assertLeaseDevice(tx as unknown as Db, lease, input);
      const [live] = await tx.select({ live: sql<boolean>`${localAgentRunLeases.expiresAt} > now()` })
        .from(localAgentRunLeases).where(eq(localAgentRunLeases.runId, input.runId));
      if (!live?.live) throw conflict("Independent defect QA lease expired; stop the process");
      const context = await readClaimedDefectQaContext(tx as unknown as Db, run, lease);
      if (!context) throw conflict("Independent defect QA context changed");
      return write(tx as unknown as Db, context);
    });
  }

  async function readFencedDefectQaContext(input: LocalRunOwner,
    actor: Express.Request["actor"]) {
    return withFencedDefectQaRun(input, actor, async (_tx, context) => ({
      issueId: context.issue.id, cycleId: context.cycle.id,
      itemId: context.qa.id, defectRecordId: context.handoff.recordId,
      repairRecordId: context.handoff.recordId,
      handoffId: context.handoff.id,
      expectedStatusVersion: context.issue.statusVersion,
      expectedCycleRevision: context.cycle.revision,
      expectedItemRevision: context.qa.revision,
    }));
  }

  async function prepareFencedDefectQaVerdict(input: LocalRunOwner & {
    issueId: string; expectedStatusVersion: number;
    cycleId: string; itemId: string; expectedCycleRevision: number;
    expectedItemRevision: number; outcome: "pass" | "return";
    summary: string; evidenceRefs: string[]; clientRequestId: string;
  }, actor: Express.Request["actor"]) {
    if (!UUID.test(input.issueId) || !UUID.test(input.cycleId) ||
      !UUID.test(input.itemId) || !UUID.test(input.clientRequestId) ||
      !Number.isSafeInteger(input.expectedStatusVersion) ||
      input.expectedStatusVersion < 0 ||
      !Number.isSafeInteger(input.expectedCycleRevision) ||
      input.expectedCycleRevision < 1 ||
      !Number.isSafeInteger(input.expectedItemRevision) ||
      input.expectedItemRevision < 1 ||
      typeof input.summary !== "string" || !input.summary.trim() ||
      Buffer.byteLength(input.summary, "utf8") > 4096 ||
      /@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\./i.test(input.summary) ||
      !Array.isArray(input.evidenceRefs) ||
      !["pass", "return"].includes(input.outcome)) {
      throw badRequest("Independent defect QA requires a valid decision, summary, evidence and revisions");
    }
    const digest = createHash("sha256").update(JSON.stringify({
      companyId: input.companyId, agentId: input.agentId, runId: input.runId,
      issueId: input.issueId, expectedStatusVersion: input.expectedStatusVersion,
      cycleId: input.cycleId, itemId: input.itemId,
      expectedCycleRevision: input.expectedCycleRevision,
      expectedItemRevision: input.expectedItemRevision,
      outcome: input.outcome, summary: input.summary,
      evidenceRefs: input.evidenceRefs,
    })).digest("hex");
    return withFencedDefectQaRun(input, actor, async (tx, context) => {
      if (input.issueId !== context.issue.id ||
        input.expectedStatusVersion !== context.issue.statusVersion ||
        input.cycleId !== context.cycle.id ||
        input.itemId !== context.qa.id ||
        input.expectedCycleRevision !== context.cycle.revision ||
        input.expectedItemRevision !== context.qa.revision) {
        throw conflict("Independent defect QA revision changed before preparation");
      }
      const [existing] = await tx.select().from(localDefectQaVerdictCommands).where(and(
        eq(localDefectQaVerdictCommands.companyId, input.companyId),
        eq(localDefectQaVerdictCommands.runId, input.runId),
      )).limit(1);
      if (existing) {
        if (existing.clientRequestId !== input.clientRequestId ||
          existing.requestDigest !== digest || existing.state !== "prepared" ||
          existing.handoffId !== context.handoff.id) {
          throw conflict("Independent defect QA decision differs from its preparation");
        }
        return { issueId: context.issue.id, status: "in_review" as const,
          statusVersion: context.issue.statusVersion,
          receiptId: existing.id, disposition: "prepared" as const,
          replayed: true };
      }
      const payload = recordQaQualityVerdictSchema.safeParse({
        workflowVersion: 2, clientRequestId: input.clientRequestId,
        requestPayloadDigest: digest, cycleId: context.cycle.id,
        itemId: context.qa.id,
        expectedCycleRevision: context.cycle.revision,
        outcome: input.outcome, reason: input.summary,
        evidenceRefs: input.evidenceRefs,
        defectRecordId: context.handoff.recordId,
        repairRecordId: input.outcome === "return" ? context.handoff.recordId : null,
      });
      if (!payload.success) throw badRequest("Invalid independent defect QA verdict", payload.error.flatten());
      const rollout = resolveWorkRecordWorkflowV2Rollout({
        writesEnabled: deps.workRecordWorkflowV2WritesEnabled,
      }).decision(input.companyId, context.handoff.projectId);
      if (!rollout.scopeEnabled) throw forbidden("Work-record quality writes are not enabled for this project");
      const [receipt] = await tx.insert(localDefectQaVerdictCommands).values({
        companyId: input.companyId, projectId: context.handoff.projectId,
        issueId: context.issue.id, recordId: context.handoff.recordId,
        cycleId: context.cycle.id, itemId: context.qa.id,
        handoffId: context.handoff.id, qaAgentId: input.agentId,
        runId: input.runId, clientRequestId: input.clientRequestId,
        requestDigest: digest, payload: payload.data,
        preparedStatusVersion: context.issue.statusVersion,
        preparedCycleRevision: context.cycle.revision,
        preparedItemRevision: context.qa.revision,
      }).returning({ id: localDefectQaVerdictCommands.id });
      await recordPreparedWriteReceipt(tx, input, "defect_qa_verdict", JSON.stringify({
        expectedStatusVersion: input.expectedStatusVersion,
        cycleId: input.cycleId, itemId: input.itemId,
        expectedCycleRevision: input.expectedCycleRevision,
        expectedItemRevision: input.expectedItemRevision,
        outcome: input.outcome, summary: input.summary,
        evidenceRefs: input.evidenceRefs,
      }), receipt.id);
      return { issueId: context.issue.id, status: "in_review" as const,
        statusVersion: context.issue.statusVersion,
        receiptId: receipt.id, disposition: "prepared" as const,
        replayed: false };
    });
  }

  async function prepareFencedPoVerdict(input: LocalRunOwner & {
    issueId: string;
    expectedStatusVersion: number;
    clientRequestId: string;
    cycleId: string;
    itemId: string;
    expectedCycleRevision: number;
    outcome: "approve" | "return";
    reason: string;
    evidenceRefs: string[];
    targetRecordIds: string[];
  }, actor: Express.Request["actor"]) {
    if (!Number.isSafeInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 0) {
      throw badRequest("PO decision requires the current task status revision");
    }
    const canonical = {
      issueId: input.issueId, expectedStatusVersion: input.expectedStatusVersion,
      cycleId: input.cycleId, itemId: input.itemId,
      expectedCycleRevision: input.expectedCycleRevision, outcome: input.outcome,
      reason: input.reason, evidenceRefs: input.evidenceRefs,
      targetRecordIds: input.targetRecordIds,
    };
    const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const parsed = recordPoQualityVerdictSchema.safeParse({
      workflowVersion: 2, clientRequestId: input.clientRequestId,
      requestPayloadDigest: digest, cycleId: input.cycleId, itemId: input.itemId,
      expectedCycleRevision: input.expectedCycleRevision,
      outcome: input.outcome, reason: input.reason,
      evidenceRefs: input.evidenceRefs, targetRecordIds: input.targetRecordIds,
    });
    if (!parsed.success) throw badRequest("Invalid local PO verdict payload", parsed.error.flatten());
    const payload = parsed.data;
    return withFencedIssueWrite(input, actor, "issue:mutate", async (tx, issue) => {
      if (issue.status !== "in_progress" ||
        issue.statusVersion !== input.expectedStatusVersion) {
        throw conflict("PO package task changed before decision preparation");
      }
      const [existing] = await tx.select().from(localPoVerdictCommands).where(and(
        eq(localPoVerdictCommands.companyId, input.companyId),
        eq(localPoVerdictCommands.runId, input.runId),
      )).limit(1);
      if (existing) {
        if (existing.issueId !== issue.id || existing.clientRequestId !== input.clientRequestId ||
          existing.requestDigest !== digest || existing.state !== "prepared" ||
          existing.preparedStatusVersion !== issue.statusVersion) {
          throw conflict("PO decision request differs from its committed preparation");
        }
        return { receiptId: existing.id, disposition: "prepared" as const, replayed: true };
      }
      const [linked] = await tx.select({ link: workRecordIssueLinks, record: workRecords })
        .from(workRecordIssueLinks).innerJoin(workRecords, and(
          eq(workRecords.companyId, workRecordIssueLinks.companyId),
          eq(workRecords.id, workRecordIssueLinks.recordId),
        )).where(and(
          eq(workRecordIssueLinks.companyId, input.companyId),
          eq(workRecordIssueLinks.issueId, issue.id),
          eq(workRecordIssueLinks.purpose, "primary"),
        )).limit(1);
      if (!linked || linked.record.kind !== "plan" || linked.record.parentRecordId ||
        linked.record.assigneeAgentId !== input.agentId ||
        linked.record.projectId !== issue.projectId ||
        linked.record.dispatchState === "not_dispatched") {
        throw unprocessable("Only the assigned, dispatched parent PO can prepare a verdict",
          { code: "work_record_po_scope_invalid" });
      }
      const rollout = resolveWorkRecordWorkflowV2Rollout({
        writesEnabled: deps.workRecordWorkflowV2WritesEnabled,
      }).decision(input.companyId, linked.record.projectId);
      if (!rollout.scopeEnabled) throw forbidden("Work-record quality writes are not enabled for this project");
      // Plain reads avoid the cycle -> issue lock inversion against the board
      // command. finish rechecks the revision under the quality advisory lock.
      const [cycle] = await tx.select().from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, input.companyId),
        eq(workRecordQualityCycles.projectId, linked.record.projectId),
        eq(workRecordQualityCycles.id, payload.cycleId),
        eq(workRecordQualityCycles.aggregateRecordId, linked.record.id),
        inArray(workRecordQualityCycles.kind, ["package_acceptance", "package_rework"]),
      )).limit(1);
      const [item] = await tx.select().from(workRecordQualityItems).where(and(
        eq(workRecordQualityItems.companyId, input.companyId),
        eq(workRecordQualityItems.projectId, linked.record.projectId),
        eq(workRecordQualityItems.id, payload.itemId),
        eq(workRecordQualityItems.cycleId, payload.cycleId),
        eq(workRecordQualityItems.recordId, linked.record.id),
        eq(workRecordQualityItems.role, "po"),
      )).limit(1);
      if (!cycle || cycle.state !== "open" ||
        cycle.revision !== payload.expectedCycleRevision || !item ||
        !["ready", "active", "submitted"].includes(item.state)) {
        throw conflict("PO quality cycle is no longer ready for this decision");
      }
      if (payload.outcome === "approve") {
        const [unfinished] = await tx.select({ id: workRecordQualityItems.id })
          .from(workRecordQualityItems).where(and(
            eq(workRecordQualityItems.companyId, input.companyId),
            eq(workRecordQualityItems.cycleId, cycle.id),
            eq(workRecordQualityItems.required, true),
            ne(workRecordQualityItems.role, "po"),
            ne(workRecordQualityItems.state, "accepted"),
          )).limit(1);
        if (unfinished) throw conflict("Required child or QA acceptance is incomplete");
      } else {
        const targets = [...new Set(payload.targetRecordIds)];
        if (targets.includes(linked.record.id)) {
          throw unprocessable("PO return must select original child tasks");
        }
        const [batch] = await tx.select({ id: workRecordDispatchBatches.id })
          .from(workRecordDispatchBatches).where(and(
            eq(workRecordDispatchBatches.companyId, input.companyId),
            eq(workRecordDispatchBatches.projectId, linked.record.projectId),
            eq(workRecordDispatchBatches.rootRecordId, linked.record.id),
            eq(workRecordDispatchBatches.scopeKind, "whole_package"),
            eq(workRecordDispatchBatches.state, "prepared"),
          )).orderBy(desc(workRecordDispatchBatches.createdAt),
            desc(workRecordDispatchBatches.id)).limit(1);
        const members = batch ? await tx.select({ recordId: workRecordDispatchBatchItems.recordId })
          .from(workRecordDispatchBatchItems).where(and(
            eq(workRecordDispatchBatchItems.companyId, input.companyId),
            eq(workRecordDispatchBatchItems.projectId, linked.record.projectId),
            eq(workRecordDispatchBatchItems.batchId, batch.id),
            inArray(workRecordDispatchBatchItems.recordId, targets),
          )) : [];
        if (!batch || members.length !== targets.length) {
          throw unprocessable("PO return target is outside the original package");
        }
      }
      const [receipt] = await tx.insert(localPoVerdictCommands).values({
        companyId: input.companyId, projectId: linked.record.projectId,
        issueId: issue.id, recordId: linked.record.id, runId: input.runId,
        clientRequestId: input.clientRequestId, requestDigest: digest,
        payload, preparedStatusVersion: issue.statusVersion,
      }).returning({ id: localPoVerdictCommands.id });
      await recordPreparedWriteReceipt(tx, input, "po_verdict", JSON.stringify({
        expectedStatusVersion: input.expectedStatusVersion,
        cycleId: input.cycleId, itemId: input.itemId,
        expectedCycleRevision: input.expectedCycleRevision,
        outcome: input.outcome, reason: input.reason,
        evidenceRefs: input.evidenceRefs,
        targetRecordIds: input.targetRecordIds,
      }), receipt.id);
      return { receiptId: receipt.id, disposition: "prepared" as const, replayed: false };
    }, { allowPoPreparedReplay: true });
  }

  async function completeFencedChildWorkRecord(
    input: LocalRunOwner & { issueId: string; summary: string;
      expectedStatusVersion: number; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.clientRequestId) || !input.summary.trim() ||
      Buffer.byteLength(input.summary, "utf8") > 4096 ||
      /@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\./i.test(input.summary) ||
      !Number.isSafeInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 0) {
      throw badRequest("Child completion requires a request ID, plain summary and status revision");
    }
    const digest = createHash("sha256").update(JSON.stringify({
      companyId: input.companyId, issueId: input.issueId, runId: input.runId,
      agentId: input.agentId, summary: input.summary,
      expectedStatusVersion: input.expectedStatusVersion,
    })).digest("hex");
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue, authorizationReason) => {
        const [existing] = await tx.select().from(localIssueCompletionCommands).where(and(
          eq(localIssueCompletionCommands.companyId, input.companyId),
          eq(localIssueCompletionCommands.runId, input.runId),
          eq(localIssueCompletionCommands.clientRequestId, input.clientRequestId),
        )).limit(1);
        if (existing) {
          if (existing.issueId !== issue.id || existing.requestDigest !== digest ||
            existing.state !== "prepared" || issue.status !== "in_progress" ||
            issue.statusVersion !== existing.preparedStatusVersion) {
            throw conflict("Child completion request differs from its committed receipt");
          }
          return { issueId: issue.id, status: issue.status,
            statusVersion: issue.statusVersion, receiptId: existing.id,
            disposition: "prepared" as const, replayed: true };
        }
        if (issue.status !== "in_progress" || issue.statusVersion !== input.expectedStatusVersion) {
          throw conflict("Child completion task revision changed");
        }
        const [otherCompletion] = await tx.select({ id: localIssueCompletionCommands.id })
          .from(localIssueCompletionCommands).where(and(
            eq(localIssueCompletionCommands.companyId, input.companyId),
            eq(localIssueCompletionCommands.issueId, issue.id),
            eq(localIssueCompletionCommands.runId, input.runId),
          )).limit(1);
        if (otherCompletion) throw conflict("This run already prepared a child completion");
        const [linked] = await tx.select({ link: workRecordIssueLinks, record: workRecords })
          .from(workRecordIssueLinks)
          .innerJoin(workRecords, and(
            eq(workRecords.companyId, workRecordIssueLinks.companyId),
            eq(workRecords.id, workRecordIssueLinks.recordId),
          )).where(and(
            eq(workRecordIssueLinks.companyId, input.companyId),
            eq(workRecordIssueLinks.issueId, issue.id),
            eq(workRecordIssueLinks.purpose, "primary"),
          )).limit(1);
        if (!linked || linked.record.kind !== "plan" || !linked.record.parentRecordId ||
          linked.record.assigneeAgentId !== input.agentId ||
          linked.record.projectId !== issue.projectId ||
          linked.record.dispatchState === "not_dispatched") {
          throw unprocessable("Only a dispatched, assigned plan child can use this completion command",
            { code: "work_record_child_completion_scope_invalid" });
        }
        const [quality] = await tx.select({ id: workRecordQualityItems.id })
          .from(workRecordQualityItems)
          .innerJoin(workRecordQualityCycles, and(
            eq(workRecordQualityCycles.companyId, workRecordQualityItems.companyId),
            eq(workRecordQualityCycles.id, workRecordQualityItems.cycleId),
          )).where(and(
            eq(workRecordQualityItems.companyId, input.companyId),
            eq(workRecordQualityItems.projectId, linked.record.projectId),
            eq(workRecordQualityItems.recordId, linked.record.id),
            eq(workRecordQualityItems.role, "repair"),
            eq(workRecordQualityItems.required, true),
            eq(workRecordQualityCycles.kind, "package_acceptance"),
            eq(workRecordQualityCycles.state, "open"),
            ne(workRecordQualityItems.state, "accepted"),
            ne(workRecordQualityItems.state, "rejected"),
          )).limit(1);
        if (!quality) throw conflict("Child is not part of an open PO work package");
        const sourceTrust = await resolveActorSourceTrustForIssue({ db: tx, issue,
          actor: { actorType: "agent", actorId: input.agentId,
            agentId: input.agentId, runId: input.runId } });
        const comment = await issueService(db).addComment(issue.id, input.summary,
          { agentId: input.agentId, runId: input.runId,
            onBehalfOfUserId: actor.onBehalfOfUserId },
          { authorType: "agent", authorizationReason, sourceTrust,
            clientRequestId: input.clientRequestId }, tx);
        const [receipt] = await tx.insert(localIssueCompletionCommands).values({
          companyId: input.companyId, issueId: issue.id,
          recordId: linked.record.id, runId: input.runId,
          clientRequestId: input.clientRequestId, requestDigest: digest,
          preparedStatusVersion: issue.statusVersion, commentId: comment.id,
        }).returning({ id: localIssueCompletionCommands.id });
        await recordPreparedWriteReceipt(tx, input, "child_complete", JSON.stringify({
          expectedStatusVersion: input.expectedStatusVersion, summary: input.summary,
        }), receipt.id);
        await logActivity(tx, {
          companyId: input.companyId, actorType: "agent", actorId: input.agentId,
          agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
          action: "work_record.child_execution_prepared", entityType: "issue",
          entityId: issue.id, issueId: issue.id,
          details: { recordId: linked.record.id, receiptId: receipt.id,
            commentId: comment.id, clientRequestId: input.clientRequestId,
            statusVersion: issue.statusVersion },
        }, publications);
        return { issueId: issue.id, status: issue.status,
          statusVersion: issue.statusVersion, receiptId: receipt.id,
          disposition: "prepared" as const, replayed: false };
      });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function prepareFencedDefectRepairHandoff(
    input: LocalRunOwner & { issueId: string; summary: string;
      expectedStatusVersion: number; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.clientRequestId) || typeof input.summary !== "string" ||
      !input.summary.trim() || Buffer.byteLength(input.summary, "utf8") > 4096 ||
      /@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\./i.test(input.summary) ||
      !Number.isSafeInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 0) {
      throw badRequest("Defect repair handoff requires a request ID, plain summary and status revision");
    }
    const digest = createHash("sha256").update(JSON.stringify({
      companyId: input.companyId, issueId: input.issueId, runId: input.runId,
      agentId: input.agentId, summary: input.summary,
      expectedStatusVersion: input.expectedStatusVersion,
    })).digest("hex");
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue, authorizationReason) => {
        const [existing] = await tx.select().from(localDefectRepairHandoffs).where(and(
          eq(localDefectRepairHandoffs.companyId, input.companyId),
          eq(localDefectRepairHandoffs.runId, input.runId),
        )).limit(1);
        if (existing) {
          if (existing.issueId !== issue.id || existing.clientRequestId !== input.clientRequestId ||
            existing.requestDigest !== digest || existing.state !== "prepared" ||
            issue.status !== "in_progress" || issue.statusVersion !== existing.preparedStatusVersion) {
            throw conflict("Defect repair handoff differs from its preparation");
          }
          return { issueId: issue.id, status: issue.status,
            statusVersion: issue.statusVersion, receiptId: existing.id,
            disposition: "prepared" as const, replayed: true };
        }
        if (issue.status !== "in_progress" || issue.statusVersion !== input.expectedStatusVersion) {
          throw conflict("Defect repair task revision changed");
        }
        const [linked] = await tx.select({ link: workRecordIssueLinks, record: workRecords })
          .from(workRecordIssueLinks).innerJoin(workRecords, and(
            eq(workRecords.companyId, workRecordIssueLinks.companyId),
            eq(workRecords.id, workRecordIssueLinks.recordId),
          )).where(and(
            eq(workRecordIssueLinks.companyId, input.companyId),
            eq(workRecordIssueLinks.issueId, issue.id),
            eq(workRecordIssueLinks.purpose, "primary"),
          )).limit(1);
        const record = linked?.record;
        if (!record || record.kind !== "defect" || record.parentRecordId ||
          record.assigneeAgentId !== input.agentId ||
          record.projectId !== issue.projectId ||
          record.dispatchState === "not_dispatched" ||
          !record.qaAssigneeAgentId || record.qaAssigneeAgentId === input.agentId) {
          throw unprocessable("Only a dispatched independent defect repairer can prepare QA handoff",
            { code: "work_record_defect_repair_scope_invalid" });
        }
        const [qaAgent] = await tx.select({ id: agents.id,
          runtimeConfig: agents.runtimeConfig }).from(agents).where(and(
            eq(agents.id, record.qaAssigneeAgentId),
            eq(agents.companyId, input.companyId),
          ));
        if (!qaAgent || !isClientPullRuntimeConfig(qaAgent.runtimeConfig)) {
          throw conflict("Defect QA must be a local client-pull agent");
        }
        const [oldReview] = await tx.select({ id: issueCompletionReviews.id })
          .from(issueCompletionReviews).where(and(
            eq(issueCompletionReviews.companyId, input.companyId),
            eq(issueCompletionReviews.issueId, issue.id),
            eq(issueCompletionReviews.state, "pending"),
          )).limit(1);
        const [oldCard] = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.status, "pending"),
            sql`${issueThreadInteractions.payload}->'target'->>'key' = ${ISSUE_COMPLETION_REVIEW_TARGET_KEY}`,
          )).limit(1);
        if (oldReview || oldCard) throw conflict("Resolve the old completion review before defect QA handoff");
        const [cycle] = await tx.select().from(workRecordQualityCycles).where(and(
          eq(workRecordQualityCycles.companyId, input.companyId),
          eq(workRecordQualityCycles.projectId, record.projectId),
          eq(workRecordQualityCycles.aggregateRecordId, record.id),
          eq(workRecordQualityCycles.kind, "independent_defect"),
          eq(workRecordQualityCycles.state, "open"),
          eq(workRecordQualityCycles.qualityPhase, "waiting_fix"),
        )).limit(1);
        const items = cycle ? await tx.select().from(workRecordQualityItems).where(and(
          eq(workRecordQualityItems.companyId, input.companyId),
          eq(workRecordQualityItems.cycleId, cycle.id),
          eq(workRecordQualityItems.recordId, record.id),
          eq(workRecordQualityItems.issueLinkId, linked.link.id),
          eq(workRecordQualityItems.required, true),
        )) : [];
        const repair = items.find((item) => item.role === "repair");
        const qa = items.find((item) => item.role === "qa");
        if (!cycle || !repair || !qa || !["ready", "active"].includes(repair.state) ||
          !["blocked", "waiting"].includes(qa.state)) {
          throw conflict("Independent defect quality cycle is not ready for repair handoff");
        }
        const sourceTrust = await resolveActorSourceTrustForIssue({ db: tx, issue,
          actor: { actorType: "agent", actorId: input.agentId,
            agentId: input.agentId, runId: input.runId } });
        const comment = await issueService(db).addComment(issue.id, input.summary,
          { agentId: input.agentId, runId: input.runId,
            onBehalfOfUserId: actor.onBehalfOfUserId },
          { authorType: "agent", authorizationReason, sourceTrust,
            clientRequestId: input.clientRequestId }, tx);
        const [receipt] = await tx.insert(localDefectRepairHandoffs).values({
          companyId: input.companyId, projectId: record.projectId,
          issueId: issue.id, recordId: record.id, cycleId: cycle.id,
          repairItemId: repair.id, qaItemId: qa.id,
          qaAgentId: qaAgent.id, runId: input.runId,
          clientRequestId: input.clientRequestId, requestDigest: digest,
          preparedStatusVersion: issue.statusVersion,
          preparedCycleRevision: cycle.revision, commentId: comment.id,
        }).returning({ id: localDefectRepairHandoffs.id });
        await recordPreparedWriteReceipt(tx, input, "defect_repair_handoff", JSON.stringify({
          expectedStatusVersion: input.expectedStatusVersion, summary: input.summary,
        }), receipt.id);
        await logActivity(tx, {
          companyId: input.companyId, actorType: "agent", actorId: input.agentId,
          agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
          action: "work_record.defect_repair_handoff_prepared", entityType: "issue",
          entityId: issue.id, issueId: issue.id,
          details: { recordId: record.id, cycleId: cycle.id, receiptId: receipt.id,
            commentId: comment.id, clientRequestId: input.clientRequestId,
            statusVersion: issue.statusVersion },
        }, publications);
        return { issueId: issue.id, status: issue.status,
          statusVersion: issue.statusVersion, receiptId: receipt.id,
          disposition: "prepared" as const, replayed: false };
      }, { allowDefectPreparedReplay: true });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function addFencedComment(
    input: LocalRunOwner & { issueId: string; body: string; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (typeof input.body !== "string" || !input.body.trim()) throw badRequest("Comment body is required");
    if (/@|(?:[a-z][a-z0-9+.-]*:\/\/)|\bwww\.|\bmailto:|\b\S+\.(?:com|net|org|cn|io|dev|ai|co|xyz)(?:\b|\/)/i.test(input.body)) {
      throw badRequest("Local progress comments cannot contain mentions or external links");
    }
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
      // A committed comment may be read back after the task entered review.
      // This branch must never create new content once execution ownership ends.
      if (issue.status !== "in_progress") throw conflict("Progress comments require an in-progress task");
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
          clientRequestId: input.clientRequestId,
          requestDigest: localCommentIntentDigest(input),
          deviceId: input.deviceId,
          identifier: issue.identifier, issueTitle: issue.title, authorizationReason },
      }, publications);
      await (deps.syncCommentReferences ?? ((id, currentTx) => issueReferenceService(db).syncComment(id, currentTx)))(saved.id, tx);
      const externalEnabled = (await instanceSettingsService(tx).getExperimental()).enableExternalObjects === true;
      await (deps.syncCommentExternalObjects ?? ((id, currentTx) =>
        externalObjectService(db, { enabled: externalEnabled }).syncComment(id, currentTx)))(saved.id, tx);
      return { comment: saved, inserted: true };
    }, { allowReviewReplay: true });
    for (const publication of publications) publishActivity(publication);
    return result.comment;
  }

  async function createFencedSubtask(input: LocalRunOwner & {
    issueId: string; title: string; description: string;
    assigneeAgentId: string; clientRequestId: string;
  }, actor: Express.Request["actor"]) {
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title || title.length > 500 || !description || description.length > 20_000 ||
      !UUID.test(input.assigneeAgentId) || !UUID.test(input.clientRequestId)) {
      throw badRequest("A title, description, assignee and request ID are required");
    }
    if (input.assigneeAgentId === input.agentId) {
      throw forbidden("Local subtask cannot be assigned back to its parent owner");
    }
    const canonical = JSON.stringify({ title, description, assigneeAgentId: input.assigneeAgentId });
    const digest = createHash("sha256").update(JSON.stringify({
      kind: "subtask_create", runId: input.runId, issueId: input.issueId,
      agentId: input.agentId, deviceId: input.deviceId, canonicalContent: canonical,
    })).digest("hex");
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate", async (tx, parent) => {
      if (parent.status !== "in_progress" || !parent.projectId) {
        throw conflict("Only an active project task may delegate a subtask");
      }
      const assignment = await accessService(tx).decide({
        actor: { ...actor, runId: input.runId }, action: "tasks:assign",
        resource: { type: "issue", companyId: input.companyId,
          projectId: parent.projectId, parentIssueId: parent.id,
          assigneeAgentId: input.assigneeAgentId, assigneeUserId: null },
        scope: { projectId: parent.projectId, parentIssueId: parent.id,
          assigneeAgentId: input.assigneeAgentId, assigneeUserId: null },
      });
      if (!assignment.allowed) throw forbidden("Subtask assignment permission denied");
      const [assignee] = await tx.select({ id: agents.id, status: agents.status })
        .from(agents).where(and(eq(agents.id, input.assigneeAgentId),
          eq(agents.companyId, input.companyId))).limit(1);
      if (!assignee || ["terminated", "archived"].includes(assignee.status)) {
        throw forbidden("Subtask assignee is not available in this company");
      }
      const [existing] = await tx.select().from(localRunWriteReceipts).where(and(
        eq(localRunWriteReceipts.companyId, input.companyId),
        eq(localRunWriteReceipts.runId, input.runId),
        eq(localRunWriteReceipts.clientRequestId, input.clientRequestId),
      )).limit(1);
      if (existing) {
        if (existing.kind !== "subtask_create" || existing.issueId !== parent.id ||
          existing.requestDigest !== digest || existing.agentId !== input.agentId ||
          existing.deviceId !== input.deviceId) {
          throw conflict("Subtask request ID belongs to different content");
        }
        const [child] = await tx.select().from(issues).where(and(
          eq(issues.id, existing.sourceReceiptId), eq(issues.parentId, parent.id),
          eq(issues.companyId, input.companyId))).limit(1);
        if (!child) throw conflict("Committed subtask receipt has no child issue");
        return { child, replayed: true as const };
      }
      const child = await issueService(db).create(input.companyId, {
        title, description, parentId: parent.id, projectId: parent.projectId,
        goalId: parent.goalId, status: "todo", priority: parent.priority,
        assigneeAgentId: input.assigneeAgentId, createdByAgentId: input.agentId,
        actorRunId: input.runId, originRunId: input.runId,
        idempotencyKey: `local-subtask:${input.runId}:${input.clientRequestId}`,
      }, tx);
      // The parent is the coordinator's work package. Keep it waiting on this
      // exact delivery after the source run ends, so child completion wakes the
      // same parent instead of leaving a prose-only blocked task.
      await tx.insert(issueRelations).values({
        companyId: input.companyId, issueId: child.id,
        relatedIssueId: parent.id, type: "blocks",
        createdByAgentId: input.agentId,
      });
      await recordPreparedWriteReceipt(tx, input, "subtask_create", canonical, child.id);
      await logActivity(tx, {
        companyId: input.companyId, actorType: "agent", actorId: input.agentId,
        agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
        action: "issue.child_created", entityType: "issue", entityId: child.id,
        details: { parentId: parent.id, identifier: child.identifier,
          title: child.title, clientRequestId: input.clientRequestId,
          authorizationReason: assignment.reason ?? "local_run_delegation" },
      }, publications);
      return { child, replayed: false as const };
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  /** A positive receipt is sourced only from the original committed audit row.
   * Absence is deliberately unknown, even when the old run has ended. */
  async function readFencedWriteReceipt(input: LocalRunOwner & {
    issueId: string; kind: string; clientRequestId: string; requestDigest: string;
  }) {
    requireOwner(input);
    if (!UUID.test(input.issueId) || !UUID.test(input.clientRequestId) ||
      !/^[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw badRequest("Invalid local write receipt identity");
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.runtimeMode, "client_pull"),
        ));
      const [lease] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.runId, input.runId),
        eq(localAgentRunLeases.companyId, input.companyId),
        eq(localAgentRunLeases.agentId, input.agentId),
        eq(localAgentRunLeases.issueId, input.issueId),
      ));
      if (!run || !lease || lease.deviceId !== input.deviceId ||
        lease.deviceKeyId !== input.keyId || lease.leaseId !== input.leaseId ||
        lease.generation !== input.generation) {
        throw forbidden("Local run receipt owner mismatch");
      }
      await assertLeaseDevice(tx as unknown as Db, lease, input);
      const [preparedReceipt] = await tx.select().from(localRunWriteReceipts).where(and(
        eq(localRunWriteReceipts.companyId, input.companyId),
        eq(localRunWriteReceipts.runId, input.runId),
        eq(localRunWriteReceipts.clientRequestId, input.clientRequestId),
      ));
      if (preparedReceipt) {
        if (preparedReceipt.issueId !== input.issueId ||
          preparedReceipt.agentId !== input.agentId ||
          preparedReceipt.deviceId !== input.deviceId ||
          preparedReceipt.kind !== input.kind ||
          preparedReceipt.requestDigest !== input.requestDigest) {
          throw conflict("Local write receipt identity or digest mismatch");
        }
        return { state: "committed" as const, kind: preparedReceipt.kind,
          runStatus: run.status, leaseReleased: lease.releasedAt !== null,
          receiptId: preparedReceipt.id,
          sourceReceiptId: preparedReceipt.sourceReceiptId };
      }
      if (["child_complete", "defect_repair_handoff", "po_verdict",
        "defect_qa_verdict", "completion_review_handoff", "review_decision",
        "subtask_create"].includes(input.kind)) {
        return { state: "unknown" as const, kind: input.kind,
          runStatus: run.status, leaseReleased: lease.releasedAt !== null };
      }
      if (input.kind !== "comment") return { state: "unsupported" as const };
      const matches = await tx.select({ id: activityLog.id, details: activityLog.details })
        .from(activityLog).where(and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.agentId, input.agentId),
          eq(activityLog.runId, input.runId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
          eq(activityLog.action, "issue.comment_added"),
          sql`${activityLog.details}->>'clientRequestId' = ${input.clientRequestId}`,
          sql`${activityLog.details}->>'deviceId' = ${input.deviceId}`,
        )).limit(2);
      if (matches.length > 1) throw conflict("Duplicate local write receipts require review");
      const savedDigest = matches[0]?.details?.requestDigest;
      if (matches.length && savedDigest !== input.requestDigest) {
        throw conflict("Local write receipt digest mismatch");
      }
      return { state: matches.length ? "committed" as const : "unknown" as const,
        kind: "comment" as const, runStatus: run.status,
        leaseReleased: lease.releasedAt !== null,
        ...(matches.length ? { receiptId: matches[0]!.id } : {}) };
    });
  }

  /** Lock in finish's run→lease order before declaring a request absent. */
  async function readFencedFinishReceipt(input: LocalRunOwner & {
    issueId: string; clientRequestId: string; requestDigest: string;
  }) {
    requireOwner(input);
    if (!UUID.test(input.issueId) || !UUID.test(input.clientRequestId) ||
      !/^[a-f0-9]{64}$/.test(input.requestDigest)) {
      throw badRequest("Invalid local finish receipt identity");
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.runtimeMode, "client_pull"),
      )).for("update");
      const [lease] = await tx.select().from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.runId, input.runId),
        eq(localAgentRunLeases.companyId, input.companyId),
        eq(localAgentRunLeases.agentId, input.agentId),
        eq(localAgentRunLeases.issueId, input.issueId),
      )).for("update");
      if (!run || !lease || lease.deviceId !== input.deviceId ||
        lease.deviceKeyId !== input.keyId || lease.leaseId !== input.leaseId ||
        lease.generation !== input.generation) {
        throw forbidden("Local finish receipt owner mismatch");
      }
      await assertLeaseDevice(tx as unknown as Db, lease, input);
      const [receipt] = await tx.select().from(localRunFinishReceipts).where(and(
        eq(localRunFinishReceipts.companyId, input.companyId),
        eq(localRunFinishReceipts.runId, input.runId),
      ));
      if (receipt) {
        if (receipt.issueId !== input.issueId || receipt.agentId !== input.agentId ||
          receipt.deviceId !== input.deviceId || receipt.leaseId !== input.leaseId ||
          receipt.generation !== input.generation) {
          throw conflict("Local finish receipt owner changed");
        }
        if (!lease.releasedAt || !lease.stopAcknowledgedAt ||
          !["succeeded", "failed", "cancelled"].includes(run.status)) {
          return { state: "unknown" as const, runStatus: run.status,
            leaseReleased: lease.releasedAt !== null };
        }
        if (receipt.clientRequestId !== input.clientRequestId) {
          return { state: "not_committed" as const, runStatus: run.status,
            leaseReleased: lease.releasedAt !== null };
        }
        if (receipt.requestDigest !== input.requestDigest) {
          throw conflict("Local finish receipt digest mismatch");
        }
        return { state: "committed" as const, runStatus: run.status,
          leaseReleased: true, outcome: receipt.outcome, receiptId: receipt.id };
      }
      return { state: "unknown" as const, runStatus: run.status,
        leaseReleased: lease.releasedAt !== null };
    });
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

  /** Internal-only candidate. The public reviewerAgentId route remains fail-closed. */
  async function createFencedAgentReviewHandoff(
    input: LocalRunOwner & { issueId: string; reviewerAgentId: string; prompt: string;
      body: string; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.reviewerAgentId) || !UUID.test(input.clientRequestId)) {
      throw badRequest("Reviewer and client request IDs must be UUIDs");
    }
    if (!input.prompt.trim() || input.prompt.length > 1000) {
      throw badRequest("A review prompt of at most 1000 characters is required");
    }
    if (!input.body.trim() || /@|https?:\/\//i.test(input.body)) {
      throw badRequest("Review handoff requires a plain comment without mentions or external links");
    }
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue, authorizationReason) => {
        const deliveryService = issueCommandDeliveryService(db);
        if (issue.status === "in_review") {
          // A response lost after commit may only read back the exact command.
          // Never recreate a card or transition the task on this branch.
          const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            eq(issueThreadInteractions.idempotencyKey, input.clientRequestId),
          )).limit(1);
          const [comment] = await tx.select().from(issueComments).where(and(
            eq(issueComments.issueId, input.issueId),
            eq(issueComments.authorAgentId, input.agentId),
            eq(issueComments.createdByRunId, input.runId),
            eq(issueComments.clientRequestId, input.clientRequestId),
          )).limit(1);
          const [delivery] = interaction ? await tx.select().from(issueCommandDeliveries).where(and(
            eq(issueCommandDeliveries.companyId, input.companyId),
            eq(issueCommandDeliveries.interactionId, interaction.id),
            eq(issueCommandDeliveries.kind, "interaction_pending"),
          )).limit(1) : [];
          const [interactionAudit] = interaction ? await tx.select({ id: activityLog.id })
            .from(activityLog).where(and(
              eq(activityLog.companyId, input.companyId),
              eq(activityLog.entityId, input.issueId),
              eq(activityLog.runId, input.runId),
              eq(activityLog.action, "issue.thread_interaction_created"),
              sql`${activityLog.details}->>'interactionId' = ${interaction.id}`,
            )).limit(1) : [];
          const [statusAudit] = interaction ? await tx.select({ id: activityLog.id })
            .from(activityLog).where(and(
              eq(activityLog.companyId, input.companyId),
              eq(activityLog.entityId, input.issueId),
              eq(activityLog.runId, input.runId),
              eq(activityLog.action, "issue.updated"),
              sql`${activityLog.details}->>'clientRequestId' = ${input.clientRequestId}`,
              sql`${activityLog.details}->>'reviewInteractionId' = ${interaction.id}`,
            )).limit(1) : [];
          const [commentAudit] = comment ? await tx.select({ id: activityLog.id })
            .from(activityLog).where(and(
              eq(activityLog.companyId, input.companyId),
              eq(activityLog.entityId, input.issueId),
              eq(activityLog.runId, input.runId),
              eq(activityLog.action, "issue.comment_added"),
              sql`${activityLog.details}->>'commentId' = ${comment.id}`,
            )).limit(1) : [];
          const enabled = (await instanceSettingsService(tx).getGeneral()).censorUsernameInLogs;
          if (!interaction || !comment || !delivery || !interactionAudit || !statusAudit || !commentAudit ||
            interaction.kind !== "request_confirmation" ||
            interaction.createdByAgentId !== input.agentId || interaction.sourceRunId !== input.runId ||
            interaction.addresseeAgentId !== input.reviewerAgentId ||
            interaction.continuationPolicy !== "wake_assignee" ||
            interaction.requestedResolverPolicy !== "not_creator" ||
            interaction.effectiveResolverPolicy === "human_only" ||
            !("prompt" in interaction.payload) || interaction.payload.prompt !== input.prompt ||
            comment.body !== redactCurrentUserText(input.body, { enabled }) ||
            delivery.issueId !== input.issueId || delivery.sourceRunId !== input.runId ||
            delivery.targetAgentId !== input.reviewerAgentId ||
            delivery.status === "awaiting_handoff") {
            throw conflict("Agent review handoff request differs from the committed command");
          }
          return { issue, comment, interaction, delivery, replayed: true };
        }
        if (issue.status !== "in_progress") throw conflict("Review handoff requires an in-progress task");
        if (input.reviewerAgentId === input.agentId) throw unprocessable("An agent cannot review its own work");
        const [reviewer] = await tx.select({ companyId: agents.companyId,
          runtimeConfig: agents.runtimeConfig }).from(agents)
          .where(eq(agents.id, input.reviewerAgentId));
        if (!reviewer || reviewer.companyId !== input.companyId ||
          !isClientPullRuntimeConfig(reviewer.runtimeConfig)) {
          throw unprocessable("Reviewer must be a local client-pull agent in the same company");
        }
        const [sibling] = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            eq(issueThreadInteractions.kind, "request_confirmation"),
            eq(issueThreadInteractions.status, "pending"),
            eq(issueThreadInteractions.createdByAgentId, input.agentId),
          )).limit(1);
        if (sibling) throw conflict("Resolve the existing review confirmation before creating another");
        const interaction = await issueThreadInteractionService(tx).create(issue, {
          kind: "request_confirmation", idempotencyKey: input.clientRequestId,
          sourceRunId: input.runId, addresseeAgentId: input.reviewerAgentId,
          continuationPolicy: "wake_assignee", resolverPolicy: "not_creator",
          payload: { version: 1, prompt: input.prompt, allowDeclineReason: true },
        }, { agentId: input.agentId, identityContextId: actor.identityContextId ?? null },
        { supersedePendingSiblingInteractions: false });
        if (interaction.effectiveResolverPolicy === "human_only") {
          throw unprocessable("Company governance requires a human reviewer");
        }
        await logActivity(tx, {
          companyId: issue.companyId, actorType: "agent", actorId: input.agentId,
          agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
          action: "issue.thread_interaction_created", entityType: "issue", entityId: issue.id,
          details: { interactionId: interaction.id, interactionKind: interaction.kind,
            interactionStatus: interaction.status, continuationPolicy: interaction.continuationPolicy,
            addresseeAgentId: input.reviewerAgentId,
            requestedResolverPolicy: interaction.requestedResolverPolicy,
            effectiveResolverPolicy: interaction.effectiveResolverPolicy },
        }, publications);
        const intentScope = { companyId: input.companyId, issueId: input.issueId,
          interactionId: interaction.id, sourceRunId: input.runId,
          targetAgentId: input.reviewerAgentId };
        await deliveryService.enqueue(tx, intentScope);
        const lockedIssue = await issueService(db).getByIdForUpdate(input.issueId, tx);
        if (!lockedIssue) throw notFound("Issue not found");
        const handoff = await executeReviewHandoff({
          db, tx, existing: lockedIssue,
          patch: { status: "in_review", actorAgentId: input.agentId,
            companyGuard: input.companyId },
          commentBody: input.body, clientRequestId: input.clientRequestId,
          reviewInteractionId: interaction.id,
          actor: { agentId: input.agentId, runId: input.runId,
            agentApiKeyId: actor.keyId, responsibleUserId: actor.onBehalfOfUserId },
          authorizationReason, publications,
        });
        const delivery = await deliveryService.ready(tx, intentScope);
        return { ...handoff, interaction, delivery, replayed: false };
      }, { allowReviewReplay: true });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  /** Internal-only dedicated review creation. No HTTP route or wakeup uses this yet. */
  async function createFencedCompletionReviewHandoff(
    input: LocalRunOwner & { issueId: string; reviewerAgentId: string; prompt: string;
      body: string; clientRequestId: string },
    actor: Express.Request["actor"],
  ) {
    if (!UUID.test(input.reviewerAgentId) || !UUID.test(input.clientRequestId)) {
      throw badRequest("Reviewer and client request IDs must be UUIDs");
    }
    if (!input.prompt.trim() || input.prompt.length > 1000 || !input.body.trim() ||
      /@|https?:\/\/|www\./i.test(input.body)) {
      throw badRequest("Dedicated review requires a prompt and plain handoff comment");
    }
    const digest = createHash("sha256").update(JSON.stringify({
      companyId: input.companyId, issueId: input.issueId, sourceRunId: input.runId,
      sourceAgentId: input.agentId, reviewerAgentId: input.reviewerAgentId,
      prompt: input.prompt, body: input.body,
    })).digest("hex");
    const publications: ActivityPublication[] = [];
    const result = await withFencedIssueWrite(input, actor, "issue:mutate",
      async (tx, issue, authorizationReason) => {
        const [existing] = await tx.select().from(issueCompletionReviews).where(and(
          eq(issueCompletionReviews.companyId, input.companyId),
          eq(issueCompletionReviews.sourceRunId, input.runId),
          eq(issueCompletionReviews.requestId, input.clientRequestId),
        )).limit(1);
        if (existing) {
          const [interaction] = await tx.select().from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.id, existing.interactionId),
            eq(issueThreadInteractions.companyId, input.companyId),
          ));
          const [comment] = await tx.select().from(issueComments).where(and(
            eq(issueComments.issueId, input.issueId),
            eq(issueComments.authorAgentId, input.agentId),
            eq(issueComments.createdByRunId, input.runId),
            eq(issueComments.clientRequestId, input.clientRequestId),
          ));
          const [delivery] = await tx.select().from(issueCommandDeliveries).where(and(
            eq(issueCommandDeliveries.companyId, input.companyId),
            eq(issueCommandDeliveries.interactionId, existing.interactionId),
            eq(issueCommandDeliveries.kind, "completion_review"),
          ));
          const target = interaction?.payload && typeof interaction.payload === "object" &&
            "target" in interaction.payload ? interaction.payload.target : null;
          const [interactionAudit] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId), eq(activityLog.entityId, input.issueId),
            eq(activityLog.runId, input.runId), eq(activityLog.action, "issue.thread_interaction_created"),
            sql`${activityLog.details}->>'interactionId' = ${existing.interactionId}`,
          )).limit(1);
          const [statusAudit] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId), eq(activityLog.entityId, input.issueId),
            eq(activityLog.runId, input.runId), eq(activityLog.action, "issue.updated"),
            sql`${activityLog.details}->>'clientRequestId' = ${input.clientRequestId}`,
            sql`${activityLog.details}->>'reviewInteractionId' = ${existing.interactionId}`,
          )).limit(1);
          const [commentAudit] = comment ? await tx.select({ id: activityLog.id }).from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId), eq(activityLog.entityId, input.issueId),
            eq(activityLog.runId, input.runId), eq(activityLog.action, "issue.comment_added"),
            sql`${activityLog.details}->>'commentId' = ${comment.id}`,
          )).limit(1) : [];
          const enabled = (await instanceSettingsService(tx).getGeneral()).censorUsernameInLogs;
          if (existing.issueId !== input.issueId || existing.sourceAgentId !== input.agentId ||
            existing.reviewerAgentId !== input.reviewerAgentId || existing.sourceKind !== "client_pull" ||
            existing.clientPullLeaseRunId !== input.runId || existing.requestDigest !== digest ||
            existing.state !== "pending" ||
            issue.status !== "in_review" || issue.statusVersion !== existing.issueStatusVersion ||
            issue.assigneeAgentId !== input.agentId || !interaction || !comment || !delivery ||
            !interactionAudit || !statusAudit || !commentAudit ||
            interaction.kind !== "request_confirmation" || interaction.status !== "pending" ||
            interaction.createdByAgentId !== input.agentId ||
            interaction.sourceRunId !== input.runId || interaction.addresseeAgentId !== input.reviewerAgentId ||
            interaction.effectiveResolverPolicy !== "not_creator" ||
            interaction.idempotencyKey !== input.clientRequestId ||
            !("prompt" in interaction.payload) || interaction.payload.prompt !== input.prompt ||
            !target || typeof target !== "object" || !("type" in target) || target.type !== "custom" ||
            !("key" in target) ||
            target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
            !("revisionId" in target) || target.revisionId !== existing.id ||
            comment.companyId !== input.companyId ||
            comment.body !== redactCurrentUserText(input.body, { enabled }) ||
            delivery.reviewId !== existing.id || delivery.issueId !== input.issueId ||
            delivery.sourceRunId !== input.runId || delivery.targetAgentId !== input.reviewerAgentId ||
            delivery.status !== "awaiting_handoff") {
            throw conflict("Completion review request differs from the committed command");
          }
          return { issue, interaction, review: existing, comment, delivery, replayed: true };
        }
        if (issue.status !== "in_progress") throw conflict("Completion review requires an in-progress task");
        // Work-record tasks have their own child/QA/PO completion contract.
        // A generic second-agent review would strand dependent children and
        // could accept the package without its PO's whole-work review.
        const [linkedRecord] = await tx.select({ id: workRecordIssueLinks.id })
          .from(workRecordIssueLinks).where(and(
            eq(workRecordIssueLinks.companyId, input.companyId),
            eq(workRecordIssueLinks.issueId, issue.id),
          )).limit(1);
        if (linkedRecord) throw unprocessable(
          "Work-record execution requires its child, QA or PO completion command",
          { code: "work_record_completion_contract_required" },
        );
        if (input.reviewerAgentId === input.agentId) throw unprocessable("An agent cannot review its own work");
        const [reviewer] = await tx.select({ companyId: agents.companyId, status: agents.status,
          pausedAt: agents.pausedAt, runtimeConfig: agents.runtimeConfig }).from(agents)
          .where(eq(agents.id, input.reviewerAgentId));
        if (!reviewer || reviewer.companyId !== input.companyId ||
          reviewer.status === "paused" || reviewer.status === "terminated" ||
          reviewer.status === "pending_approval" || reviewer.pausedAt ||
          !isClientPullRuntimeConfig(reviewer.runtimeConfig)) {
          throw unprocessable("Reviewer must be an active local agent in the same company");
        }
        const [sibling] = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            eq(issueThreadInteractions.kind, "request_confirmation"),
            eq(issueThreadInteractions.status, "pending"),
            eq(issueThreadInteractions.createdByAgentId, input.agentId),
          )).limit(1);
        if (sibling) throw conflict("Resolve the existing review confirmation before creating another");
        const reviewId = randomUUID();
        const interaction = await issueThreadInteractionService(tx).create(issue, {
          kind: "request_confirmation", idempotencyKey: input.clientRequestId,
          sourceRunId: input.runId, addresseeAgentId: input.reviewerAgentId,
          continuationPolicy: "wake_assignee", resolverPolicy: "not_creator",
          payload: { version: 1, prompt: input.prompt, allowDeclineReason: true,
            target: { type: "custom", key: ISSUE_COMPLETION_REVIEW_TARGET_KEY,
              revisionId: reviewId } },
        }, { agentId: input.agentId, identityContextId: actor.identityContextId ?? null },
        { supersedePendingSiblingInteractions: false });
        const target = interaction.payload && typeof interaction.payload === "object" &&
          "target" in interaction.payload ? interaction.payload.target : null;
        if (interaction.kind !== "request_confirmation" || interaction.status !== "pending" ||
          interaction.idempotencyKey !== input.clientRequestId ||
          interaction.sourceRunId !== input.runId ||
          interaction.effectiveResolverPolicy !== "not_creator" ||
          interaction.addresseeAgentId !== input.reviewerAgentId ||
          interaction.createdByAgentId !== input.agentId ||
          !target || typeof target !== "object" || !("type" in target) || target.type !== "custom" ||
          !("key" in target) || target.key !== ISSUE_COMPLETION_REVIEW_TARGET_KEY ||
          !("revisionId" in target) || target.revisionId !== reviewId) {
          throw unprocessable("Company governance does not permit this agent review");
        }
        await logActivity(tx, {
          companyId: issue.companyId, actorType: "agent", actorId: input.agentId,
          agentId: input.agentId, runId: input.runId, agentApiKeyId: actor.keyId,
          action: "issue.thread_interaction_created", entityType: "issue", entityId: issue.id,
          details: { interactionId: interaction.id, interactionKind: interaction.kind,
            interactionStatus: interaction.status, continuationPolicy: interaction.continuationPolicy,
            addresseeAgentId: input.reviewerAgentId,
            requestedResolverPolicy: interaction.requestedResolverPolicy,
            effectiveResolverPolicy: interaction.effectiveResolverPolicy },
        }, publications);
        const lockedIssue = await issueService(db).getByIdForUpdate(input.issueId, tx);
        if (!lockedIssue) throw notFound("Issue not found");
        const handoff = await executeReviewHandoff({
          db, tx, existing: lockedIssue,
          patch: { status: "in_review", statusVersion: issue.statusVersion + 1,
            actorAgentId: input.agentId, companyGuard: input.companyId },
          commentBody: input.body, clientRequestId: input.clientRequestId,
          reviewInteractionId: interaction.id,
          actor: { agentId: input.agentId, runId: input.runId,
            agentApiKeyId: actor.keyId, responsibleUserId: actor.onBehalfOfUserId },
          authorizationReason, publications,
        });
        if (handoff.issue.status !== "in_review" ||
          handoff.issue.statusVersion !== issue.statusVersion + 1) {
          throw conflict("Completion review status revision changed");
        }
        const [review] = await tx.insert(issueCompletionReviews).values({
          id: reviewId, companyId: input.companyId, issueId: input.issueId,
          sourceRunId: input.runId, sourceAgentId: input.agentId,
          reviewerAgentId: input.reviewerAgentId, interactionId: interaction.id,
          sourceKind: "client_pull", clientPullLeaseRunId: input.runId,
          requestId: input.clientRequestId, requestDigest: digest,
          issueStatusVersion: handoff.issue.statusVersion,
        }).returning();
        await recordPreparedWriteReceipt(tx, input, "completion_review_handoff", JSON.stringify({
          reviewerAgentId: input.reviewerAgentId, prompt: input.prompt,
          body: input.body,
        }), review.id);
        const [delivery] = await tx.insert(issueCommandDeliveries).values({
          companyId: input.companyId, issueId: input.issueId,
          interactionId: interaction.id, reviewId,
          sourceRunId: input.runId, targetAgentId: input.reviewerAgentId,
          kind: "completion_review", status: "awaiting_handoff",
        }).returning();
        return { ...handoff, interaction, review, delivery, replayed: false };
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
    addFencedComment, createFencedSubtask, completeFencedChildWorkRecord, prepareFencedPoVerdict,
    prepareFencedDefectRepairHandoff, readFencedDefectQaContext,
    prepareFencedDefectQaVerdict,
    readFencedWriteReceipt, readFencedFinishReceipt,
    createFencedReviewConfirmation, reviewFencedIssue,
    createFencedAgentReviewHandoff, createFencedCompletionReviewHandoff, patchFencedIssue };
}
