import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  workRecordViewPreferences,
} from "@paperclipai/db";
import { defaultWorkRecordViewConfig } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordViewPreferenceService } from "../services/work-record-view-preferences.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("G1 work-record view preference persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-view-pref-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const company = await db.insert(companies).values({ name: `Company ${suffix}`, issuePrefix: `V${suffix}` }).returning().then((rows) => rows[0]);
    const projectA = await db.insert(projects).values({ companyId: company.id, name: "Project A" }).returning().then((rows) => rows[0]);
    const projectB = await db.insert(projects).values({ companyId: company.id, name: "Project B" }).returning().then((rows) => rows[0]);
    return { company, projectA, projectB, service: workRecordViewPreferenceService(db) };
  }

  it("isolates preferences by company project user and view kind with safe defaults", async () => {
    const context = await seed();
    const initial = await context.service.get(context.company.id, context.projectA.id, "user-a", "plan");
    expect(initial).toMatchObject({ revision: 0, config: defaultWorkRecordViewConfig("plan") });

    const saved = await context.service.put(context.company.id, context.projectA.id, "user-a", "plan", 0, {
      ...defaultWorkRecordViewConfig("plan"),
      visibleFields: ["id", "title", "businessStatus"],
      columnOrder: ["id", "title", "businessStatus"],
      columnWidths: { title: 360 },
      density: "compact",
    });
    expect(saved).toMatchObject({ revision: 1, config: { density: "compact", columnWidths: { title: 360 } } });
    await expect(context.service.put(context.company.id, context.projectA.id, "user-a", "plan", 0, saved.config))
      .rejects.toMatchObject({ status: 409, details: { currentRevision: 1 } });
    expect((await context.service.get(context.company.id, context.projectB.id, "user-a", "plan")).revision).toBe(0);
    expect((await context.service.get(context.company.id, context.projectA.id, "user-b", "plan")).revision).toBe(0);
    expect((await context.service.get(context.company.id, context.projectA.id, "user-a", "defect")).revision).toBe(0);

    await expect(context.service.put(context.company.id, context.projectA.id, "user-a", "plan", 1, {
      ...saved.config,
      visibleFields: ["id", "title", "defectSeverity"],
    })).rejects.toMatchObject({ status: 422 });
    await expect(context.service.get(context.company.id, randomUUID(), "user-a", "plan"))
      .rejects.toMatchObject({ status: 404 });

    expect(await db.select().from(workRecordViewPreferences)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("supports personal named view lifecycle with trim, scoped uniqueness and revision conflicts", async () => {
    const context = await seed();
    const config = { ...defaultWorkRecordViewConfig("plan"), search: "release", density: "compact" as const };
    const created = await context.service.create(context.company.id, context.projectA.id, "user-a", "plan", "  Release view  ", config);
    expect(created).toMatchObject({ name: "Release view", revision: 1, isBuiltin: false });
    await expect(context.service.create(context.company.id, context.projectA.id, "user-a", "plan", "release VIEW", config))
      .rejects.toMatchObject({ status: 409 });

    const listed = await context.service.list(context.company.id, context.projectA.id, "user-a", "plan");
    expect(listed.map((item) => item.name)).toEqual(["全部计划", "Release view"]);
    const renamed = await context.service.update(context.company.id, context.projectA.id, "user-a", "plan", created.id, 1, { name: "Active release" });
    expect(renamed).toMatchObject({ name: "Active release", revision: 2, config });
    await expect(context.service.update(context.company.id, context.projectA.id, "user-a", "plan", created.id, 1, { config }))
      .rejects.toMatchObject({ status: 409, details: { currentRevision: 2 } });

    expect((await context.service.list(context.company.id, context.projectA.id, "user-b", "plan"))).toHaveLength(1);
    expect((await context.service.list(context.company.id, context.projectB.id, "user-a", "plan"))).toHaveLength(1);
    await expect(context.service.remove(context.company.id, context.projectA.id, "user-a", "plan", "builtin:plan", 1))
      .rejects.toMatchObject({ status: 422 });
    expect(await context.service.remove(context.company.id, context.projectA.id, "user-b", "plan", created.id, 2))
      .toMatchObject({ deleted: true, replayed: true });
    expect(await context.service.remove(context.company.id, context.projectA.id, "user-a", "defect", created.id, 2))
      .toMatchObject({ deleted: true, replayed: true });
    const concurrent = await Promise.all([
      context.service.remove(context.company.id, context.projectA.id, "user-a", "plan", created.id, 2),
      context.service.remove(context.company.id, context.projectA.id, "user-a", "plan", created.id, 2),
    ]);
    expect(concurrent.every((receipt) => receipt.deleted)).toBe(true);

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
