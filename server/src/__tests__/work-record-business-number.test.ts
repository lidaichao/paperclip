import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  projects,
  workRecords,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("FID-03 stable work-record business numbers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const actor = { actorType: "system" as const, actorId: "fid-03" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-business-number-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `FID ${suffix}`, issuePrefix: `F${suffix}` }).returning().then((rows) => rows[0]);
    const projectA = await db.insert(projects).values({ companyId: company.id, name: "Project A" }).returning().then((rows) => rows[0]);
    const projectB = await db.insert(projects).values({ companyId: company.id, name: "Project B" }).returning().then((rows) => rows[0]);
    const agent = await db.insert(agents).values({ companyId: company.id, name: "Rabbit", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning().then((rows) => rows[0]);
    return { company, projectA, projectB, agent, service: workRecordService(db) };
  }

  it("numbers plans and defects independently in each project without consuming native issue numbers", async () => {
    const context = await seed();
    const create = (projectId: string, kind: "plan" | "defect", title: string) => context.service.create(context.company.id, {
      projectId, kind, title, predecessorRecordIds: [],
    }, actor);

    const plan1 = await create(context.projectA.id, "plan", "Plan 1");
    const plan2 = await create(context.projectA.id, "plan", "Plan 2");
    const defect1 = await create(context.projectA.id, "defect", "Defect 1");
    const otherProjectPlan = await create(context.projectB.id, "plan", "Other plan");

    expect([plan1.recordIdentifier, plan2.recordIdentifier, defect1.recordIdentifier, otherProjectPlan.recordIdentifier])
      .toEqual(["PT-1", "PT-2", "PC-1", "PT-1"]);
    expect((await db.select({ issueCounter: companies.issueCounter }).from(companies).where(eq(companies.id, context.company.id)))[0]?.issueCounter).toBe(0);
  });

  it("allocates unique consecutive numbers under concurrent creation and never reuses a deleted number", async () => {
    const context = await seed();
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => context.service.create(context.company.id, {
      projectId: context.projectA.id, kind: "plan", title: `Concurrent ${index}`, predecessorRecordIds: [],
    }, actor)));
    expect(created.map((record) => record.recordNumber).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    await db.delete(workRecords).where(eq(workRecords.id, created[11]!.id));
    const next = await context.service.create(context.company.id, {
      projectId: context.projectA.id, kind: "plan", title: "After delete", predecessorRecordIds: [],
    }, actor);
    expect(next.recordIdentifier).toBe("PT-13");
  });

  it("keeps the work-record identifier unchanged after dispatch creates a native issue", async () => {
    const context = await seed();
    const record = await context.service.create(context.company.id, {
      projectId: context.projectA.id,
      kind: "plan",
      title: "Dispatch me",
      assigneeAgentId: context.agent.id,
      predecessorRecordIds: [],
    }, actor);
    expect(record.recordIdentifier).toBe("PT-1");

    const dispatched = await context.service.dispatch(context.company.id, context.projectA.id, record.id, {
      clientRequestId: "fid-03-dispatch",
      expectedRevision: record.revision,
    }, actor);
    expect(dispatched.issueIdentifier).not.toBe(record.recordIdentifier);
    expect(dispatched.record.recordIdentifier).toBe("PT-1");
    expect((await context.service.list(context.company.id, context.projectA.id))[0]?.recordIdentifier).toBe("PT-1");
  });
});
