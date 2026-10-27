import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
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

  async function seed() {
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
      quality: workRecordQualityService(db, { writesEnabled: true, maxReviewRounds: 3 }),
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
    }, { actorType: "user", actorId: "board-po", userId: "board-po" });
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

    await markIssueDone(repairPrimary.issue.id);
    await context.quality.reconcileCycle(context.company.id, context.project.id, quality.cycle!.id);
    quality = await context.quality.get(context.company.id, context.project.id, root.id);
    const qaItem = quality.items.find((item) => item.role === "qa")!;
    expect(quality.cycle!.qualityPhase).toBe("qa_retest");
    expect(await db.select().from(workRecordExecutionIntents).where(and(
      eq(workRecordExecutionIntents.companyId, context.company.id),
      eq(workRecordExecutionIntents.recordId, qaRecord.id),
      eq(workRecordExecutionIntents.kind, "qa_retest_release"),
    ))).toHaveLength(1);
    await markIssueDone(qaPrimary.issue.id);
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
      repairIntentIds: reworkIntents.map((intent) => intent.id),
    });
  }, 30_000);

  it("C23 keeps one independent defect/issue across real repair runs and enforces QA, pause, and budget gates", async () => {
    const context = await seed();
    const missingQa = await createRecord(context, {
      title: "Missing QA",
      kind: "defect",
      assigneeAgentId: context.developer.id,
    });
    await expect(context.packages.preview(context.company.id, context.project.id, {
      workflowVersion: 2,
      projectId: context.project.id,
      scopeKind: "selected_records",
      rootRecordId: null,
      selectedRecordIds: [missingQa.id],
    })).rejects.toMatchObject({ status: 422, details: { code: "work_record_quality_assignment_required" } });

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
