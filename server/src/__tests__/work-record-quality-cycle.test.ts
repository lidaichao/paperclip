import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  workRecords,
  workRecordExecutionIntents,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecordQualityCycles,
  workRecordQualityItems,
  workRecordQualityLinks,
  workRecordQualityVerdicts,
} from "@paperclipai/db";
import type { PreviewWorkPackageDispatch } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { workPackageDispatchService } from "../services/work-package-dispatch.js";
import { workRecordQualityService } from "../services/work-record-quality.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2-C PO, QA, rework, and defect quality cycles", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const evidence: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-quality-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    const evidenceDir = process.env.PAPERCLIP_M2C_EVIDENCE_DIR?.trim();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "quality-cycle-evidence.json"), `${JSON.stringify({
        schemaVersion: 1,
        testedCommit: process.env.PAPERCLIP_M2C_TESTED_COMMIT ?? null,
        cases: evidence,
      }, null, 2)}\n`, "utf8");
    }
    await tempDb?.cleanup();
  });

  async function seed(maxReviewRounds = 3) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `M2C ${suffix}`, issuePrefix: `C${suffix}` })
      .returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "M2C quality" })
      .returning().then((rows) => rows[0]);
    const makeAgent = async (name: string) => db.insert(agents).values({
      companyId: company.id,
      name,
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", `console.log('${name} quality run'); process.exit(0)`] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    const developer = await makeAgent("Developer");
    const qa = await makeAgent("QA");
    const po = await makeAgent("PO");
    return {
      company,
      project,
      developer,
      qa,
      po,
      records: workRecordService(db),
      packages: workPackageDispatchService(db, { writesEnabled: true }),
      quality: workRecordQualityService(db, { writesEnabled: true, maxReviewRounds }),
    };
  }

  async function createRecord(
    context: Awaited<ReturnType<typeof seed>>,
    input: {
      title: string;
      kind?: "plan" | "defect";
      assigneeAgentId: string | null;
      qaAssigneeAgentId?: string | null;
      parentRecordId?: string | null;
    },
  ) {
    return context.records.create(context.company.id, {
      projectId: context.project.id,
      kind: input.kind ?? "plan",
      title: input.title,
      assigneeAgentId: input.assigneeAgentId,
      qaAssigneeAgentId: input.qaAssigneeAgentId,
      parentRecordId: input.parentRecordId,
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "m2c-test" });
  }

  async function prepare(
    context: Awaited<ReturnType<typeof seed>>,
    input: Omit<PreviewWorkPackageDispatch, "workflowVersion" | "projectId">,
    clientRequestId: string,
  ) {
    const scope: PreviewWorkPackageDispatch = {
      workflowVersion: 2,
      projectId: context.project.id,
      ...input,
    };
    const preview = await context.packages.preview(context.company.id, context.project.id, scope);
    return context.packages.prepare(context.company.id, context.project.id, {
      ...scope,
      clientRequestId,
      requestPayloadDigest: `digest:${clientRequestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    }, { actorType: "system", actorId: "m2c-test" });
  }

  async function primaryIssue(companyId: string, recordId: string) {
    return db.select({ link: workRecordIssueLinks, issue: issues })
      .from(workRecordIssueLinks)
      .innerJoin(issues, eq(issues.id, workRecordIssueLinks.issueId))
      .where(and(
        eq(workRecordIssueLinks.companyId, companyId),
        eq(workRecordIssueLinks.recordId, recordId),
        eq(workRecordIssueLinks.purpose, "primary"),
      )).then((rows) => rows[0]);
  }

  async function markIssueDone(issueId: string) {
    await db.update(issues).set({
      status: "done",
      statusVersion: sql`${issues.statusVersion} + 1`,
      updatedAt: new Date(),
    }).where(eq(issues.id, issueId));
  }

  async function completeIssueThroughService(issueId: string, agentId: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    const updated = await issueService(db).update(issueId, {
      companyGuard: issue.companyId,
      status: "done",
      actorAgentId: agentId,
    });
    expect(updated).toMatchObject({ id: issueId, status: "done" });
  }

  async function submitIndependentDefectForReview(issueId: string, developerAgentId: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    const transition = applyIssueExecutionPolicyTransition({
      issue,
      policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: developerAgentId, userId: null },
      allowBoardOverride: false,
      commentBody: "Repair complete; ready for QA",
    });
    await issueService(db).update(issueId, {
      companyGuard: issue.companyId,
      ...transition.patch,
      actorAgentId: developerAgentId,
    });
  }

  it("keeps a caller-owned PO verdict transaction atomic with run finalization", async () => {
    const context = await seed();
    const root = await createRecord(context, { title: "PO transaction package",
      assigneeAgentId: context.po.id });
    const child = await createRecord(context, { title: "PO transaction child",
      parentRecordId: root.id, assigneeAgentId: context.developer.id });
    const prepared = await prepare(context, {
      scopeKind: "whole_package", rootRecordId: root.id, selectedRecordIds: [],
    }, `po-external-tx-${randomUUID()}`);
    const childPrimary = await primaryIssue(context.company.id, child.id);
    await markIssueDone(childPrimary.issue.id);
    await context.packages.reconcile(context.company.id, context.project.id,
      prepared.batch.id, { actorType: "system", actorId: "m2c-test" });
    const waiting = await context.quality.get(context.company.id, context.project.id, root.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id,
      waiting.cycle!.id);
    const ready = await context.quality.get(context.company.id, context.project.id, root.id);
    const poItem = ready.items.find((item) => item.role === "po")!;
    const request = { workflowVersion: 2 as const, clientRequestId: randomUUID(),
      requestPayloadDigest: randomUUID(), cycleId: ready.cycle!.id,
      itemId: poItem.id, expectedCycleRevision: ready.cycle!.revision,
      outcome: "approve" as const, targetRecordIds: [],
      reason: "All child work accepted", evidenceRefs: [] };
    const actor = { actorType: "agent" as const, actorId: context.po.id,
      agentId: context.po.id };
    await expect(db.transaction(async (tx) => {
      await context.quality.commitPoVerdictInTransaction(tx,
        context.company.id, context.project.id, root.id, request, actor);
      throw new Error("simulated run finish failure");
    })).rejects.toThrow("simulated run finish failure");
    expect(await db.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, context.company.id),
      eq(workRecordQualityVerdicts.clientRequestId, request.clientRequestId),
    ))).toHaveLength(0);
    expect((await context.quality.get(context.company.id, context.project.id, root.id))
      .cycle?.state).toBe("open");
    expect((await primaryIssue(context.company.id, root.id)).issue.status).not.toBe("done");
    await context.quality.recordPoVerdict(context.company.id,
      context.project.id, root.id, request, actor);
    expect((await primaryIssue(context.company.id, root.id)).issue.status).toBe("done");
  }, 30_000);

  it("C07-C11 reuses original package tasks, deduplicates PO return, and gates PO on per-defect QA", async () => {
    const context = await seed();
    const root = await createRecord(context, { title: "Package", assigneeAgentId: context.po.id });
    const repair = await createRecord(context, {
      title: "Original repair",
      assigneeAgentId: context.developer.id,
      parentRecordId: root.id,
    });
    const qaRecord = await createRecord(context, {
      title: "Original QA",
      assigneeAgentId: context.qa.id,
      parentRecordId: root.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }, "package-quality");
    const repairPrimary = await primaryIssue(context.company.id, repair.id);
    const qaPrimary = await primaryIssue(context.company.id, qaRecord.id);
    const rootPrimary = await primaryIssue(context.company.id, root.id);
    await db.update(issues).set({ responsibleUserId: "m2c-quality-owner" }).where(inArray(
      issues.id,
      [rootPrimary.issue.id, repairPrimary.issue.id, qaPrimary.issue.id],
    ));
    await markIssueDone(repairPrimary.issue.id);
    await markIssueDone(qaPrimary.issue.id);
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    const initialCycle = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, root.id),
      eq(workRecordQualityCycles.state, "open"),
    )).then((rows) => rows[0]);
    await context.quality.reconcileCycle(context.company.id, context.project.id, initialCycle.id);
    const ready = await context.quality.get(context.company.id, context.project.id, root.id);
    expect(ready.cycle).toMatchObject({ qualityPhase: "po_acceptance", state: "open" });
    expect(ready.history).toMatchObject({
      cycles: [expect.objectContaining({ id: ready.cycle!.id })],
      items: expect.arrayContaining([expect.objectContaining({ role: "po" })]),
      verdicts: [],
    });
    const rootProjection = (await context.records.list(context.company.id, context.project.id))
      .find((record) => record.id === root.id)!;
    expect(rootProjection.quality).toMatchObject({
      cycleId: ready.cycle!.id,
      cycleNumber: ready.cycle!.cycleNumber,
      phase: "po_acceptance",
      defectCount: 0,
    });
    expect(rootPrimary.issue.status).not.toBe("done");
    const poItem = ready.items.find((item) => item.role === "po")!;
    const poReturn = {
      workflowVersion: 2 as const,
      clientRequestId: "po-return-double-click",
      requestPayloadDigest: "po-return-double-click",
      cycleId: ready.cycle!.id,
      itemId: poItem.id,
      expectedCycleRevision: ready.cycle!.revision,
      outcome: "return" as const,
      targetRecordIds: [repair.id],
      reason: "Two defects require the original repair task",
      evidenceRefs: ["evidence://po/return"],
    };
    await expect(context.quality.recordPoVerdict(
      context.company.id,
      context.project.id,
      root.id,
      { ...poReturn, clientRequestId: "wrong-po", requestPayloadDigest: "wrong-po" },
      { actorType: "agent", actorId: context.developer.id, agentId: context.developer.id },
    )).rejects.toMatchObject({ status: 403 });
    const [firstReturn, replayReturn] = await Promise.all([
      context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, poReturn, {
        actorType: "agent", actorId: context.po.id, agentId: context.po.id,
      }),
      context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, poReturn, {
        actorType: "agent", actorId: context.po.id, agentId: context.po.id,
      }),
    ]);
    expect(new Set([firstReturn.verdict.id, replayReturn.verdict.id])).toHaveLength(1);
    expect(firstReturn.nextCycleId).toBe(replayReturn.nextCycleId);
    await expect(context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, {
      ...poReturn,
      clientRequestId: "late-po-verdict",
      requestPayloadDigest: "late-po-verdict",
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id }))
      .rejects.toMatchObject({ status: 409 });
    await expect(context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, {
      ...poReturn,
      requestPayloadDigest: "conflicting-payload",
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id }))
      .rejects.toMatchObject({ status: 409, details: { code: "work_record_workflow_idempotency_conflict" } });

    const defectA = await createRecord(context, { title: "Package defect A", kind: "defect", assigneeAgentId: null });
    const defectB = await createRecord(context, { title: "Package defect B", kind: "defect", assigneeAgentId: null });
    const unassignedDefect = await createRecord(context, { title: "Ownership needs PO", kind: "defect", assigneeAgentId: null });
    let quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const unassigned = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
      workflowVersion: 2,
      clientRequestId: "defect-link-unassigned",
      requestPayloadDigest: "defect-link-unassigned",
      cycleId: quality.cycle!.id,
      expectedCycleRevision: quality.cycle!.revision,
      defectRecordId: unassignedDefect.id,
      packageRecordId: root.id,
      repairRecordId: null,
      qaRecordId: qaRecord.id,
      reason: "Two candidate repair tasks; PO must decide",
      evidenceRefs: ["evidence://qa/unassigned"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    quality = unassigned.quality;
    expect(quality.cycle!.qualityPhase).toBe("attention_required");
    const intentsBeforePoDecision = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, repair.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ));
    const linkedByPo = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
      workflowVersion: 2,
      clientRequestId: "defect-link-po-decision",
      requestPayloadDigest: "defect-link-po-decision",
      cycleId: quality.cycle!.id,
      expectedCycleRevision: quality.cycle!.revision,
      defectRecordId: unassignedDefect.id,
      packageRecordId: root.id,
      repairRecordId: repair.id,
      qaRecordId: qaRecord.id,
      reason: "PO selected the original repair task",
      evidenceRefs: ["evidence://po/ownership"],
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id });
    quality = linkedByPo.quality;
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, repair.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ))).toHaveLength(intentsBeforePoDecision.length);
    for (const [index, defect] of [defectA, defectB].entries()) {
      const linked = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
        workflowVersion: 2,
        clientRequestId: `defect-link-${index}`,
        requestPayloadDigest: `defect-link-${index}`,
        cycleId: quality.cycle!.id,
        expectedCycleRevision: quality.cycle!.revision,
        defectRecordId: defect.id,
        packageRecordId: root.id,
        repairRecordId: repair.id,
        qaRecordId: qaRecord.id,
        reason: `QA evidence ${index}`,
        evidenceRefs: [`evidence://qa/${index}`],
      }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
      quality = linked.quality;
    }
    expect(await db.select().from(workRecordQualityLinks).where(and(
      eq(workRecordQualityLinks.companyId, context.company.id),
      eq(workRecordQualityLinks.packageRecordId, root.id),
    ))).toHaveLength(4);
    const reworkIntents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, repair.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ));
    expect(reworkIntents).toHaveLength(1);
    expect((await primaryIssue(context.company.id, repair.id)).issue.id).toBe(repairPrimary.issue.id);

    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    expect(await context.packages.processOutbox(heartbeat.wakeup, 25)).toBe(1);
    await heartbeat.drainActiveRunExecutions();
    const repairRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.developer.id),
    ));
    expect(repairRuns).toHaveLength(1);
    const repairOutbox = await db.select().from(workRecordOutbox).where(
      eq(workRecordOutbox.executionIntentId, reworkIntents[0].id),
    ).then((rows) => rows[0]);
    const repairWakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${reworkIntents[0].id}:${reworkIntents[0].generation}`),
    ));
    expect(repairOutbox).toMatchObject({ state: "delivered", lastError: null });
    expect(repairWakeups).toHaveLength(1);
    const repairProjection = (await context.records.list(context.company.id, context.project.id))
      .find((record) => record.id === repair.id)!;
    expect(repairProjection.delivery).toMatchObject({
      deliveryState: "delivered",
      wakeRequestId: repairWakeups[0].id,
      wakeStatus: expect.stringMatching(/^(queued|claimed|running|completed)$/),
      runId: repairWakeups[0].runId,
    });
    await completeIssueThroughService(repairPrimary.issue.id, context.developer.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const qaItem = quality.items.find((item) => item.role === "qa")!;
    expect(quality.cycle!.qualityPhase).toBe("qa_retest");
    expect(quality.history.cycles.map((cycle) => cycle.cycleNumber)).toEqual([2, 1]);
    expect(quality.history.verdicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ cycleId: ready.cycle!.id, outcome: "return" }),
    ]));
    expect((await db.select({
      id: workRecords.id,
      businessStatus: workRecords.businessStatus,
    }).from(workRecords).where(and(
      eq(workRecords.companyId, context.company.id),
      inArray(workRecords.id, [unassignedDefect.id, defectA.id, defectB.id]),
    ))).map((record) => record.businessStatus)).toEqual(["in_review", "in_review", "in_review"]);
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, qaRecord.id),
      eq(workRecordExecutionIntents.kind, "qa_retest_release"),
    ))).toHaveLength(1);
    const qaIntents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, qaRecord.id),
      eq(workRecordExecutionIntents.kind, "qa_retest_release"),
    ));
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    expect(await context.packages.processOutbox(heartbeat.wakeup, 25)).toBe(1);
    await heartbeat.drainActiveRunExecutions();
    const qaRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.qa.id),
    ));
    expect(qaRuns).toHaveLength(1);
    const qaOutbox = await db.select().from(workRecordOutbox).where(
      eq(workRecordOutbox.executionIntentId, qaIntents[0].id),
    ).then((rows) => rows[0]);
    const qaWakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${qaIntents[0].id}:${qaIntents[0].generation}`),
    ));
    expect(qaOutbox).toMatchObject({ state: "delivered", lastError: null });
    expect(qaWakeups).toHaveLength(1);
    await completeIssueThroughService(qaPrimary.issue.id, context.qa.id);
    for (const [index, defect] of [unassignedDefect, defectA, defectB].entries()) {
      await context.quality.recordQaVerdict(context.company.id, context.project.id, root.id, {
        workflowVersion: 2,
        clientRequestId: `qa-pass-${index}`,
        requestPayloadDigest: `qa-pass-${index}`,
        cycleId: quality.cycle!.id,
        itemId: qaItem.id,
        expectedCycleRevision: quality.cycle!.revision,
        outcome: "pass",
        defectRecordId: defect.id,
        repairRecordId: repair.id,
        reason: `Defect ${index} verified`,
        evidenceRefs: [`evidence://qa/pass/${index}`],
      }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    }
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    expect(quality.cycle!.qualityPhase).toBe("po_acceptance");
    expect(quality.verdicts.filter((verdict) => verdict.outcome === "pass")).toHaveLength(3);
    const finalPoItem = quality.items.find((item) => item.role === "po")!;
    const finalPoIntents = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.qualityItemId, finalPoItem.id),
      eq(workRecordExecutionIntents.kind, "po_acceptance_release"),
    ));
    expect(finalPoIntents).toHaveLength(1);
    expect((await db.select({ businessStatus: workRecords.businessStatus }).from(workRecords).where(
      eq(workRecords.id, root.id),
    ).then((rows) => rows[0])).businessStatus).toBe("in_review");
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    expect(await db.select().from(workRecordExecutionIntents).where(
      eq(workRecordExecutionIntents.id, finalPoIntents[0].id),
    ).then((rows) => rows[0])).toMatchObject({ state: "ready", waitingReason: null });
    const processedPoEvents = await context.packages.processOutbox(heartbeat.wakeup, 25);
    const poOutbox = await db.select().from(workRecordOutbox).where(
      eq(workRecordOutbox.executionIntentId, finalPoIntents[0].id),
    ).then((rows) => rows[0] ?? null);
    const poWakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, context.company.id),
      eq(agentWakeupRequests.idempotencyKey, `work-record-intent:${finalPoIntents[0].id}:${finalPoIntents[0].generation}`),
    ));
    expect({ processedPoEvents, poOutbox, poWakeups }).toMatchObject({
      processedPoEvents: 1,
      poOutbox: { state: "delivered", lastError: null },
      poWakeups: [{ status: expect.stringMatching(/^(queued|claimed|running|completed)$/) }],
    });
    await heartbeat.drainActiveRunExecutions();
    const poRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.po.id),
    ));
    expect(poRuns).toHaveLength(1);
    await context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, {
      workflowVersion: 2,
      clientRequestId: "po-final-approve",
      requestPayloadDigest: "po-final-approve",
      cycleId: quality.cycle!.id,
      itemId: finalPoItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "approve",
      targetRecordIds: [],
      reason: "Both defects passed QA",
      evidenceRefs: ["evidence://po/approve"],
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id });
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      inArray(workRecordIssueLinks.recordId, [root.id, repair.id, qaRecord.id]),
      eq(workRecordIssueLinks.purpose, "primary"),
    ))).toHaveLength(3);
    expect(await db.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, context.company.id),
      eq(workRecordQualityVerdicts.clientRequestId, "po-return-double-click"),
    ))).toHaveLength(1);
    evidence.push({
      case: "C07-C11-package-quality",
      recordIds: { root: root.id, repair: repair.id, qa: qaRecord.id, defects: [unassignedDefect.id, defectA.id, defectB.id] },
      issueIds: { root: rootPrimary.issue.id, repair: repairPrimary.issue.id, qa: qaPrimary.issue.id },
      poReturnVerdictId: firstReturn.verdict.id,
      reworkCycleId: firstReturn.nextCycleId,
      repairChain: {
        intentId: reworkIntents[0].id,
        outboxId: repairOutbox.id,
        wakeupRequestId: repairWakeups[0].id,
        runId: repairRuns[0].id,
      },
      qaChain: {
        intentId: qaIntents[0].id,
        outboxId: qaOutbox.id,
        wakeupRequestId: qaWakeups[0].id,
        runId: qaRuns[0].id,
      },
      poChain: {
        intentId: finalPoIntents[0].id,
        outboxId: poOutbox!.id,
        wakeupRequestId: poWakeups[0].id,
        runId: poRuns[0].id,
      },
    });
  }, 30_000);

  it("routes unknown package-defect ownership to the package PO before creating repair work", async () => {
    const context = await seed();
    const root = await createRecord(context, { title: "Ownership package", assigneeAgentId: context.po.id });
    const repair = await createRecord(context, {
      title: "Ownership repair",
      assigneeAgentId: context.developer.id,
      parentRecordId: root.id,
    });
    const qaRecord = await createRecord(context, {
      title: "Ownership QA",
      assigneeAgentId: context.qa.id,
      parentRecordId: root.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }, "package-ownership-adjudication");
    await markIssueDone((await primaryIssue(context.company.id, repair.id)).issue.id);
    await markIssueDone((await primaryIssue(context.company.id, qaRecord.id)).issue.id);
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    const initialCycle = await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, root.id),
      eq(workRecordQualityCycles.state, "open"),
    )).then((rows) => rows[0]);
    await context.quality.reconcileCycle(context.company.id, context.project.id, initialCycle.id);
    const defect = await createRecord(context, {
      title: "Ownership unclear",
      kind: "defect",
      assigneeAgentId: null,
    });
    let quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const reported = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
      workflowVersion: 2,
      clientRequestId: "ownership-unassigned",
      requestPayloadDigest: "ownership-unassigned",
      cycleId: quality.cycle!.id,
      expectedCycleRevision: quality.cycle!.revision,
      defectRecordId: defect.id,
      packageRecordId: root.id,
      repairRecordId: null,
      qaRecordId: qaRecord.id,
      reason: "QA cannot identify the owning repair task",
      evidenceRefs: ["evidence://qa/ownership-unclear"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    quality = reported.quality;
    expect(quality.cycle).toMatchObject({
      qualityPhase: "attention_required",
      reason: "repair_ownership_requires_po",
    });
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);

    const adjudication = {
      workflowVersion: 2 as const,
      cycleId: quality.cycle!.id,
      expectedCycleRevision: quality.cycle!.revision,
      defectRecordId: defect.id,
      packageRecordId: root.id,
      repairRecordId: repair.id,
      qaRecordId: qaRecord.id,
      reason: "Select the original repair task",
      evidenceRefs: ["evidence://po/ownership-adjudication"],
    };
    await expect(context.quality.linkPackageDefect(context.company.id, context.project.id, {
      ...adjudication,
      clientRequestId: "ownership-qa-denied",
      requestPayloadDigest: "ownership-qa-denied",
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id })).rejects.toMatchObject({ status: 403 });
    await expect(context.quality.linkPackageDefect(context.company.id, context.project.id, {
      ...adjudication,
      clientRequestId: "ownership-developer-denied",
      requestPayloadDigest: "ownership-developer-denied",
    }, { actorType: "agent", actorId: context.developer.id, agentId: context.developer.id })).rejects.toMatchObject({ status: 403 });
    const decided = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
      ...adjudication,
      clientRequestId: "ownership-po-decided",
      requestPayloadDigest: "ownership-po-decided",
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id });
    expect(decided.quality.cycle).toMatchObject({ qualityPhase: "waiting_fix" });
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
      eq(workRecordExecutionIntents.recordId, repair.id),
    ))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id))).toHaveLength(0);
  }, 30_000);

  it("rejects a package defect verdict submitted through another QA task's item", async () => {
    const context = await seed();
    const qaTwo = await db.insert(agents).values({
      companyId: context.company.id,
      name: "QA Two",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
    }).returning().then((rows) => rows[0]);
    const root = await createRecord(context, { title: "Two-QA package", assigneeAgentId: context.po.id });
    const repair = await createRecord(context, {
      title: "Two-QA repair",
      assigneeAgentId: context.developer.id,
      parentRecordId: root.id,
    });
    const qaOneRecord = await createRecord(context, {
      title: "QA one task",
      assigneeAgentId: context.qa.id,
      parentRecordId: root.id,
    });
    const qaTwoRecord = await createRecord(context, {
      title: "QA two task",
      assigneeAgentId: qaTwo.id,
      parentRecordId: root.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }, "package-two-qa-items");
    for (const recordId of [repair.id, qaOneRecord.id, qaTwoRecord.id]) {
      await markIssueDone((await primaryIssue(context.company.id, recordId)).issue.id);
    }
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    let quality = await context.quality.get(context.company.id, context.project.id, root.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const initialPoItem = quality.items.find((item) => item.role === "po")!;
    await context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, {
      workflowVersion: 2,
      clientRequestId: "two-qa-po-return",
      requestPayloadDigest: "two-qa-po-return",
      cycleId: quality.cycle!.id,
      itemId: initialPoItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      targetRecordIds: [repair.id],
      reason: "Repair defects found by two QA owners",
      evidenceRefs: ["evidence://po/two-qa-return"],
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id });
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const defectOne = await createRecord(context, { title: "QA one defect", kind: "defect", assigneeAgentId: null });
    const defectTwo = await createRecord(context, { title: "QA two defect", kind: "defect", assigneeAgentId: null });
    for (const [index, assignment] of [
      { defect: defectOne, qaRecord: qaOneRecord, qaAgentId: context.qa.id },
      { defect: defectTwo, qaRecord: qaTwoRecord, qaAgentId: qaTwo.id },
    ].entries()) {
      const linked = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
        workflowVersion: 2,
        clientRequestId: `two-qa-link-${index}`,
        requestPayloadDigest: `two-qa-link-${index}`,
        cycleId: quality.cycle!.id,
        expectedCycleRevision: quality.cycle!.revision,
        defectRecordId: assignment.defect.id,
        packageRecordId: root.id,
        repairRecordId: repair.id,
        qaRecordId: assignment.qaRecord.id,
        reason: `QA ${index + 1} linked its own defect`,
        evidenceRefs: [`evidence://qa/${index + 1}`],
      }, { actorType: "agent", actorId: assignment.qaAgentId, agentId: assignment.qaAgentId });
      quality = linked.quality;
    }
    await markIssueDone((await primaryIssue(context.company.id, repair.id)).issue.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const qaOneItem = quality.items.find((item) => item.role === "qa" && item.recordId === qaOneRecord.id)!;
    await expect(context.quality.recordQaVerdict(context.company.id, context.project.id, root.id, {
      workflowVersion: 2,
      clientRequestId: "two-qa-cross-item",
      requestPayloadDigest: "two-qa-cross-item",
      cycleId: quality.cycle!.id,
      itemId: qaOneItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "pass",
      defectRecordId: defectTwo.id,
      repairRecordId: repair.id,
      reason: "Must not accept QA two's defect through QA one's item",
      evidenceRefs: ["evidence://qa/cross-item"],
    }, { actorType: "agent", actorId: qaTwo.id, agentId: qaTwo.id })).rejects.toMatchObject({
      status: 422,
      details: { code: "work_record_quality_target_invalid" },
    });
    expect(await db.select().from(workRecordQualityVerdicts).where(and(
      eq(workRecordQualityVerdicts.companyId, context.company.id),
      eq(workRecordQualityVerdicts.clientRequestId, "two-qa-cross-item"),
    ))).toHaveLength(0);
  }, 30_000);

  it("stops package QA returns at the configured round limit without creating another repair run", async () => {
    const context = await seed(2);
    const root = await createRecord(context, { title: "Bounded package", assigneeAgentId: context.po.id });
    const repair = await createRecord(context, {
      title: "Bounded package repair",
      assigneeAgentId: context.developer.id,
      parentRecordId: root.id,
    });
    const qaRecord = await createRecord(context, {
      title: "Bounded package QA",
      assigneeAgentId: context.qa.id,
      parentRecordId: root.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "whole_package",
      rootRecordId: root.id,
      selectedRecordIds: [],
    }, "package-review-limit");
    await markIssueDone((await primaryIssue(context.company.id, repair.id)).issue.id);
    await markIssueDone((await primaryIssue(context.company.id, qaRecord.id)).issue.id);
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    let quality = await context.quality.get(context.company.id, context.project.id, root.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const initialPoItem = quality.items.find((item) => item.role === "po")!;
    await context.quality.recordPoVerdict(context.company.id, context.project.id, root.id, {
      workflowVersion: 2,
      clientRequestId: "package-limit-po-return",
      requestPayloadDigest: "package-limit-po-return",
      cycleId: quality.cycle!.id,
      itemId: initialPoItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      targetRecordIds: [repair.id],
      reason: "Open the final permitted review round",
      evidenceRefs: ["evidence://po/package-limit"],
    }, { actorType: "agent", actorId: context.po.id, agentId: context.po.id });
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    expect(quality.cycle!.cycleNumber).toBe(2);
    const defect = await createRecord(context, { title: "Bounded package defect", kind: "defect", assigneeAgentId: null });
    const linked = await context.quality.linkPackageDefect(context.company.id, context.project.id, {
      workflowVersion: 2,
      clientRequestId: "package-limit-defect-link",
      requestPayloadDigest: "package-limit-defect-link",
      cycleId: quality.cycle!.id,
      expectedCycleRevision: quality.cycle!.revision,
      defectRecordId: defect.id,
      packageRecordId: root.id,
      repairRecordId: repair.id,
      qaRecordId: qaRecord.id,
      reason: "Final permitted package review",
      evidenceRefs: ["evidence://qa/package-limit"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    quality = linked.quality;
    await markIssueDone((await primaryIssue(context.company.id, repair.id)).issue.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const qaItem = quality.items.find((item) => item.role === "qa" && item.recordId === qaRecord.id)!;
    const intentCountBefore = await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ));
    const runCountBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id));
    const result = await context.quality.recordQaVerdict(context.company.id, context.project.id, root.id, {
      workflowVersion: 2,
      clientRequestId: "package-limit-qa-return",
      requestPayloadDigest: "package-limit-qa-return",
      cycleId: quality.cycle!.id,
      itemId: qaItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      defectRecordId: defect.id,
      repairRecordId: repair.id,
      reason: "Review ceiling reached with defect still open",
      evidenceRefs: ["evidence://qa/package-limit-return"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    expect(result.escalated).toBe(true);
    expect(result.quality.cycle).toMatchObject({
      id: quality.cycle!.id,
      state: "open",
      qualityPhase: "attention_required",
      reason: "review_round_limit_reached",
    });
    expect(await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, root.id),
    ))).toHaveLength(2);
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ))).toHaveLength(intentCountBefore.length);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, context.company.id)))
      .toHaveLength(runCountBefore.length);
    evidence.push({
      case: "C23-package-review-round-limit",
      recordIds: { root: root.id, repair: repair.id, qa: qaRecord.id, defect: defect.id },
      cycleId: quality.cycle!.id,
      outcome: "attention_required",
      newRepairIntentCount: 0,
      newRunCount: 0,
    });
  }, 30_000);

  it("stops independent-defect review returns at the configured round limit", async () => {
    const context = await seed(1);
    const defect = await createRecord(context, {
      title: "Bounded independent defect",
      kind: "defect",
      assigneeAgentId: context.developer.id,
      qaAssigneeAgentId: context.qa.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [defect.id],
    }, "independent-defect-review-limit");
    const primary = await primaryIssue(context.company.id, defect.id);
    await db.update(issues).set({ responsibleUserId: "m2c-review-owner" }).where(eq(issues.id, primary.issue.id));
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await context.packages.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    await submitIndependentDefectForReview(primary.issue.id, context.developer.id);
    await context.quality.reconcileAll(25);
    const quality = await context.quality.get(context.company.id, context.project.id, defect.id);
    const qaItem = quality.items.find((item) => item.role === "qa")!;
    const result = await context.quality.recordQaVerdict(context.company.id, context.project.id, defect.id, {
      workflowVersion: 2,
      clientRequestId: "qa-return-review-limit",
      requestPayloadDigest: "qa-return-review-limit",
      cycleId: quality.cycle!.id,
      itemId: qaItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      defectRecordId: defect.id,
      repairRecordId: defect.id,
      reason: "Maximum review round reached",
      evidenceRefs: ["evidence://independent/review-limit"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    expect(result.escalated).toBe(true);
    expect(result.quality.cycle).toMatchObject({
      id: quality.cycle!.id,
      state: "open",
      qualityPhase: "attention_required",
      reason: "review_round_limit_reached",
    });
    expect(await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, defect.id),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, defect.id),
      eq(workRecordExecutionIntents.kind, "rework_release"),
    ))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, primary.issue.id)).then((rows) => rows[0])).status)
      .toBe("in_review");
    evidence.push({
      case: "C23-review-round-limit",
      batchId: prepared.batch.id,
      recordId: defect.id,
      issueId: primary.issue.id,
      cycleId: quality.cycle!.id,
      outcome: "attention_required",
    });
  }, 30_000);

  it("C23 keeps one independent defect/issue across real repair runs and enforces QA, pause, and budget gates", async () => {
    const context = await seed();
    const missingQa = await createRecord(context, {
      title: "Missing QA",
      kind: "defect",
      assigneeAgentId: context.developer.id,
    });
    const missingQaPreview = await context.packages.preview(context.company.id, context.project.id, {
      workflowVersion: 2,
      projectId: context.project.id,
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [missingQa.id],
    });
    expect(missingQaPreview.eligibility).toMatchObject({
      canPrepare: false,
      blockers: [{
        code: "missing_qa",
        recordId: missingQa.id,
        requiredRole: "QA",
      }],
    });

    const defect = await createRecord(context, {
      title: "Independent defect",
      kind: "defect",
      assigneeAgentId: context.developer.id,
      qaAssigneeAgentId: context.qa.id,
    });
    const prepared = await prepare(context, {
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [defect.id],
    }, "independent-defect");
    const primary = await primaryIssue(context.company.id, defect.id);
    await db.update(issues).set({ responsibleUserId: "m2c-review-owner" }).where(eq(issues.id, primary.issue.id));
    const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await context.packages.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    await submitIndependentDefectForReview(primary.issue.id, context.developer.id);
    await context.quality.reconcileAll(25);
    let currentIssue = await db.select().from(issues).where(eq(issues.id, primary.issue.id)).then((rows) => rows[0]);
    expect(currentIssue.status).toBe("in_review");
    let quality = await context.quality.get(context.company.id, context.project.id, defect.id);
    const firstQaItem = quality.items.find((item) => item.role === "qa")!;
    await expect(context.quality.recordQaVerdict(context.company.id, context.project.id, defect.id, {
      workflowVersion: 2,
      clientRequestId: "qa-role-denied",
      requestPayloadDigest: "qa-role-denied",
      cycleId: quality.cycle!.id,
      itemId: firstQaItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      defectRecordId: defect.id,
      repairRecordId: defect.id,
      reason: "Wrong actor",
      evidenceRefs: [],
    }, { actorType: "agent", actorId: context.developer.id, agentId: context.developer.id })).rejects.toMatchObject({ status: 403 });
    await context.quality.recordQaVerdict(context.company.id, context.project.id, defect.id, {
      workflowVersion: 2,
      clientRequestId: "qa-return-independent",
      requestPayloadDigest: "qa-return-independent",
      cycleId: quality.cycle!.id,
      itemId: firstQaItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "return",
      defectRecordId: defect.id,
      repairRecordId: defect.id,
      reason: "Regression remains",
      evidenceRefs: ["evidence://independent/return"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    quality = await context.quality.get(context.company.id, context.project.id, defect.id);
    const secondCycleId = quality.cycle!.id;
    await db.update(agents).set({ status: "paused", pauseReason: "m2c-test", pausedAt: new Date() })
      .where(eq(agents.id, context.developer.id));
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    let runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.developer.id),
    ));
    expect(runs).toHaveLength(1);
    await db.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null })
      .where(eq(agents.id, context.developer.id));
    const budget = await db.insert(budgetPolicies).values({
      companyId: context.company.id,
      scopeType: "project",
      scopeId: context.project.id,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      hardStopEnabled: true,
      isActive: true,
    }).returning().then((rows) => rows[0]);
    await db.insert(costEvents).values({
      companyId: context.company.id,
      agentId: context.developer.id,
      issueId: primary.issue.id,
      projectId: context.project.id,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "m2c-quality",
      costCents: 125,
      occurredAt: new Date(),
    });
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    await context.packages.processOutbox(heartbeat.wakeup, 25);
    runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.developer.id),
    ));
    expect(runs).toHaveLength(1);
    await db.update(budgetPolicies).set({ isActive: false }).where(eq(budgetPolicies.id, budget.id));
    await context.packages.reconcile(context.company.id, context.project.id, prepared.batch.id, {
      actorType: "system",
      actorId: "m2c-test",
    });
    await context.packages.processOutbox(heartbeat.wakeup, 25);
    await heartbeat.drainActiveRunExecutions();
    await submitIndependentDefectForReview(primary.issue.id, context.developer.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, secondCycleId);
    runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, context.company.id),
      eq(heartbeatRuns.agentId, context.developer.id),
    )).orderBy(heartbeatRuns.createdAt);
    expect(runs).toHaveLength(2);
    currentIssue = await db.select().from(issues).where(eq(issues.id, primary.issue.id)).then((rows) => rows[0]);
    expect(currentIssue.status).toBe("in_review");
    quality = await context.quality.get(context.company.id, context.project.id, defect.id);
    const secondQaItem = quality.items.find((item) => item.role === "qa")!;
    await context.quality.recordQaVerdict(context.company.id, context.project.id, defect.id, {
      workflowVersion: 2,
      clientRequestId: "qa-pass-independent",
      requestPayloadDigest: "qa-pass-independent",
      cycleId: quality.cycle!.id,
      itemId: secondQaItem.id,
      expectedCycleRevision: quality.cycle!.revision,
      outcome: "pass",
      defectRecordId: defect.id,
      repairRecordId: defect.id,
      reason: "Regression verified",
      evidenceRefs: ["evidence://independent/pass"],
    }, { actorType: "agent", actorId: context.qa.id, agentId: context.qa.id });
    currentIssue = await db.select().from(issues).where(eq(issues.id, primary.issue.id)).then((rows) => rows[0]);
    expect(currentIssue.status).toBe("done");
    expect(await db.select().from(workRecordIssueLinks).where(and(
      eq(workRecordIssueLinks.companyId, context.company.id),
      eq(workRecordIssueLinks.recordId, defect.id),
      eq(workRecordIssueLinks.purpose, "primary"),
    ))).toHaveLength(1);
    expect(await db.select().from(workRecordQualityCycles).where(and(
      eq(workRecordQualityCycles.companyId, context.company.id),
      eq(workRecordQualityCycles.aggregateRecordId, defect.id),
    ))).toHaveLength(2);
    evidence.push({
      case: "C23-independent-defect",
      recordId: defect.id,
      issueId: primary.issue.id,
      cycleIds: (await db.select({ id: workRecordQualityCycles.id }).from(workRecordQualityCycles).where(and(
        eq(workRecordQualityCycles.companyId, context.company.id),
        eq(workRecordQualityCycles.aggregateRecordId, defect.id),
      ))).map((cycle) => cycle.id),
      runIds: runs.map((run) => run.id),
      gates: ["agent_paused", "budget_hard_stop"],
    });
  }, 60_000);
});
