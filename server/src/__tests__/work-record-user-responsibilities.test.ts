import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, companies, createDb, projects, workRecords, workRecordUserResponsibilities } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workRecordService } from "../services/work-records.js";
import { workRecordMyTodoService } from "../services/work-record-my-todos.js";

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

  it("paginates one row per record across projects with independent kind and status filters", async () => {
    const companyId = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Todo projection", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(projects).values([
      { id: projectA, companyId, name: "A" },
      { id: projectB, companyId, name: "B" },
    ]);
    const rows = Array.from({ length: 24 }, (_, index) => ({
      id: randomUUID(), companyId, projectId: index < 12 ? projectA : projectB,
      kind: (index === 23 ? "defect" : "plan") as "plan" | "defect",
      title: `Record ${index}`,
      businessStatus: index === 22 ? "done" : "todo",
      updatedAt: new Date(Date.UTC(2026, 10, 9, 0, index)),
    }));
    await db.insert(workRecords).values(rows);
    await db.insert(workRecordUserResponsibilities).values(rows.flatMap((row, index) => [
      { companyId, projectId: row.projectId, recordId: row.id, userId: "alice-user", role: "execution" as const },
      ...(index === 0 ? [{ companyId, projectId: row.projectId, recordId: row.id, userId: "alice-user", role: "qa" as const }] : []),
    ]));
    const myTodos = workRecordMyTodoService(db);
    const first = await myTodos.list(companyId, "alice-user", { limit: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await myTodos.list(companyId, "alice-user", { limit: 20, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(23);
    expect([...first.items, ...second.items].find((item) => item.id === rows[0].id)?.roles).toEqual(["execution", "qa"]);
    expect((await myTodos.list(companyId, "alice-user", { kind: "defect" })).items).toHaveLength(1);
    expect((await myTodos.list(companyId, "alice-user", { status: "done" })).items.map((item) => item.id)).toEqual([rows[22].id]);
    expect((await myTodos.list(companyId, "alice-user", { projectId: projectA })).items).toHaveLength(12);
    expect((await myTodos.list(companyId, "other-user")).items).toHaveLength(0);
    await expect(myTodos.list(companyId, "alice-user", { cursor: "invalid" })).rejects.toMatchObject({ status: 422 });
  });
});
