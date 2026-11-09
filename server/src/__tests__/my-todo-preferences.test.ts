import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projects } from "@paperclipai/db";
import { DEFAULT_MY_TODO_VIEW_CONFIG } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { myTodoPreferenceService } from "../services/my-todo-preferences.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("company-scoped personal my-todo preferences", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-my-todo-prefs-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => tempDb?.cleanup());

  it("isolates users and companies, rejects stale revisions and foreign default projects", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Pref A", issuePrefix: `A${companyA.slice(0, 6).toUpperCase()}` },
      { id: companyB, name: "Pref B", issuePrefix: `B${companyB.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(projects).values([
      { id: projectA, companyId: companyA, name: "A" },
      { id: projectB, companyId: companyB, name: "B" },
    ]);
    const service = myTodoPreferenceService(db);
    expect((await service.get(companyA, "jack")).revision).toBe(0);
    const config = { ...DEFAULT_MY_TODO_VIEW_CONFIG, visibleFields: ["project", "due"] as Array<"project" | "due">, defaultProjectId: projectA };
    const saved = await service.put(companyA, "jack", 0, config);
    expect(saved.revision).toBe(1);
    expect((await service.get(companyA, "jack")).config).toEqual(config);
    expect((await service.get(companyA, "alice")).revision).toBe(0);
    expect((await service.get(companyB, "jack")).revision).toBe(0);
    await expect(service.put(companyA, "jack", 0, config)).rejects.toMatchObject({ status: 409 });
    await expect(service.put(companyB, "jack", 0, config)).rejects.toMatchObject({ status: 422 });
    const updated = await service.put(companyA, "jack", saved.revision, { ...config, defaultProjectId: null, density: "comfortable" });
    expect(updated.revision).toBe(2);
    await expect(service.put(companyA, "jack", saved.revision, config)).rejects.toMatchObject({ status: 409 });
    expect((await service.get(companyA, "jack")).config.density).toBe("comfortable");
    expect((await service.get(companyA, "alice")).config).toEqual(DEFAULT_MY_TODO_VIEW_CONFIG);
    expect((await service.get(companyB, "jack")).config).toEqual(DEFAULT_MY_TODO_VIEW_CONFIG);
  });
});
