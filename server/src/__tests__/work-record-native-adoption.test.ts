import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  workRecordDependencies,
  workRecordExecutionProjections,
  workRecordIssueLinks,
  workRecordOutbox,
  workRecords,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("native issue work-record adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-work-record-adoption-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  it("projects visible manual issues idempotently without creating execution side effects", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `Adopt ${suffix}`, issuePrefix: `A${suffix}` }).returning().then((rows) => rows[0]);
    const project = await db.insert(projects).values({ companyId: company.id, name: "Alice" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({ companyId: company.id, name: "Alice", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning().then((rows) => rows[0]);
    const [parent, child, routine, hidden] = await db.insert(issues).values([
      {
        companyId: company.id,
        projectId: project.id,
        title: "Native parent",
        description: "Parent description",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agent.id,
        createdByAgentId: agent.id,
        originKind: "manual",
      },
      {
        companyId: company.id,
        projectId: project.id,
        title: "Native child",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agent.id,
        createdByUserId: "jack",
        originKind: "manual",
      },
      {
        companyId: company.id,
        projectId: project.id,
        title: "Routine execution",
        status: "todo",
        originKind: "routine_execution",
      },
      {
        companyId: company.id,
        projectId: project.id,
        title: "Hidden native issue",
        status: "todo",
        originKind: "manual",
        hiddenAt: new Date(),
      },
    ]).returning();
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, child.id));
    await db.insert(issueRelations).values({
      companyId: company.id,
      issueId: parent.id,
      relatedIssueId: child.id,
      type: "blocks",
      createdByAgentId: agent.id,
    });

    const issueCountBefore = (await db.select().from(issues)).length;
    const service = workRecordService(db);
    expect(await service.adoptNativeIssues(company.id, project.id)).toEqual({ adoptedCount: 2, existingCount: 0 });
    expect(await service.adoptNativeIssues(company.id, project.id)).toEqual({ adoptedCount: 0, existingCount: 2 });

    const records = await db.select().from(workRecords).where(eq(workRecords.projectId, project.id));
    const parentRecord = records.find((record) => record.title === parent.title);
    const childRecord = records.find((record) => record.title === child.title);
    expect(records).toHaveLength(2);
    expect(parentRecord).toMatchObject({
      businessStatus: "in_progress",
      priority: "high",
      assigneeAgentId: agent.id,
      dispatchState: "external",
      createdByAgentId: agent.id,
    });
    expect(childRecord).toMatchObject({
      businessStatus: "blocked",
      parentRecordId: parentRecord?.id,
      createdByUserId: "jack",
    });

    expect(await db.select().from(workRecordIssueLinks)).toHaveLength(2);
    expect(await db.select().from(workRecordExecutionProjections)).toHaveLength(2);
    expect(await db.select().from(workRecordDependencies)).toEqual([
      expect.objectContaining({
        predecessorRecordId: parentRecord?.id,
        successorRecordId: childRecord?.id,
      }),
    ]);
    expect((await db.select().from(issues)).length).toBe(issueCountBefore);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(workRecordOutbox)).toHaveLength(0);
    expect(await service.reconcilePage()).toMatchObject({ processed: 0, succeeded: 0, failures: [] });
    expect(await service.processOutbox(async () => { throw new Error("external records must never wake agents"); })).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(records.some((record) => record.title === routine.title || record.title === hidden.title)).toBe(false);

    await db.update(issues).set({
      title: "Native child renamed",
      status: "in_review",
      statusVersion: child.statusVersion + 1,
      updatedAt: new Date(),
    }).where(eq(issues.id, child.id));
    expect(await service.syncAdoptedNativeIssuesPage()).toMatchObject({ processed: 2, updatedCount: 1 });
    expect(await db.select().from(workRecords).where(eq(workRecords.id, childRecord!.id)).then((rows) => rows[0])).toMatchObject({
      title: "Native child renamed",
      businessStatus: "in_review",
      dispatchState: "external",
    });
    expect(await db.select().from(workRecordOutbox)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
