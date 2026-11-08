import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  localAgentRunLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { admitDescriptionRevisionContinuation } from "./explicit-native-continuation.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("description revision final continuation admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("description-revision-admission-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const successorRunId = randomUUID();
    const intentKey = `work-record-description:${randomUUID()}:2`;
    await db.insert(companies).values({
      id: companyId,
      name: "Description continuation",
      defaultResponsibleUserId: "board",
      issuePrefix: `D${companyId.slice(0, 6)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Local agent",
      role: "engineer",
      adapterType: "paperclip_runner",
      status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue revised description",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      runtimeMode: "client_pull",
      status: "cancelled",
      contextSnapshot: { issueId },
      errorCode: "work_record_description_superseded",
      resultJson: {
        descriptionRevisionSuperseded: true,
        descriptionRevisionIntentKey: intentKey,
        interruptedIssueId: issueId,
      },
      finishedAt: new Date(),
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      cause: "uncertain_external_action",
      fingerprint: sourceRunId,
      status: "resolved",
      outcome: "blocked",
      nextAction: "Wait for the superseded local run to stop.",
      evidence: {
        runId: sourceRunId,
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown" },
      },
    });
    return {
      companyId,
      issueId,
      agentId,
      sourceRunId,
      successorRunId,
      intentKey,
    };
  }

  async function insertLease(
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: Partial<typeof localAgentRunLeases.$inferInsert> = {},
  ) {
    await db.insert(localAgentRunLeases).values({
      runId: fixture.sourceRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: fixture.issueId,
      deviceId: "device-1",
      idempotencyKey: `lease:${fixture.sourceRunId}`,
      expiresAt: new Date(Date.now() + 60_000),
      releasedAt: new Date(),
      stopAcknowledgedAt: new Date(),
      ...overrides,
    });
  }

  async function admit(
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: Partial<Parameters<typeof admitDescriptionRevisionContinuation>[0]> = {},
  ) {
    return db.transaction(async (tx) => admitDescriptionRevisionContinuation({
      db: tx as unknown as typeof db,
      ...fixture,
      actorType: "system",
      actorId: "work-record-description-delivery",
      reason: "work_record_description_updated",
      dryRun: true,
      ...overrides,
    }));
  }

  it("admits only after the exact client-pull lease carries release and stop acknowledgement", async () => {
    const fixture = await seed();
    await insertLease(fixture);

    await expect(admit(fixture)).resolves.toEqual({
      previousRunId: fixture.sourceRunId,
      intentKey: fixture.intentKey,
    });
  });

  it.each(["missing", "unreleased", "released_without_ack"] as const)(
    "fails closed when the client-pull stop receipt is %s",
    async (receipt) => {
      const fixture = await seed();
      if (receipt === "unreleased") {
        await insertLease(fixture, { releasedAt: null, stopAcknowledgedAt: null });
      } else if (receipt === "released_without_ack") {
        await insertLease(fixture, { stopAcknowledgedAt: null });
      }

      await expect(admit(fixture)).resolves.toBeNull();
    },
  );

  it("rejects a stop receipt attached to another source run", async () => {
    const fixture = await seed();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      nativeIssueId: fixture.issueId,
      runtimeMode: "client_pull",
      status: "cancelled",
      contextSnapshot: { issueId: fixture.issueId },
      finishedAt: new Date(),
    });
    await insertLease(fixture, {
      runId: otherRunId,
      idempotencyKey: `lease:${otherRunId}`,
    });

    await expect(admit(fixture)).resolves.toBeNull();
  });

  it("rejects a stop receipt for another task", async () => {
    const fixture = await seed();
    await insertLease(fixture, { issueId: randomUUID() });

    await expect(admit(fixture)).resolves.toBeNull();
  });

  it("rejects a stop receipt for another agent", async () => {
    const fixture = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "Other local agent",
      role: "engineer",
      adapterType: "paperclip_runner",
      status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await insertLease(fixture, { agentId: otherAgentId });

    await expect(admit(fixture)).resolves.toBeNull();
  });

  it("rejects a continuation intent not confirmed by the source run", async () => {
    const fixture = await seed();
    await insertLease(fixture);
    await db.update(heartbeatRuns).set({
      resultJson: {
        descriptionRevisionSuperseded: true,
        descriptionRevisionIntentKey: `${fixture.intentKey}:other`,
        interruptedIssueId: fixture.issueId,
      },
    }).where(eq(heartbeatRuns.id, fixture.sourceRunId));

    await expect(admit(fixture)).resolves.toBeNull();
  });
});
