import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, companies, createDb, projects, workRecords, workRecordUserResponsibilities } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("explicit human work-record responsibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-record-human-responsibility-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  it("never treats the creator as an assignee and keeps multiple roles on one record", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const outsiderCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Alice responsibility", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` },
      { id: outsiderCompanyId, name: "Other company", issuePrefix: `O${outsiderCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "P" });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "alice-user", status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: "viewer-user", status: "active", membershipRole: "viewer" },
      { companyId: outsiderCompanyId, principalType: "user", principalId: "other-user", status: "active", membershipRole: "member" },
    ]);
    const service = workRecordService(db);
    const actor = { actorType: "user" as const, actorId: "alice-user", userId: "alice-user" };
    const plain = await service.create(companyId, { projectId, kind: "plan", title: "unassigned", predecessorRecordIds: [] }, actor);
    expect(plain.userResponsibilities).toEqual([]);
    const assigned = await service.create(companyId, {
      projectId, kind: "defect", title: "needs QA and PO", predecessorRecordIds: [],
      userResponsibilities: [{ userId: "alice-user", role: "qa" }, { userId: "alice-user", role: "po" }],
    }, actor);
    expect(assigned.userResponsibilities).toEqual([{ userId: "alice-user", role: "qa" }, { userId: "alice-user", role: "po" }]);
    expect(await db.select().from(workRecordUserResponsibilities)).toHaveLength(2);

    await expect(service.update(companyId, projectId, assigned.id, {
      expectedRevision: assigned.revision,
      userResponsibilities: [{ userId: "other-user", role: "execution" }],
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.update(companyId, projectId, assigned.id, {
      expectedRevision: assigned.revision,
      userResponsibilities: [{ userId: "viewer-user", role: "execution" }],
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.update(companyId, projectId, assigned.id, {
      expectedRevision: assigned.revision,
      userResponsibilities: [{ userId: "alice-user", role: "qa" }, { userId: "alice-user", role: "qa" }],
    })).rejects.toMatchObject({ status: 422 });
    const updated = await service.update(companyId, projectId, assigned.id, {
      expectedRevision: assigned.revision,
      userResponsibilities: [{ userId: "alice-user", role: "execution" }],
    });
    expect(updated.userResponsibilities).toEqual([{ userId: "alice-user", role: "execution" }]);
    expect(await db.select().from(workRecordUserResponsibilities)).toHaveLength(1);
    await db.delete(workRecords).where(eq(workRecords.id, assigned.id));
    expect(await db.select().from(workRecordUserResponsibilities)).toHaveLength(0);
  });
});
