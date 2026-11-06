import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns,
  issueCommandDeliveries, issues, issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { interactionWakeKey, issueCommandDeliveryService } from "./issue-command-deliveries.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("inert review delivery state machine (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-review-delivery-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), creatorAgentId = randomUUID();
    const targetAgentId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery test",
      issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: creatorAgentId, companyId, name: "Creator" },
      { id: targetAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review task",
      status: "in_progress", assigneeAgentId: creatorAgentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: creatorAgentId,
      nativeIssueId: issueId, status: "running" });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, sourceRunId, kind: "request_confirmation", status: "pending",
      createdByAgentId: creatorAgentId, addresseeAgentId: targetAgentId,
      payload: { version: 1, prompt: "Please review" },
    }).returning();
    const input = { companyId, issueId, interactionId: interaction.id,
      sourceRunId, targetAgentId };
    const service = issueCommandDeliveryService(db as Db);
    const intent = await db.transaction((tx) => service.enqueue(tx as unknown as Db, input));
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await db.transaction((tx) => service.ready(tx as unknown as Db, input));
    return { ...input, creatorAgentId, intent, service };
  }

  async function receipt(f: Awaited<ReturnType<typeof seed>>, status = "queued") {
    const [saved] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.targetAgentId,
      source: "automation", triggerDetail: "system", reason: "interaction_pending", status,
      requestedByActorType: "agent", requestedByActorId: f.creatorAgentId,
      idempotencyKey: interactionWakeKey(f.interactionId),
      payload: { issueId: f.issueId, interactionId: f.interactionId,
        interactionKind: "request_confirmation", sourceCommentId: null,
        sourceRunId: f.sourceRunId, mutation: "interaction" },
    }).returning();
    return saved;
  }

  it("fences concurrent claims, verifies the named creator and acknowledges only a matching receipt", async () => {
    const f = await seed();
    const [first, second] = await Promise.all([
      f.service.claim({ companyId: f.companyId }),
      f.service.claim({ companyId: f.companyId }),
    ]);
    const claimed = first ?? second;
    expect(claimed).not.toBeNull();
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(f.service.wakeupRequest(claimed!).options.requestedByActorId).toBe(f.creatorAgentId);
    await expect(f.service.ack({ id: f.intent.id, claimToken: claimed!.claimToken,
      wakeupRequestId: randomUUID() })).rejects.toThrow();
    const wake = await receipt(f);
    const delivered = await f.service.ack({ id: f.intent.id, claimToken: claimed!.claimToken,
      wakeupRequestId: wake.id });
    expect(delivered).toMatchObject({ status: "delivered", wakeupRequestId: wake.id });
    await expect(f.service.ack({ id: f.intent.id, claimToken: claimed!.claimToken,
      wakeupRequestId: wake.id })).rejects.toThrow();
  }, 30_000);

  it("recovers accepted wakeups after lost acknowledgement without dispatching twice", async () => {
    const f = await seed();
    const claimed = await f.service.claim({ companyId: f.companyId });
    expect(claimed).not.toBeNull();
    const wake = await receipt(f);
    await db.update(issueCommandDeliveries).set({ claimExpiresAt: new Date(0) })
      .where(eq(issueCommandDeliveries.id, f.intent.id));
    expect(await f.service.recover(f.intent.id)).toMatchObject({
      status: "delivered", wakeupRequestId: wake.id,
    });
    expect(await f.service.claim({ companyId: f.companyId })).toBeNull();
    await expect(f.service.defer({ id: f.intent.id, claimToken: claimed!.claimToken,
      errorCode: "timeout", delayMs: 1000 })).rejects.toThrow();
  }, 30_000);

  it("does not reissue an unresolved wake and rejects a stale claim after cancellation", async () => {
    const f = await seed();
    const claimed = await f.service.claim({ companyId: f.companyId });
    expect(claimed).not.toBeNull();
    await receipt(f, "deferred_issue_execution");
    await db.update(issueCommandDeliveries).set({ claimExpiresAt: new Date(0) })
      .where(eq(issueCommandDeliveries.id, f.intent.id));
    expect(await f.service.recover(f.intent.id)).toMatchObject({ status: "deferred" });
    await db.update(issueCommandDeliveries).set({ nextAttemptAt: new Date(0) })
      .where(eq(issueCommandDeliveries.id, f.intent.id));
    expect(await f.service.claim({ companyId: f.companyId })).toBeNull();
    const [deferred] = await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.id, f.intent.id));
    expect(deferred.status).toBe("deferred");
    await db.transaction((tx) => f.service.cancel(tx as unknown as Db,
      { companyId: f.companyId, interactionId: f.interactionId }));
    await expect(f.service.ack({ id: f.intent.id, claimToken: claimed!.claimToken,
      wakeupRequestId: randomUUID() })).rejects.toThrow();
    const [cancelled] = await db.select().from(issueCommandDeliveries)
      .where(and(eq(issueCommandDeliveries.id, f.intent.id),
        eq(issueCommandDeliveries.status, "cancelled")));
    expect(cancelled).toBeDefined();
  }, 30_000);
});
