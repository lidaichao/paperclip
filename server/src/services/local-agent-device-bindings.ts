import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, heartbeatRuns, localAgentDeviceBindings, localAgentRunLeases } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^[a-zA-Z0-9._:-]{8,128}$/;

export async function assertBoundLocalDevice(tx: Db, input: {
  companyId: string; agentId: string; keyId: string; deviceId: string;
}, options: { allowRevoked?: boolean } = {}) {
  if (!UUID.test(input.keyId) || !DEVICE_ID.test(input.deviceId)) throw forbidden("Device credential is not bound");
  // Authentication happened before this transaction. Lock and recheck the
  // bearer key so a concurrent key revocation cannot race a claim or write.
  const [key] = await tx.select({ id: agentApiKeys.id }).from(agentApiKeys).where(and(
    eq(agentApiKeys.id, input.keyId),
    eq(agentApiKeys.companyId, input.companyId),
    eq(agentApiKeys.agentId, input.agentId),
    isNull(agentApiKeys.revokedAt),
  )).for("update");
  if (!key) throw forbidden("Device credential key is revoked or missing");
  const [binding] = await tx.select().from(localAgentDeviceBindings).where(and(
    eq(localAgentDeviceBindings.companyId, input.companyId),
    eq(localAgentDeviceBindings.agentId, input.agentId),
    eq(localAgentDeviceBindings.keyId, input.keyId),
    eq(localAgentDeviceBindings.deviceId, input.deviceId),
  )).limit(1);
  if (!binding || (binding.revokedAt && !options.allowRevoked)) {
    throw forbidden("Device credential is not approved");
  }
  return binding;
}

export function localAgentDeviceBindingService(db: Db) {
  async function bind(input: {
    companyId: string; agentId: string; keyId: string; deviceId: string;
    createdByUserId?: string | null;
  }) {
    if (!UUID.test(input.agentId) || !UUID.test(input.keyId) || !DEVICE_ID.test(input.deviceId)) {
      throw badRequest("Invalid agent, key, or device ID");
    }
    return db.transaction(async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
      )).for("update");
      if (!agent) throw notFound("Agent not found");
      const [key] = await tx.select().from(agentApiKeys).where(and(
        eq(agentApiKeys.id, input.keyId), eq(agentApiKeys.agentId, input.agentId),
        eq(agentApiKeys.companyId, input.companyId), isNull(agentApiKeys.revokedAt),
      )).for("update");
      if (!key) throw forbidden("Agent key is missing, revoked, or belongs to another agent");
      const [oldKey] = await tx.select({ id: localAgentDeviceBindings.id }).from(localAgentDeviceBindings)
        .where(eq(localAgentDeviceBindings.keyId, input.keyId)).limit(1);
      if (oldKey) throw conflict("Agent key has already been bound to a device");
      const [activeDevice] = await tx.select({ id: localAgentDeviceBindings.id }).from(localAgentDeviceBindings)
        .where(and(eq(localAgentDeviceBindings.companyId, input.companyId),
          eq(localAgentDeviceBindings.agentId, input.agentId),
          eq(localAgentDeviceBindings.deviceId, input.deviceId),
          isNull(localAgentDeviceBindings.revokedAt))).limit(1);
      if (activeDevice) throw conflict("Device already has an active key binding");
      const [binding] = await tx.insert(localAgentDeviceBindings).values(input).returning();
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: "user", actorId: input.createdByUserId ?? "board",
        action: "agent.local_device_bound", entityType: "agent", entityId: input.agentId,
        details: { bindingId: binding.id, keyId: input.keyId },
      });
      return binding;
    });
  }

  async function list(companyId: string, agentId: string) {
    return db.select().from(localAgentDeviceBindings).where(and(
      eq(localAgentDeviceBindings.companyId, companyId),
      eq(localAgentDeviceBindings.agentId, agentId),
    ));
  }

  async function revoke(input: {
    companyId: string; agentId: string; bindingId: string; revokedByUserId?: string | null;
  }) {
    if (!UUID.test(input.agentId) || !UUID.test(input.bindingId)) throw badRequest("Invalid binding ID");
    return db.transaction(async (tx) => {
      // Claim takes this agent lock first. Revocation then takes run and lease
      // locks in the same order as renewal and content writes.
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
      )).for("update");
      if (!agent) throw notFound("Agent not found");
      const [binding] = await tx.select().from(localAgentDeviceBindings).where(and(
        eq(localAgentDeviceBindings.id, input.bindingId),
        eq(localAgentDeviceBindings.companyId, input.companyId),
        eq(localAgentDeviceBindings.agentId, input.agentId),
      )).limit(1);
      if (!binding) throw notFound("Device binding not found");
      if (binding.revokedAt) return binding;
      const [candidate] = await tx.select({ runId: localAgentRunLeases.runId })
        .from(localAgentRunLeases).where(and(
          eq(localAgentRunLeases.companyId, input.companyId),
          eq(localAgentRunLeases.agentId, input.agentId),
          eq(localAgentRunLeases.deviceKeyId, binding.keyId),
          isNull(localAgentRunLeases.releasedAt),
        )).limit(1);
      if (candidate) {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.runId)).for("update");
        const [lease] = await tx.select().from(localAgentRunLeases)
          .where(eq(localAgentRunLeases.runId, candidate.runId)).for("update");
        if (lease && !lease.releasedAt) await tx.update(localAgentRunLeases).set({
          cancelRequestedAt: sql`coalesce(${localAgentRunLeases.cancelRequestedAt}, now())`,
          updatedAt: sql`now()`,
        }).where(eq(localAgentRunLeases.runId, candidate.runId));
      }
      const [revoked] = await tx.update(localAgentDeviceBindings).set({
        revokedAt: sql`now()`, revokedByUserId: input.revokedByUserId ?? null,
      }).where(eq(localAgentDeviceBindings.id, binding.id)).returning();
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId, actorType: "user", actorId: input.revokedByUserId ?? "board",
        action: "agent.local_device_revoked", entityType: "agent", entityId: input.agentId,
        details: { bindingId: binding.id, keyId: binding.keyId,
          activeRunId: candidate?.runId ?? null },
      });
      return revoked;
    });
  }

  return { bind, list, revoke };
}
