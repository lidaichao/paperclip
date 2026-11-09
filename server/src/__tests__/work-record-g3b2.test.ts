import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  heartbeatRuns,
  agentWakeupRequests,
  projects,
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
    `Skipping embedded Postgres G3B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("work-record G3B2 containers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-g3b2-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workRecords);
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
      name: "Alice",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "G3B2" });
    return workRecordService(db);
  }

  it("aggregates iteration progress from every plan record without counting defects as work", async () => {
    const service = await seedProject();
    const version = await service.createVersion(companyId, projectId, { name: "V1" });
    const iteration = await service.createIteration(companyId, projectId, {
      versionId: version.id,
      name: "I1",
    });
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    for (const [index, businessStatus] of ["done", "done", "cancelled", "todo", "in_progress"].entries()) {
      const record = await service.create(companyId, {
        projectId,
        iterationId: iteration.id,
        kind: "plan",
        title: `计划 ${index + 1}`,
        predecessorRecordIds: [],
      }, actor);
      if (businessStatus !== "backlog") {
        await service.update(companyId, projectId, record.id, {
          expectedRevision: record.revision,
          businessStatus: businessStatus as "done" | "cancelled" | "todo" | "in_progress",
        });
      }
    }
    await service.create(companyId, {
      projectId,
      iterationId: iteration.id,
      kind: "defect",
      title: "不计入进度的缺陷",
      predecessorRecordIds: [],
    }, actor);

    const [result] = await service.listIterations(companyId, projectId);

    expect(result).toMatchObject({
      id: iteration.id,
      versionId: version.id,
      progress: { completed: 2, total: 5, percent: 40 },
    });
    const page = await service.listPage(companyId, projectId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect((await service.listIterations(companyId, projectId))[0]?.progress).toEqual({
      completed: 2,
      total: 5,
      percent: 40,
    });
  });

  it("keeps stale revision conflicts recoverable and refuses to restore an iteration under an archived version", async () => {
    const service = await seedProject();
    const version = await service.createVersion(companyId, projectId, { name: "V1" });
    const iteration = await service.createIteration(companyId, projectId, {
      versionId: version.id,
      name: "I1",
    });

    await service.updateVersion(companyId, projectId, version.id, {
      expectedRevision: version.revision,
      name: "V1.1",
    });
    await expect(service.updateVersion(companyId, projectId, version.id, {
      expectedRevision: version.revision,
      name: "我的草稿",
    })).rejects.toMatchObject({ status: 409 });

    const archivedIteration = await service.archiveIteration(
      companyId,
      projectId,
      iteration.id,
      iteration.revision,
    );
    const currentVersion = (await service.listVersions(companyId, projectId))[0]!;
    await service.archiveVersion(companyId, projectId, version.id, currentVersion.revision);
    await expect(service.restoreIteration(
      companyId,
      projectId,
      iteration.id,
      archivedIteration.revision,
    )).rejects.toMatchObject({ status: 409 });
  });

  it("saves an incomplete defect as a record only and blocks explicit dispatch with every missing owner", async () => {
    const service = await seedProject();
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const defect = await service.create(companyId, {
      projectId,
      kind: "defect",
      title: "缺少修复人与 QA 的草稿",
      description: "复现、预期和实际结果都只保存在这一份说明中",
      defectSeverity: "high",
      predecessorRecordIds: [],
    }, actor);

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    await expect(service.dispatch(companyId, projectId, defect.id, {
      expectedRevision: defect.revision,
      clientRequestId: randomUUID(),
    }, actor)).rejects.toMatchObject({
      status: 422,
      details: {
        code: "work_record_dispatch_assignments_missing",
        missingFields: [
          { field: "assigneeAgentId", label: "修复人" },
          { field: "qaAssigneeAgentId", label: "QA" },
        ],
      },
    });
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("rewires one dependency without dropping siblings and rejects stale sets and cycles", async () => {
    const service = await seedProject();
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const create = (title: string, predecessorRecordIds: string[] = []) => service.create(companyId, {
      projectId, kind: "plan", title, predecessorRecordIds,
    }, actor);
    const a = await create("A");
    const c = await create("C");
    const d = await create("D");
    const b = await create("B", [a.id, c.id]);

    const rewired = await service.update(companyId, projectId, b.id, {
      expectedRevision: b.revision,
      dependencySetRevision: b.dependencySetRevision,
      predecessorRecordIds: [d.id, c.id],
    });
    expect(rewired.dependencies.map((edge) => edge.predecessorRecordId).sort()).toEqual([c.id, d.id].sort());
    await expect(service.update(companyId, projectId, b.id, {
      expectedRevision: rewired.revision,
      dependencySetRevision: b.dependencySetRevision,
      predecessorRecordIds: [a.id, c.id],
    })).rejects.toMatchObject({ status: 409, details: { code: "work_record_dependency_revision_changed" } });
    await expect(service.update(companyId, projectId, d.id, {
      expectedRevision: d.revision,
      dependencySetRevision: d.dependencySetRevision,
      predecessorRecordIds: [b.id],
    })).rejects.toMatchObject({ status: 422 });
  });

  it("retargets the dependency successor in one transaction and rejects stale two-sided revisions without partial writes", async () => {
    const service = await seedProject();
    const actor = { actorType: "user" as const, actorId: "board", userId: "board" };
    const create = (title: string, predecessorRecordIds: string[] = []) => service.create(companyId, {
      projectId, kind: "plan", title, predecessorRecordIds,
    }, actor);
    const a = await create("A"); const c = await create("C");
    const b = await create("B", [a.id, c.id]); const d = await create("D");

    const changed = await service.mutateDependency(companyId, projectId, {
      operation: "replace_target", predecessorRecordId: a.id, successorRecordId: b.id,
      replacementSuccessorRecordId: d.id,
      expectedRecords: [
        { recordId: b.id, expectedRevision: b.revision, expectedDependencySetRevision: b.dependencySetRevision },
        { recordId: d.id, expectedRevision: d.revision, expectedDependencySetRevision: d.dependencySetRevision },
      ],
    });
    const byId = new Map(changed.map((record) => [record.id, record]));
    expect(byId.get(b.id)?.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([c.id]);
    expect(byId.get(d.id)?.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([a.id]);

    await expect(service.mutateDependency(companyId, projectId, {
      operation: "replace_target", predecessorRecordId: c.id, successorRecordId: b.id,
      replacementSuccessorRecordId: d.id,
      expectedRecords: [
        { recordId: b.id, expectedRevision: b.revision, expectedDependencySetRevision: b.dependencySetRevision },
        { recordId: d.id, expectedRevision: d.revision, expectedDependencySetRevision: d.dependencySetRevision },
      ],
    })).rejects.toMatchObject({ status: 409 });
    const current = new Map((await service.list(companyId, projectId)).map((record) => [record.id, record]));
    expect(current.get(b.id)?.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([c.id]);
    expect(current.get(d.id)?.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([a.id]);
  });
});
