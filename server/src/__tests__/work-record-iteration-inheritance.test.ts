import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projectIterations,
  projectVersions,
  projects,
  workRecordDependencies,
  workRecords,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping work-record iteration inheritance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("work-record iteration inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let projectId: string;
  const actor = { actorType: "user" as const, actorId: "board", userId: "board" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-iteration-inheritance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workRecordDependencies);
    await db.delete(workRecords);
    await db.delete(projectIterations);
    await db.delete(projectVersions);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject() {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Iteration inheritance",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Iteration inheritance" });
    const service = workRecordService(db);
    const version = await service.createVersion(companyId, projectId, { name: "V1" });
    const iterationA = await service.createIteration(companyId, projectId, { versionId: version.id, name: "A" });
    const iterationB = await service.createIteration(companyId, projectId, { versionId: version.id, name: "B" });
    const iterationC = await service.createIteration(companyId, projectId, { versionId: version.id, name: "C" });
    return { service, iterationA, iterationB, iterationC };
  }

  it("defaults children to inheritance and cascades the effective iteration through the inherited subtree", async () => {
    const { service, iterationA, iterationB } = await seedProject();
    const parent = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "父任务",
      iterationAssignmentMode: "independent",
      iterationId: iterationA.id,
      predecessorRecordIds: [],
    }, actor);
    const child = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "子任务",
      parentRecordId: parent.id,
      predecessorRecordIds: [],
    }, actor);
    const grandchild = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "孙任务",
      parentRecordId: child.id,
      predecessorRecordIds: [],
    }, actor);

    expect(child).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationA.id });
    expect(grandchild).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationA.id });

    await service.update(companyId, projectId, parent.id, {
      expectedRevision: parent.revision,
      iterationId: iterationB.id,
    });
    const byId = new Map((await service.list(companyId, projectId)).map((record) => [record.id, record]));
    expect(byId.get(child.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationB.id });
    expect(byId.get(grandchild.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationB.id });
    expect(byId.get(child.id)?.revision).toBe(child.revision + 1);
    expect(byId.get(grandchild.id)?.revision).toBe(grandchild.revision + 1);
  });

  it("stops at an independent boundary and resumes inheritance when that boundary switches mode", async () => {
    const { service, iterationA, iterationB, iterationC } = await seedProject();
    const parent = await service.create(companyId, {
      projectId, kind: "plan", title: "父任务", iterationId: iterationA.id, predecessorRecordIds: [],
    }, actor);
    const independentChild = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "独立子任务",
      parentRecordId: parent.id,
      iterationAssignmentMode: "independent",
      iterationId: iterationB.id,
      predecessorRecordIds: [],
    }, actor);
    const inheritedGrandchild = await service.create(companyId, {
      projectId, kind: "plan", title: "继承孙任务", parentRecordId: independentChild.id, predecessorRecordIds: [],
    }, actor);

    await service.update(companyId, projectId, parent.id, {
      expectedRevision: parent.revision,
      iterationId: iterationC.id,
    });
    let byId = new Map((await service.list(companyId, projectId)).map((record) => [record.id, record]));
    expect(byId.get(independentChild.id)?.iterationId).toBe(iterationB.id);
    expect(byId.get(inheritedGrandchild.id)?.iterationId).toBe(iterationB.id);

    const currentChild = byId.get(independentChild.id)!;
    await service.update(companyId, projectId, independentChild.id, {
      expectedRevision: currentChild.revision,
      iterationAssignmentMode: "inherit_parent",
    });
    byId = new Map((await service.list(companyId, projectId)).map((record) => [record.id, record]));
    expect(byId.get(independentChild.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationC.id });
    expect(byId.get(inheritedGrandchild.id)).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationC.id });
  });

  it("adopts a new parent iteration, freezes it on detach, and rejects self, two-node, and multi-level cycles", async () => {
    const { service, iterationA, iterationB } = await seedProject();
    const firstParent = await service.create(companyId, {
      projectId, kind: "plan", title: "父任务 A", iterationId: iterationA.id, predecessorRecordIds: [],
    }, actor);
    const secondParent = await service.create(companyId, {
      projectId, kind: "plan", title: "父任务 B", iterationId: iterationB.id, predecessorRecordIds: [],
    }, actor);
    const child = await service.create(companyId, {
      projectId, kind: "plan", title: "子任务", parentRecordId: firstParent.id, predecessorRecordIds: [],
    }, actor);

    const moved = await service.update(companyId, projectId, child.id, {
      expectedRevision: child.revision,
      parentRecordId: secondParent.id,
    });
    expect(moved).toMatchObject({ iterationAssignmentMode: "inherit_parent", iterationId: iterationB.id });
    const detached = await service.update(companyId, projectId, child.id, {
      expectedRevision: moved.revision,
      parentRecordId: null,
    });
    expect(detached).toMatchObject({ parentRecordId: null, iterationAssignmentMode: "independent", iterationId: iterationB.id });

    await expect(service.update(companyId, projectId, firstParent.id, {
      expectedRevision: firstParent.revision,
      parentRecordId: firstParent.id,
    })).rejects.toMatchObject({ status: 422 });

    const secondUnderFirst = await service.update(companyId, projectId, secondParent.id, {
      expectedRevision: secondParent.revision,
      parentRecordId: firstParent.id,
    });
    await expect(service.update(companyId, projectId, firstParent.id, {
      expectedRevision: firstParent.revision,
      parentRecordId: secondUnderFirst.id,
    })).rejects.toMatchObject({ status: 422 });

    const third = await service.create(companyId, {
      projectId, kind: "plan", title: "第三层", parentRecordId: secondUnderFirst.id, predecessorRecordIds: [],
    }, actor);
    await expect(service.update(companyId, projectId, firstParent.id, {
      expectedRevision: firstParent.revision,
      parentRecordId: third.id,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("serializes conflicting parent moves and changes no execution or business fields while cascading", async () => {
    const { service, iterationA, iterationB } = await seedProject();
    const first = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "第一任务",
      iterationId: iterationA.id,
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      predecessorRecordIds: [],
    }, actor);
    const second = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "第二任务",
      iterationId: iterationB.id,
      plannedStartDate: "2026-11-13",
      plannedCompletionDate: "2026-11-14",
      predecessorRecordIds: [],
    }, actor);
    const dependent = await service.create(companyId, {
      projectId,
      kind: "plan",
      title: "继承子任务",
      parentRecordId: first.id,
      predecessorRecordIds: [second.id],
    }, actor);
    const before = await db.select().from(workRecords);
    const beforeNativeCounts = {
      issues: (await db.select().from(issues)).length,
      comments: (await db.select().from(issueComments)).length,
      runs: (await db.select().from(heartbeatRuns)).length,
      wakes: (await db.select().from(agentWakeupRequests)).length,
    };

    await service.update(companyId, projectId, first.id, {
      expectedRevision: first.revision,
      iterationId: iterationB.id,
    });
    const after = await db.select().from(workRecords);
    const beforeDependent = before.find((record) => record.id === dependent.id)!;
    const afterDependent = after.find((record) => record.id === dependent.id)!;
    expect(afterDependent).toMatchObject({
      iterationId: iterationB.id,
      businessStatus: beforeDependent.businessStatus,
      dispatchState: beforeDependent.dispatchState,
      assigneeAgentId: beforeDependent.assigneeAgentId,
      plannedStartDate: beforeDependent.plannedStartDate,
      plannedCompletionDate: beforeDependent.plannedCompletionDate,
    });
    expect(afterDependent.revision).toBe(beforeDependent.revision + 1);
    expect(await db.select().from(workRecordDependencies)).toHaveLength(1);
    expect({
      issues: (await db.select().from(issues)).length,
      comments: (await db.select().from(issueComments)).length,
      runs: (await db.select().from(heartbeatRuns)).length,
      wakes: (await db.select().from(agentWakeupRequests)).length,
    }).toEqual(beforeNativeCounts);

    const current = new Map((await service.list(companyId, projectId)).map((record) => [record.id, record]));
    const outcomes = await Promise.allSettled([
      service.update(companyId, projectId, first.id, {
        expectedRevision: current.get(first.id)!.revision,
        parentRecordId: second.id,
      }),
      service.update(companyId, projectId, second.id, {
        expectedRevision: current.get(second.id)!.revision,
        parentRecordId: first.id,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rows = await db.select({ id: workRecords.id, parentRecordId: workRecords.parentRecordId }).from(workRecords);
    const parentById = new Map(rows.map((row) => [row.id, row.parentRecordId]));
    for (const row of rows) {
      const seen = new Set<string>();
      let cursor: string | null = row.id;
      while (cursor) {
        expect(seen.has(cursor)).toBe(false);
        seen.add(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
    }
  });

  it("preserves both revisions when a parent cascade waits for a concurrent child edit", async () => {
    const { service, iterationA, iterationB } = await seedProject();
    const parent = await service.create(companyId, {
      projectId, kind: "plan", title: "父任务", iterationId: iterationA.id, predecessorRecordIds: [],
    }, actor);
    const child = await service.create(companyId, {
      projectId, kind: "plan", title: "子任务", parentRecordId: parent.id, predecessorRecordIds: [],
    }, actor);

    let signalChildLock!: () => void;
    let releaseChildLock!: () => void;
    const childLockAcquired = new Promise<void>((resolve) => { signalChildLock = resolve; });
    const releaseChild = new Promise<void>((resolve) => { releaseChildLock = resolve; });
    const concurrentChildEdit = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`work-record:${child.id}`}, 0))`);
      signalChildLock();
      await releaseChild;
      await tx.update(workRecords).set({
        title: "并发编辑后的子任务",
        revision: sql`${workRecords.revision} + 1`,
        updatedAt: new Date(),
      }).where(eq(workRecords.id, child.id));
    });

    await childLockAcquired;
    const cascade = service.update(companyId, projectId, parent.id, {
      expectedRevision: parent.revision,
      iterationId: iterationB.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseChildLock();
    await Promise.all([concurrentChildEdit, cascade]);

    const currentChild = await db.select().from(workRecords).where(eq(workRecords.id, child.id)).then((rows) => rows[0]);
    expect(currentChild).toMatchObject({
      title: "并发编辑后的子任务",
      iterationId: iterationB.id,
      revision: child.revision + 2,
    });
  });
});
