import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import {
  agentSessionWriteGrants,
  agentSessionWriteReceipts,
  agents,
  localAgentDeviceBindings,
  localAgentRunLeases,
  type Db,
} from "@paperclipai/db";
import { badRequest, conflict, forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";

const MAX_TTL_MINUTES = 30;
const DEFAULT_TTL_MINUTES = 15;
const PROCESSING_LEASE_MS = 30_000;

export function hashSessionWriteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function digestSessionWriteRequest(method: string, path: string, body: unknown) {
  return createHash("sha256").update(JSON.stringify({ method, path, body })).digest("hex");
}

export function agentSessionWriteService(db: Db) {
  async function lockAgent(database: Db, companyId: string, agentId: string) {
    const agent = await database.select({ id: agents.id, runtimeConfig: agents.runtimeConfig }).from(agents).where(and(
      eq(agents.companyId, companyId), eq(agents.id, agentId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!agent) throw forbidden("Agent is unavailable");
    return agent;
  }

  async function assertExecutionLeaseCompatible(
    database: Db,
    companyId: string,
    agentId: string,
    method: string,
    path: string,
  ) {
    const active = await database.select({ runId: localAgentRunLeases.runId })
      .from(localAgentRunLeases).where(and(
        eq(localAgentRunLeases.companyId, companyId),
        eq(localAgentRunLeases.agentId, agentId),
        isNull(localAgentRunLeases.releasedAt),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!active) return;
    const appendOnlyWrite = method.toUpperCase() === "POST"
      && (
        /^\/api\/companies\/[0-9a-f-]{36}\/issues\/?$/i.test(path)
        || /^\/api\/issues\/[0-9a-f-]{36}\/comments\/?$/i.test(path)
      );
    if (appendOnlyWrite) return;
    throw conflict("Only task records and comments can be created while an execution lease exists", {
      code: "SESSION_WRITE_EXECUTION_LEASE_ACTIVE",
    });
  }

  return {
    issue: async (input: {
      companyId: string; agentId: string; keyId: string; deviceId?: string | null;
      ttlMinutes?: number;
    }) => {
      const ttlMinutes = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
      if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_TTL_MINUTES) {
        throw badRequest("ttlMinutes must be an integer from 1 through 30");
      }
      const deviceId = input.deviceId?.trim() || null;
      return db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        const agent = await lockAgent(scoped, input.companyId, input.agentId);
        const localHistory = await scoped.select({ runId: localAgentRunLeases.runId })
          .from(localAgentRunLeases).where(and(
            eq(localAgentRunLeases.companyId, input.companyId),
            eq(localAgentRunLeases.agentId, input.agentId),
          )).limit(1).then((rows) => rows[0] ?? null);
        if (agent.runtimeConfig?.executionMode !== "client_pull" && !localHistory) {
          throw forbidden("Session write grants are limited to client-pull-fenced agents", {
            code: "SESSION_WRITE_NOT_CLIENT_PULL_FENCED",
          });
        }
        if (deviceId) {
          const binding = await scoped.select({ id: localAgentDeviceBindings.id })
          .from(localAgentDeviceBindings).where(and(
            eq(localAgentDeviceBindings.companyId, input.companyId),
            eq(localAgentDeviceBindings.agentId, input.agentId),
            eq(localAgentDeviceBindings.keyId, input.keyId),
            eq(localAgentDeviceBindings.deviceId, deviceId),
            isNull(localAgentDeviceBindings.revokedAt),
          )).limit(1).then((rows) => rows[0] ?? null);
        if (!binding) throw forbidden("The requested device is not bound to this API key", {
          code: "SESSION_WRITE_DEVICE_NOT_BOUND",
        });
        }
        const token = `pcsw_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
        const [grant] = await scoped.insert(agentSessionWriteGrants).values({
        companyId: input.companyId,
        agentId: input.agentId,
        keyId: input.keyId,
        deviceId,
        tokenHash: hashSessionWriteToken(token),
        expiresAt,
      }).returning({ id: agentSessionWriteGrants.id, expiresAt: agentSessionWriteGrants.expiresAt });
        await logActivity(scoped, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        agentApiKeyId: input.keyId,
        action: "agent_session_write_grant_created",
        entityType: "agent_session_write_grant",
        entityId: grant!.id,
        details: { authorizationBasis: "agent_key", deviceId, expiresAt: grant!.expiresAt.toISOString() },
      });
        return { grantId: grant!.id, token, expiresAt: grant!.expiresAt };
      });
    },

    authorize: async (input: {
      companyId: string; agentId: string; keyId: string; token: string;
      idempotencyKey: string; requestDigest: string; method: string; path: string;
    }) => {
      if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
        throw badRequest("Idempotency-Key is required and must be at most 200 characters", {
          code: "SESSION_WRITE_IDEMPOTENCY_KEY_REQUIRED",
        });
      }
      return db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        await lockAgent(scoped, input.companyId, input.agentId);
        await assertExecutionLeaseCompatible(
          scoped,
          input.companyId,
          input.agentId,
          input.method,
          input.path,
        );
        const grant = await scoped.select().from(agentSessionWriteGrants).where(and(
        eq(agentSessionWriteGrants.tokenHash, hashSessionWriteToken(input.token)),
        eq(agentSessionWriteGrants.companyId, input.companyId),
        eq(agentSessionWriteGrants.agentId, input.agentId),
        eq(agentSessionWriteGrants.keyId, input.keyId),
        isNull(agentSessionWriteGrants.revokedAt),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!grant || grant.expiresAt.getTime() <= Date.now()) throw forbidden("Session write grant is invalid or expired", {
        code: "SESSION_WRITE_GRANT_INVALID",
      });

        const now = new Date();
        const processingLeaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
        const [created] = await scoped.insert(agentSessionWriteReceipts).values({
        companyId: input.companyId,
        agentId: input.agentId,
        keyId: input.keyId,
        grantId: grant.id,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        processingLeaseExpiresAt,
      }).onConflictDoNothing().returning({ id: agentSessionWriteReceipts.id });
      let receipt = created
          ? await scoped.select().from(agentSessionWriteReceipts).where(eq(agentSessionWriteReceipts.id, created.id)).then((rows) => rows[0]!)
          : await scoped.select().from(agentSessionWriteReceipts).where(and(
            eq(agentSessionWriteReceipts.companyId, input.companyId),
            eq(agentSessionWriteReceipts.agentId, input.agentId),
            eq(agentSessionWriteReceipts.keyId, input.keyId),
            eq(agentSessionWriteReceipts.idempotencyKey, input.idempotencyKey),
          )).limit(1).then((rows) => rows[0] ?? null);
      if (!receipt && !created) {
        receipt = await scoped.select().from(agentSessionWriteReceipts).where(and(
          eq(agentSessionWriteReceipts.companyId, input.companyId),
          eq(agentSessionWriteReceipts.agentId, input.agentId),
          eq(agentSessionWriteReceipts.keyId, input.keyId),
          eq(agentSessionWriteReceipts.requestDigest, input.requestDigest),
          isNull(agentSessionWriteReceipts.completedAt),
        )).limit(1).then((rows) => rows[0] ?? null);
      }
      if (!receipt) throw new Error("Session write receipt conflict could not be resolved");
      if (receipt.requestDigest !== input.requestDigest) throw conflict("Idempotency-Key was already used for a different request", {
        code: "SESSION_WRITE_IDEMPOTENCY_CONFLICT",
      });
      if (!created) {
        if (receipt.completedAt && receipt.statusCode !== null) return { replay: true as const, receipt, grant };
        if (receipt.processingLeaseExpiresAt.getTime() > now.getTime()) {
          throw conflict("The idempotent session write is still in progress", {
            code: "SESSION_WRITE_IN_PROGRESS",
            retryAfterMs: receipt.processingLeaseExpiresAt.getTime() - now.getTime(),
          });
        }
        const [recovered] = await scoped.update(agentSessionWriteReceipts).set({
          processingLeaseExpiresAt,
          recoveryCount: sql`${agentSessionWriteReceipts.recoveryCount} + 1`,
        }).where(and(
          eq(agentSessionWriteReceipts.id, receipt.id),
          isNull(agentSessionWriteReceipts.completedAt),
          lte(agentSessionWriteReceipts.processingLeaseExpiresAt, now),
        )).returning();
        if (!recovered) throw conflict("The idempotent session write is still in progress", {
          code: "SESSION_WRITE_IN_PROGRESS",
        });
        receipt = recovered;
      }
        await logActivity(scoped, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        agentApiKeyId: input.keyId,
        action: "agent_session_write_authorized",
        entityType: "agent_session_write_receipt",
        entityId: receipt.id,
        details: {
          authorizationBasis: "session_write",
          grantId: grant.id,
          requestDigest: input.requestDigest,
          method: input.method,
          path: input.path,
          recovery: !created,
          recoveryCount: receipt.recoveryCount,
        },
      });
        return { replay: false as const, recovery: !created, receipt, grant };
      });
    },

    complete: async (receiptId: string, statusCode: number, responseBody: unknown) => {
      await db.update(agentSessionWriteReceipts).set({
        statusCode,
        responseBody: responseBody === undefined ? null : responseBody,
        completedAt: new Date(),
      }).where(and(eq(agentSessionWriteReceipts.id, receiptId), isNull(agentSessionWriteReceipts.completedAt)));
    },
  };
}
