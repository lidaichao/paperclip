import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  workRecordDispatchBatches,
  workRecordDispatchBatchItems,
  workRecordDependencySnapshots,
  workRecordExecutionHolds,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
} from "@paperclipai/db";
import type { PreviewWorkPackageDispatch } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workPackageDispatchService, type WorkPackageFailpoint } from "../services/work-package-dispatch.js";
import { issueService } from "../services/issues.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2-B work-package dispatch and cancellation source barrier", () => {
  let db!: ReturnType<typeof createDb>;
  let secondDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-package-dispatch-");
    db = createDb(tempDb.connectionString);
    secondDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `M2B ${suffix}`, issuePrefix: `M${suffix}` }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "M2B package" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Rabbit",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]);
    return { company, project, agent, records: workRecordService(db) };
  }

  async function record(
    context: Awaited<ReturnType<typeof seed>>,
    title: string,
    options: { parentRecordId?: string; predecessorRecordIds?: string[]; assigned?: boolean } = {},
  ) {
    return context.records.create(context.company.id, {
      projectId: context.project.id,
      parentRecordId: options.parentRecordId,
      kind: "plan",
      title,
      assigneeAgentId: options.assigned === false ? null : context.agent.id,
      predecessorRecordIds: options.predecessorRecordIds ?? [],
    }, { actorType: "system", actorId: "test" });
  }

  function scopeInput(
    context: Awaited<ReturnType<typeof seed>>,
    input: Omit<PreviewWorkPackageDispatch, "workflowVersion" | "projectId">,
  ): PreviewWorkPackageDispatch {
    return { workflowVersion: 2, projectId: context.project.id, ...input };
  }

  async function prepare(
    service: ReturnType<typeof workPackageDispatchService>,
    context: Awaited<ReturnType<typeof seed>>,
    input: PreviewWorkPackageDispatch,
    requestId = randomUUID(),
  ) {
    const preview = await service.preview(context.company.id, context.project.id, input);
    return service.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: requestId,
      requestPayloadDigest: `payload:${requestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" });
  }

  it("D01 keeps writes disabled by default while preview remains read-only", async () => {
    const context = await seed();
    const target = await record(context, "Preview only");
    const service = workPackageDispatchService(db, { writesEnabled: false });
    const input = scopeInput(context, { scopeKind: "selected_records", rootRecordId: null, selectedRecordIds: [target.id] });
    const preview = await service.preview(context.company.id, context.project.id, input);
    expect(preview.records.map((item) => item.id)).toEqual([target.id]);
    await expect(service.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "disabled",
      requestPayloadDigest: "disabled",
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" })).rejects.toMatchObject({
      status: 403,
      details: { code: "work_record_workflow_v2_disabled" },
    });
  });

  it("D02 rejects a whole package with one missing owner without a batch, issue, intent, or release", async () => {
    const context = await seed();
    const root = await record(context, "Root");
    await record(context, "Unassigned child", { parentRecordId: root.id, assigned: false });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    await expect(service.preview(context.company.id, context.project.id, scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }))).rejects.toMatchObject({ status: 422, details: { code: "work_package_assignment_required" } });
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, context.company.id))).toHaveLength(0);
  });

  it("D03 partial dispatch materializes only explicit selections and reuses an existing primary link", async () => {
    const context = await seed();
    const parent = await record(context, "Parent");
    const selected = await record(context, "Selected", { parentRecordId: parent.id });
    const sibling = await record(context, "Sibling", { parentRecordId: parent.id });
    const existing = await context.records.dispatch(context.company.id, context.project.id, selected.id, {
      clientRequestId: "legacy-link",
      expectedRevision: selected.revision,
    }, { actorType: "system", actorId: "test" });
    await db.delete(workRecordOutbox).where(eq(workRecordOutbox.companyId, context.company.id));
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const result = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [selected.id],
    }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ recordId: selected.id, materializationState: "reused" });
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(1);
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.issueId, existing.issueId),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordDispatchBatchItems).where(and(
      eq(workRecordDispatchBatchItems.companyId, context.company.id),
      eq(workRecordDispatchBatchItems.recordId, sibling.id),
    ))).toHaveLength(0);
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.recordId, parent.id),
    ))).toHaveLength(0);
  });

  it("D04-D06 holds an undispatched prerequisite and turns cancellation into impact_review without a PO release", async () => {
    const context = await seed();
    const root = await record(context, "Package root");
    const prerequisite = await record(context, "Prerequisite");
    const child = await record(context, "Child", { parentRecordId: root.id, predecessorRecordIds: [prerequisite.id] });
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const result = await prepare(service, context, scopeInput(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }));
    const childLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, child.id),
    )).then((rows) => rows[0]);
    expect(await db.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.dependentIssueId, childLink.issueId),
      eq(workRecordExecutionHolds.reason, "prerequisite_not_dispatched"),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, child.id),
    ))).toHaveLength(0);

    const prerequisiteDispatch = await context.records.dispatch(context.company.id, context.project.id, prerequisite.id, {
      clientRequestId: "cancel-prerequisite",
      expectedRevision: prerequisite.revision,
    }, { actorType: "system", actorId: "test" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, prerequisiteDispatch.issueId));
    await context.records.reconcileRecord(context.company.id, context.project.id, child.id);
    await service.reconcile(context.company.id, context.project.id, result.batch.id, { actorType: "system", actorId: "test" });
    expect(await db.select().from(workRecordExecutionHolds).where(and(
      eq(workRecordExecutionHolds.dependentIssueId, childLink.issueId),
      eq(workRecordExecutionHolds.reason, "prerequisite_cancelled_impact_pending"),
    ))).toHaveLength(1);

    const childIssue = await db.select().from(issues).where(eq(issues.id, childLink.issueId)).then((rows) => rows[0]);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childIssue.id));
    await service.reconcile(context.company.id, context.project.id, result.batch.id, { actorType: "system", actorId: "test" });
    const rootLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, root.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, rootLink.issueId));
    await expect(issueService(db).getWakeableParentAfterChildCompletion(rootLink.issueId)).resolves.toBeNull();
    const cycle = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, root.id),
    )).then((rows) => rows[0]);
    expect(cycle.qualityPhase).toBe("impact_review");
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.eventType, "po_acceptance_release"),
    ))).toHaveLength(0);
  });

  it("R04-R06 converges after batch, partial-materialization, response-loss, and stale-event failpoints", async () => {
    const context = await seed();
    const root = await record(context, "Recovery root");
    await record(context, "Recovery child", { parentRecordId: root.id });
    const input = scopeInput(context, { scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [] });
    const fail = (name: WorkPackageFailpoint) => {
      if (name === "before_batch_commit") throw new Error("before_batch_commit");
    };
    const failing = workPackageDispatchService(db, { writesEnabled: true, failpoint: fail });
    const preview = await failing.preview(context.company.id, context.project.id, input);
    await expect(failing.prepare(context.company.id, context.project.id, {
      ...input,
      clientRequestId: "rollback-before-batch",
      requestPayloadDigest: "rollback-before-batch",
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "test" })).rejects.toThrow("before_batch_commit");
    expect(await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, context.company.id),
      eq(workRecordDispatchBatches.clientRequestId, "rollback-before-batch"),
    ))).toHaveLength(0);

    let partialFailed = false;
    const partial = workPackageDispatchService(db, {
      writesEnabled: true,
      failpoint: (name) => {
        if (name === "after_partial_materialization" && !partialFailed) {
          partialFailed = true;
          throw new Error("after_partial_materialization");
        }
      },
    });
    await expect(prepare(partial, context, input, "partial-recovery")).rejects.toThrow("after_partial_materialization");
    const batch = await db.select().from(workRecordDispatchBatches).where(and(
      eq(workRecordDispatchBatches.companyId, context.company.id),
      eq(workRecordDispatchBatches.clientRequestId, "partial-recovery"),
    )).then((rows) => rows[0]);
    const recovered = await workPackageDispatchService(db, { writesEnabled: true }).reconcile(
      context.company.id,
      context.project.id,
      batch.id,
      { actorType: "system", actorId: "test" },
    );
    expect(recovered.batch.state).toBe("prepared");
    expect(recovered.items.every((item) => ["materialized", "reused"].includes(item.materializationState))).toBe(true);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(2);

    const childIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "initial_release"),
    )).then((rows) => rows[0]);
    const event = await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.executionIntentId, childIntent.id)).then((rows) => rows[0]);
    expect(event).toBeTruthy();
    let responseLost = false;
    const responseLoss = workPackageDispatchService(db, {
      writesEnabled: true,
      failpoint: (name) => {
        if (name === "after_outbox_commit" && !responseLost) {
          responseLost = true;
          throw new Error("response_lost");
        }
      },
    });
    const wake = async (agentId: string, options: { idempotencyKey: string }) => {
      const owner = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
      const request = await db.insert(agentWakeupRequests).values({
        companyId: owner.companyId,
        agentId,
        source: "assignment",
        status: "queued",
        idempotencyKey: options.idempotencyKey,
      }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
      if (request) await db.insert(heartbeatRuns).values({ companyId: owner.companyId, agentId, wakeupRequestId: request.id, status: "queued" });
      return request;
    };
    await responseLoss.processOutbox(wake as never);
    await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) }).where(eq(workRecordOutbox.id, event.id));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(wake as never);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${childIntent.id}:${childIntent.generation}`),
    ))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.agent.id),
    ))).toHaveLength(1);

    const staleTarget = await record(context, "Stale target");
    const stale = await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [staleTarget.id],
    }), "stale-event");
    const staleLink = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id), eq(workRecordIssueLinks.recordId, staleTarget.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ status: "in_progress", statusVersion: 1 }).where(eq(issues.id, staleLink.issueId));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(wake as never);
    const staleIntent = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id), eq(workRecordExecutionIntents.recordId, staleTarget.id),
    )).then((rows) => rows[0]);
    expect(stale.batch.state).toBe("prepared");
    expect(staleIntent.state).toBe("superseded");

    const unknownTarget = await record(context, "Unknown event target");
    await prepare(workPackageDispatchService(db, { writesEnabled: true }), context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [unknownTarget.id],
    }), "unknown-event");
    const unknownEvent = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, unknownTarget.id),
    )).then((rows) => rows[0]);
    await db.update(workRecordOutbox).set({ eventType: "unknown_v2_event" }).where(eq(workRecordOutbox.id, unknownEvent.id));
    const wakeCountBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id));
    await workPackageDispatchService(db, { writesEnabled: true }).processOutbox(wake as never);
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, unknownEvent.id)).then((rows) => rows[0])).toMatchObject({
      state: "superseded",
      lastError: expect.stringContaining("Unsupported work-record workflow v2 event"),
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, context.company.id))).toHaveLength(wakeCountBefore.length);
  });

  it("G01-G02 supersedes stale intent/outbox facts and requires a fresh dependency snapshot", async () => {
    const context = await seed();
    const target = await record(context, "Revision target");
    const newPrerequisite = await record(context, "New prerequisite");
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const first = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-one");
    const previousFlag = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = "true";
    try {
      const revised = await context.records.update(context.company.id, context.project.id, target.id, {
        expectedRevision: target.revision,
        predecessorRecordIds: [newPrerequisite.id],
      });
      expect(revised.dependencySetRevision).toBe(target.dependencySetRevision + 1);
    } finally {
      if (previousFlag === undefined) delete process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
      else process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = previousFlag;
    }
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.id, first.batch.id)).then((rows) => rows[0])).toMatchObject({ state: "superseded" });
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id), eq(workRecordExecutionIntents.recordId, target.id),
    )).then((rows) => rows[0])).toMatchObject({ state: "superseded" });
    expect(await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id), eq(workRecordOutbox.recordId, target.id),
    )).then((rows) => rows[0])).toMatchObject({ state: "superseded" });

    const second = await prepare(service, context, scopeInput(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [target.id],
    }), "revision-two");
    expect(second.batch.id).not.toBe(first.batch.id);
    expect(await db.select().from(workRecordDependencySnapshots).where(and(
      eq(workRecordDependencySnapshots.companyId, context.company.id),
      eq(workRecordDependencySnapshots.batchId, second.batch.id),
    ))).toEqual([expect.objectContaining({
      predecessorRecordId: newPrerequisite.id,
      successorRecordId: target.id,
    })]);
  });

  it("O01 serializes 50 real PostgreSQL multi-connection request races to one batch, link, and intent", async () => {
    const context = await seed();
    const first = workPackageDispatchService(db, { writesEnabled: true });
    const second = workPackageDispatchService(secondDb, { writesEnabled: true });
    for (let round = 0; round < 50; round += 1) {
      const target = await record(context, `Race ${round}`);
      const input = scopeInput(context, { scopeKind: "selected_records", rootRecordId: null, selectedRecordIds: [target.id] });
      const preview = await first.preview(context.company.id, context.project.id, input);
      const request = {
        ...input,
        clientRequestId: `race-${round}`,
        requestPayloadDigest: `race-payload-${round}`,
        expectedScopeDigest: preview.scopeDigest,
        expectedRootRevision: preview.rootRevision,
        expectedDependencySetRevision: preview.dependencySetRevision,
      };
      const [left, right] = await Promise.all([
        first.prepare(context.company.id, context.project.id, request, { actorType: "system", actorId: "left" }),
        second.prepare(context.company.id, context.project.id, request, { actorType: "system", actorId: "right" }),
      ]);
      expect(left.batch.id).toBe(right.batch.id);
      if (round === 0) {
        await expect(first.prepare(context.company.id, context.project.id, {
          ...request,
          requestPayloadDigest: "conflicting-payload",
        }, { actorType: "system", actorId: "conflict" })).rejects.toMatchObject({
          status: 409,
          details: { code: "work_record_workflow_idempotency_conflict" },
        });
      }
    }
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id))).toHaveLength(50);
    expect(await db.select().from(workRecordIssueLinks).where(eq(workRecordIssueLinks.companyId, context.company.id))).toHaveLength(50);
    expect(await db.select().from(workRecordExecutionIntents).where(eq(workRecordExecutionIntents.companyId, context.company.id))).toHaveLength(50);
  }, 120_000);
});
