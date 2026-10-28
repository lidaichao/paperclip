import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  closeRegisteredClients,
  costEvents,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issues,
  projects,
  runDatabaseBackup,
  runDatabaseRestore,
  workRecordDependencies,
  workRecordDispatchBatches,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "@paperclipai/db";
import type { PreviewWorkPackageDispatch } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { workRecordRoutes } from "../routes/work-records.js";
import { workPackageDispatchService } from "../services/work-package-dispatch.js";
import { workRecordService } from "../services/work-records.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2-E workflow hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-m2e-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed(label: string) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `${label} ${suffix}`, issuePrefix: `E${suffix}` })
      .returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: label })
      .returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Rabbit M2-E",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    return { company, project, agent, records: workRecordService(db) };
  }

  function createApi(companyId: string, membershipRole: "admin" | "viewer" = "admin") {
    const previous = process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = "true";
    const router = workRecordRoutes(db);
    if (previous === undefined) delete process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED;
    else process.env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = previous;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: `m2e-${membershipRole}`,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
        source: "session",
        isInstanceAdmin: membershipRole === "admin",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", router);
    app.use(errorHandler);
    return app;
  }

  function input(projectId: string, selectedRecordIds: string[]): PreviewWorkPackageDispatch {
    return {
      workflowVersion: 2,
      projectId,
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds,
    };
  }

  async function prepare(companyId: string, projectId: string, selectedRecordIds: string[], requestId: string) {
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const command = input(projectId, selectedRecordIds);
    const preview = await service.preview(companyId, projectId, command);
    return service.prepare(companyId, projectId, {
      ...command,
      clientRequestId: requestId,
      requestPayloadDigest: `digest:${requestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "m2e-test" });
  }

  it("paginates records compatibly and rotates package reconciliation candidates", async () => {
    const context = await seed("M2-E pagination");
    const created = [];
    for (const title of ["Page A", "Page B", "Page C"]) {
      created.push(await context.records.create(context.company.id, {
        projectId: context.project.id,
        kind: "plan",
        title,
        assigneeAgentId: context.agent.id,
      }, { actorType: "system", actorId: "m2e-test" }));
    }
    const app = createApi(context.company.id);
    const base = `/api/companies/${context.company.id}/projects/${context.project.id}/work-records`;
    const legacy = await request(app).get(base).expect(200);
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body).toHaveLength(3);

    const first = await request(app).get(`${base}?limit=2`).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app).get(`${base}?limit=2&afterId=${first.body.nextCursor}`).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.items, ...second.body.items].map((row: { id: string }) => row.id)).size).toBe(3);

    await prepare(context.company.id, context.project.id, [created[0].id], "m2e-page-batch-a");
    await prepare(context.company.id, context.project.id, [created[1].id], "m2e-page-batch-b");
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const firstCandidates = await service.reconcilePage(1);
    expect(firstCandidates).toMatchObject({ processed: 1, nextAfterId: expect.any(String) });
    const secondCandidates = await service.reconcilePage(1, firstCandidates.nextAfterId);
    expect(secondCandidates).toMatchObject({ processed: 1, nextAfterId: null });
  });

  it("dead-letters after five failures, recovers the same row, and exposes cost/rollback metrics", async () => {
    const context = await seed("M2-E recovery");
    await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() }).where(eq(workRecordOutbox.workflowVersion, 2));
    const target = await context.records.create(context.company.id, {
      projectId: context.project.id,
      kind: "plan",
      title: "Dead-letter target",
      assigneeAgentId: context.agent.id,
    }, { actorType: "system", actorId: "m2e-test" });
    await prepare(context.company.id, context.project.id, [target.id], "m2e-dead-letter");
    const link = await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.recordId, target.id),
    )).then((rows) => rows[0]);
    await db.update(issues).set({ responsibleUserId: "m2e-owner" }).where(eq(issues.id, link.issueId));
    const event = await db.select().from(workRecordOutbox).where(and(
      eq(workRecordOutbox.companyId, context.company.id),
      eq(workRecordOutbox.recordId, target.id),
      eq(workRecordOutbox.workflowVersion, 2),
    )).then((rows) => rows[0]);
    const service = workPackageDispatchService(db, { writesEnabled: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.processOutbox(async () => {
        throw new Error("m2e_injected_wakeup_failure");
      }, 1);
      await db.update(workRecordOutbox).set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(workRecordOutbox.id, event.id));
    }
    expect(await db.select().from(workRecordOutbox).where(eq(workRecordOutbox.id, event.id)).then((rows) => rows[0]))
      .toMatchObject({ id: event.id, state: "dead_letter", attemptCount: 5, recoveryCount: 0 });
    const before = await service.operationsMetrics(context.company.id, context.project.id);
    expect(before.outbox).toMatchObject({ deadLetter: 1, maxAttempts: 5 });
    expect(before.rollback).toMatchObject({ safeForOldBinary: false, actionableOutboxEvents: 1 });

    const app = createApi(context.company.id);
    const recoveryPath = `/api/companies/${context.company.id}/projects/${context.project.id}/work-record-workflow/outbox/${event.id}/recover`;
    const conflict = await request(app).post(recoveryPath)
      .send({ expectedAttemptCount: 4, reason: "stale operator observation" }).expect(409);
    expect(conflict.body.details).toMatchObject({ code: "work_record_outbox_attempt_conflict" });
    await request(createApi(context.company.id, "viewer")).post(recoveryPath)
      .send({ expectedAttemptCount: 5, reason: "viewer cannot recover" }).expect(403);
    const recovered = await request(app).post(recoveryPath)
      .send({ expectedAttemptCount: 5, reason: "isolated M2-E recovery proof" }).expect(200);
    expect(recovered.body).toMatchObject({ id: event.id, state: "pending", attemptCount: 0, recoveryCount: 1 });

    const wake = await db.insert(agentWakeupRequests).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      source: "assignment",
      triggerDetail: "system",
      reason: "work_record_workflow_v2_released",
      status: "completed",
      idempotencyKey: `work-record-intent:${event.executionIntentId}:1`,
      finishedAt: new Date(),
    }).returning().then((rows) => rows[0]);
    const run = await db.insert(heartbeatRuns).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      status: "succeeded",
      wakeupRequestId: wake.id,
      startedAt: new Date(),
      finishedAt: new Date(),
    }).returning().then((rows) => rows[0]);
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    await service.processOutbox(async () => {
      throw new Error("existing admission receipt must prevent a duplicate wake");
    }, 1);
    expect(run).toMatchObject({ status: "succeeded" });
    await db.insert(costEvents).values({
      companyId: context.company.id,
      agentId: context.agent.id,
      issueId: link.issueId,
      projectId: context.project.id,
      heartbeatRunId: run.id,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "m2e-cost-proof",
      costCents: 37,
      occurredAt: new Date(),
    });
    const after = await service.operationsMetrics(context.company.id, context.project.id);
    expect(after.outbox).toMatchObject({ deadLetter: 0, recoveredEventCount: 1 });
    expect(after.execution).toMatchObject({ runs: 1, costEvents: 1, costCents: 37 });
    expect(after.rollback).toMatchObject({ safeForOldBinary: false, activeIntents: 1, actionableOutboxEvents: 0 });
  }, 30_000);

  it("accepts 200 records/8 levels/2,000 edges and rejects each +1 boundary without writes", async () => {
    const context = await seed("M2-E capacity");
    const ids = Array.from({ length: 200 }, () => randomUUID());
    await db.insert(workRecords).values(ids.map((id, index) => ({
      id,
      companyId: context.company.id,
      projectId: context.project.id,
      parentRecordId: index === 0 ? null : index <= 8 ? ids[index - 1] : ids[0],
      kind: "plan" as const,
      title: `Capacity ${index}`,
      assigneeAgentId: context.agent.id,
    })));
    const edges: Array<{
      companyId: string;
      projectId: string;
      predecessorRecordId: string;
      successorRecordId: string;
    }> = [];
    for (let successor = 1; successor < ids.length && edges.length < 2_000; successor += 1) {
      for (let predecessor = 0; predecessor < successor && edges.length < 2_000; predecessor += 1) {
        edges.push({
          companyId: context.company.id,
          projectId: context.project.id,
          predecessorRecordId: ids[predecessor],
          successorRecordId: ids[successor],
        });
      }
    }
    await db.insert(workRecordDependencies).values(edges);
    const service = workPackageDispatchService(db, { writesEnabled: true });
    const command: PreviewWorkPackageDispatch = {
      workflowVersion: 2,
      projectId: context.project.id,
      scopeKind: "whole_package",
      rootRecordId: ids[0],
      selectedRecordIds: [],
    };
    const durationsMs: number[] = [];
    for (let sample = 0; sample < 30; sample += 1) {
      const startedAt = performance.now();
      const preview = await service.preview(context.company.id, context.project.id, command);
      durationsMs.push(performance.now() - startedAt);
      expect(preview).toMatchObject({ recordCount: 200, edgeCount: 2_000, maxDepth: 8 });
    }

    const extraEdgeId = randomUUID();
    await db.insert(workRecordDependencies).values({
      id: extraEdgeId,
      companyId: context.company.id,
      projectId: context.project.id,
      predecessorRecordId: ids[198],
      successorRecordId: ids[199],
    });
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_dependency_snapshot_too_large", limit: 2_000, actual: 2_001 },
    });
    await db.delete(workRecordDependencies).where(eq(workRecordDependencies.id, extraEdgeId));

    await db.update(workRecords).set({ parentRecordId: ids[8] }).where(eq(workRecords.id, ids[9]));
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_depth_too_large", limit: 8, actual: 9 },
    });
    await db.update(workRecords).set({ parentRecordId: ids[0] }).where(eq(workRecords.id, ids[9]));

    const extraRecordId = randomUUID();
    await db.insert(workRecords).values({
      id: extraRecordId,
      companyId: context.company.id,
      projectId: context.project.id,
      parentRecordId: ids[0],
      kind: "plan",
      title: "Capacity 201",
      assigneeAgentId: context.agent.id,
    });
    await expect(service.preview(context.company.id, context.project.id, command)).rejects.toMatchObject({
      status: 422,
      details: { code: "work_package_scope_too_large", limit: 200, actual: 201 },
    });
    expect(await db.select().from(workRecordDispatchBatches).where(eq(workRecordDispatchBatches.companyId, context.company.id)))
      .toHaveLength(0);

    durationsMs.sort((left, right) => left - right);
    const evidence = {
      schemaVersion: 1,
      testedCommit: process.env.PAPERCLIP_M2E_TESTED_COMMIT ?? null,
      fixture: { records: 200, maxDepth: 8, edges: 2_000, samples: durationsMs.length },
      latencyMs: {
        min: durationsMs[0],
        p50: durationsMs[Math.floor((durationsMs.length - 1) * 0.5)],
        p95: durationsMs[Math.ceil((durationsMs.length - 1) * 0.95)],
        max: durationsMs.at(-1),
      },
      rejected: [
        { code: "work_package_scope_too_large", actual: 201 },
        { code: "work_package_depth_too_large", actual: 9 },
        { code: "work_package_dependency_snapshot_too_large", actual: 2_001 },
      ],
    };
    const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "capacity-performance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
  }, 240_000);

  it("backs up and restores workflow-v2 recovery facts into an empty isolated database", async () => {
    const sourceEvent = await db.select().from(workRecordOutbox)
      .where(eq(workRecordOutbox.recoveryCount, 1)).then((rows) => rows[0]);
    expect(sourceEvent).toBeTruthy();
    const backupDir = await mkdtemp(path.join(tmpdir(), "paperclip-m2e-backup-"));
    const sourceUrl = new URL(tempDb!.connectionString);
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const restoredDatabaseName = `m2e_restore_${randomUUID().replaceAll("-", "")}`;
    const restoredUrl = new URL(sourceUrl);
    restoredUrl.pathname = `/${restoredDatabaseName}`;
    try {
      const backup = await runDatabaseBackup({
        connectionString: sourceUrl.toString(),
        backupDir,
        filenamePrefix: "lun-305-workflow-v2",
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        backupEngine: "javascript",
      });
      await ensurePostgresDatabase(adminUrl.toString(), restoredDatabaseName);
      await runDatabaseRestore({ connectionString: restoredUrl.toString(), backupFile: backup.backupFile });
      const restoredDb = createDb(restoredUrl.toString());
      const restoredEvent = await restoredDb.select().from(workRecordOutbox)
        .where(eq(workRecordOutbox.id, sourceEvent.id)).then((rows) => rows[0]);
      expect(restoredEvent).toMatchObject({
        id: sourceEvent.id,
        workflowVersion: 2,
        state: sourceEvent.state,
        recoveryCount: 1,
        lastRecoveredAt: expect.any(Date),
      });
      const evidenceDir = process.env.PAPERCLIP_M2E_EVIDENCE_DIR?.trim();
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(path.join(evidenceDir, "backup-restore.json"), `${JSON.stringify({
          schemaVersion: 1,
          testedCommit: process.env.PAPERCLIP_M2E_TESTED_COMMIT ?? null,
          backupSizeBytes: backup.sizeBytes,
          restoredEvent: {
            id: restoredEvent.id,
            workflowVersion: restoredEvent.workflowVersion,
            state: restoredEvent.state,
            recoveryCount: restoredEvent.recoveryCount,
            lastRecoveredAt: restoredEvent.lastRecoveredAt,
          },
        }, null, 2)}\n`, "utf8");
      }
      await closeRegisteredClients(restoredUrl.toString());
    } finally {
      await closeRegisteredClients(restoredUrl.toString()).catch(() => {});
      await rm(backupDir, { recursive: true, force: true });
    }
  }, 120_000);
});
