import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  projects,
  workRecordAssignmentCommands,
  workRecordExecutionIntents,
  workRecordOutbox,
  workRecords,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("M2 A02 work-record assignment command", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let evidence: Record<string, unknown> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-assignment-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    const evidenceDir = process.env.PAPERCLIP_M2C_EVIDENCE_DIR;
    if (evidenceDir && evidence) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(
        join(evidenceDir, "assignment-command-evidence.json"),
        `${JSON.stringify({
          testedCommit: process.env.PAPERCLIP_M2C_TESTED_COMMIT ?? null,
          generatedAt: new Date().toISOString(),
          ...evidence,
        }, null, 2)}\n`,
        "utf8",
      );
    }
    await tempDb?.cleanup();
  });

  it("allows CEO NULL-to-agent, requires exact approval for replacement, and rejects role/stale/PATCH bypass without dispatch", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({
      name: `M2 A02 ${suffix}`,
      issuePrefix: `A${suffix}`,
    }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: "Assignment governance",
    }).returning().then((rows) => rows[0]);
    const makeAgent = async (name: string, role: string) => db.insert(agents).values({
      companyId: company.id,
      name,
      role,
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    }).returning().then((rows) => rows[0]);
    const ceo = await makeAgent("CEO", "ceo");
    const po = await makeAgent("PO", "po");
    const qa = await makeAgent("QA", "qa");
    const developer = await makeAgent("Developer", "engineer");
    const replacement = await makeAgent("Replacement", "engineer");
    const records = workRecordService(db, { writesEnabled: true });
    const createRecord = (title: string, assigneeAgentId: string | null) => records.create(company.id, {
      projectId: project.id,
      kind: "plan",
      title,
      assigneeAgentId,
      predecessorRecordIds: [],
    }, { actorType: "system", actorId: "m2-a02-test" });

    const gap = await createRecord("Unassigned", null);
    const gapInput = {
      workflowVersion: 2 as const,
      clientRequestId: "ceo-fill-gap",
      requestPayloadDigest: "ceo-fill-gap-digest",
      recordId: gap.id,
      assigneeAgentId: developer.id,
      expectedRecordRevision: gap.revision,
      expectedAssigneeAgentId: null,
      approvalId: null,
    };
    const filled = await records.fillAssignmentGap(company.id, project.id, gap.id, gapInput, {
      actorType: "agent",
      actorId: ceo.id,
      agentId: ceo.id,
    });
    expect(filled).toMatchObject({
      replayed: false,
      record: { assigneeAgentId: developer.id, revision: gap.revision + 1 },
      command: { previousRevision: gap.revision, resultingRevision: gap.revision + 1 },
    });
    await expect(records.fillAssignmentGap(company.id, project.id, gap.id, gapInput, {
      actorType: "agent",
      actorId: ceo.id,
      agentId: ceo.id,
    })).resolves.toMatchObject({ replayed: true, command: { id: filled.command.id } });

    const poTarget = await createRecord("PO must not fill", null);
    await expect(records.fillAssignmentGap(company.id, project.id, poTarget.id, {
      ...gapInput,
      clientRequestId: "po-denied",
      requestPayloadDigest: "po-denied-digest",
      recordId: poTarget.id,
      expectedRecordRevision: poTarget.revision,
    }, { actorType: "agent", actorId: po.id, agentId: po.id })).rejects.toMatchObject({
      status: 403,
      details: { code: "work_record_assignment_role_denied" },
    });

    const qaTarget = await createRecord("QA must not fill", null);
    await expect(records.fillAssignmentGap(company.id, project.id, qaTarget.id, {
      ...gapInput,
      clientRequestId: "qa-denied",
      requestPayloadDigest: "qa-denied-digest",
      recordId: qaTarget.id,
      expectedRecordRevision: qaTarget.revision,
    }, { actorType: "agent", actorId: qa.id, agentId: qa.id })).rejects.toMatchObject({
      status: 403,
      details: { code: "work_record_assignment_role_denied" },
    });

    const staleTarget = await createRecord("Stale CEO command", null);
    await expect(records.fillAssignmentGap(company.id, project.id, staleTarget.id, {
      ...gapInput,
      clientRequestId: "stale-denied",
      requestPayloadDigest: "stale-denied-digest",
      recordId: staleTarget.id,
      expectedRecordRevision: staleTarget.revision + 1,
    }, { actorType: "agent", actorId: ceo.id, agentId: ceo.id })).rejects.toMatchObject({
      status: 409,
      details: { code: "work_record_workflow_stale_revision" },
    });

    const assigned = await createRecord("Approved replacement", developer.id);
    const approval = await db.insert(approvals).values({
      companyId: company.id,
      type: "request_board_approval",
      status: "approved",
      requestedByAgentId: ceo.id,
      decidedByUserId: "jack",
      decidedAt: new Date(),
      payload: {
        action: "work_record.replace_assignee",
        companyId: company.id,
        projectId: project.id,
        recordId: assigned.id,
        recordRevision: assigned.revision,
        fromAssigneeAgentId: developer.id,
        toAssigneeAgentId: replacement.id,
      },
    }).returning().then((rows) => rows[0]);
    await expect(records.fillAssignmentGap(company.id, project.id, assigned.id, {
      workflowVersion: 2,
      clientRequestId: "approved-replacement",
      requestPayloadDigest: "approved-replacement-digest",
      recordId: assigned.id,
      assigneeAgentId: replacement.id,
      expectedRecordRevision: assigned.revision,
      expectedAssigneeAgentId: developer.id,
      approvalId: approval.id,
    }, { actorType: "agent", actorId: ceo.id, agentId: ceo.id })).resolves.toMatchObject({
      record: { assigneeAgentId: replacement.id, revision: assigned.revision + 1 },
      command: { approvalId: approval.id },
    });

    const patchTarget = await createRecord("No generic PATCH bypass", null);
    await expect(records.update(company.id, project.id, patchTarget.id, {
      expectedRevision: patchTarget.revision,
      assigneeAgentId: developer.id,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "work_record_assignment_command_required" },
    });

    const assignmentCommands = await db.select().from(workRecordAssignmentCommands).where(eq(
      workRecordAssignmentCommands.companyId,
      company.id,
    ));
    const intents = await db.select().from(workRecordExecutionIntents).where(eq(
      workRecordExecutionIntents.companyId,
      company.id,
    ));
    const outbox = await db.select().from(workRecordOutbox).where(eq(
      workRecordOutbox.companyId,
      company.id,
    ));
    const runs = await db.select().from(heartbeatRuns).where(eq(
      heartbeatRuns.companyId,
      company.id,
    ));
    expect(assignmentCommands).toHaveLength(2);
    expect(intents).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(await db.select().from(workRecords).where(eq(workRecords.id, poTarget.id)).then((rows) => rows[0])).toMatchObject({
      assigneeAgentId: null,
      revision: poTarget.revision,
    });
    expect(await db.select().from(workRecords).where(eq(workRecords.id, qaTarget.id)).then((rows) => rows[0])).toMatchObject({
      assigneeAgentId: null,
      revision: qaTarget.revision,
    });
    evidence = {
      scenario: "A02",
      companyId: company.id,
      projectId: project.id,
      nullToAgent: {
        recordId: gap.id,
        commandId: filled.command.id,
        previousRevision: filled.command.previousRevision,
        resultingRevision: filled.command.resultingRevision,
        replayedCommandId: filled.command.id,
      },
      approvedReplacement: {
        recordId: assigned.id,
        approvalId: approval.id,
        previousRevision: assigned.revision,
        resultingRevision: assigned.revision + 1,
      },
      denied: {
        po: { status: 403, code: "work_record_assignment_role_denied" },
        qa: { status: 403, code: "work_record_assignment_role_denied" },
        staleRevision: { status: 409, code: "work_record_workflow_stale_revision" },
        genericPatch: { status: 422, code: "work_record_assignment_command_required" },
      },
      effectiveCounts: {
        assignmentCommands: assignmentCommands.length,
        executionIntents: intents.length,
        outboxEvents: outbox.length,
        heartbeatRuns: runs.length,
      },
    };
  }, 30_000);
});
