import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentApiKeys, agents, companies, createDb, heartbeatRuns,
  issueComments, issueCommandDeliveries, issueThreadInteractions, issues,
  localAgentDeviceBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { localAgentRunLeaseService } from "./local-agent-run-leases.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("internal local-run agent review handoff (PostgreSQL)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = external ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-local-agent-review-");
    db = createDb(external ?? temporary!.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), reviewerAgentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), keyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Agent review fixture",
      issuePrefix: `A${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Author", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
      { id: reviewerAgentId, companyId, name: "Reviewer", adapterType: "codex_local",
        runtimeConfig: { executionMode: "client_pull" } },
    ]);
    await db.insert(agentApiKeys).values({ id: keyId, companyId, agentId,
      name: "Review fixture key", keyHash: randomUUID() });
    await db.insert(localAgentDeviceBindings).values({ companyId, agentId, keyId,
      deviceId: "device-desktop-001" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Agent review task",
      status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "queued", contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    const service = localAgentRunLeaseService(db);
    const claimed = await service.claim({ companyId, agentId, keyId,
      deviceId: "device-desktop-001", idempotencyKey: randomUUID() });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const actor = { type: "agent", source: "agent_key", agentId, companyId, keyId } as const;
    const command = { companyId, agentId, reviewerAgentId, issueId, runId, keyId,
      deviceId: "device-desktop-001", leaseId: claimed!.leaseId,
      generation: claimed!.generation, prompt: "Verify the result",
      body: "Ready for acceptance", clientRequestId: randomUUID() };
    return { service, command, actor };
  }

  it("commits card, review status, comment, audits and ready intent together; exact retry is read-only", async () => {
    const f = await fixture();
    const first = await f.service.createFencedAgentReviewHandoff(f.command, f.actor);
    expect(first.replayed).toBe(false);
    expect(first.issue.status).toBe("in_review");
    expect(first.comment.createdByRunId).toBe(f.command.runId);
    expect(first.interaction).toMatchObject({ addresseeAgentId: f.command.reviewerAgentId,
      requestedResolverPolicy: "not_creator", sourceRunId: f.command.runId });
    expect(first.delivery).toMatchObject({ status: "ready", targetAgentId: f.command.reviewerAgentId });
    await db.update(issueThreadInteractions).set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, first.interaction.id));
    const replay = await f.service.createFencedAgentReviewHandoff(f.command, f.actor);
    expect(replay.replayed).toBe(true);
    expect(replay.interaction.id).toBe(first.interaction.id);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.command.issueId)))
      .toHaveLength(1);
    expect(await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.issueId, f.command.issueId))).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, f.command.issueId));
    expect(audit.filter((row) => ["issue.thread_interaction_created", "issue.updated",
      "issue.comment_added"].includes(row.action))).toHaveLength(3);
    for (const changed of [
      { body: "Changed handoff" }, { prompt: "Changed request" },
      { reviewerAgentId: randomUUID() }, { clientRequestId: randomUUID() },
    ]) {
      await expect(f.service.createFencedAgentReviewHandoff({ ...f.command, ...changed }, f.actor))
        .rejects.toMatchObject({ status: 409 });
    }
  }, 30_000);

  it("rolls back the full command when status audit insertion fails", async () => {
    const f = await fixture();
    await db.execute(sql`create function reject_agent_review_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'issue.updated' then raise exception 'injected review audit failure'; end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger reject_agent_review_audit_trigger before insert on activity_log
      for each row execute function reject_agent_review_audit()`);
    try {
      await expect(f.service.createFencedAgentReviewHandoff(f.command, f.actor)).rejects.toThrow();
      expect(await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, f.command.issueId))).toHaveLength(0);
      expect(await db.select().from(issueComments)
        .where(eq(issueComments.issueId, f.command.issueId))).toHaveLength(0);
      expect(await db.select().from(issueCommandDeliveries)
        .where(eq(issueCommandDeliveries.issueId, f.command.issueId))).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.command.issueId));
      expect(issue.status).toBe("in_progress");
    } finally {
      await db.execute(sql`drop trigger reject_agent_review_audit_trigger on activity_log`);
      await db.execute(sql`drop function reject_agent_review_audit()`);
    }
  }, 30_000);

  it("rejects company human-only governance without leaving an orphan card", async () => {
    const f = await fixture();
    await db.update(companies).set({ interactionResolverGovernance: {
      request_confirmation: { cap: "human_only" },
    } }).where(eq(companies.id, f.command.companyId));
    await expect(f.service.createFencedAgentReviewHandoff(f.command, f.actor))
      .rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, f.command.issueId))).toHaveLength(0);
    expect(await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.issueId, f.command.issueId))).toHaveLength(0);
  }, 30_000);

  it("rejects a prior pending confirmation without superseding it", async () => {
    const f = await fixture();
    const [old] = await db.insert(issueThreadInteractions).values({
      companyId: f.command.companyId, issueId: f.command.issueId,
      kind: "request_confirmation", status: "pending", sourceRunId: f.command.runId,
      createdByAgentId: f.command.agentId,
      payload: { version: 1, prompt: "Older review" },
    }).returning();
    await expect(f.service.createFencedAgentReviewHandoff(f.command, f.actor))
      .rejects.toMatchObject({ status: 409 });
    const cards = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, f.command.issueId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: old.id, status: "pending" });
    expect(await db.select().from(issueCommandDeliveries)
      .where(eq(issueCommandDeliveries.issueId, f.command.issueId))).toHaveLength(0);
  }, 30_000);
});
