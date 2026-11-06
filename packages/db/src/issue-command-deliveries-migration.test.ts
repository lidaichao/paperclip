import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, getEmbeddedPostgresTestSupport,
  issueCommandDeliveries, issues, issueThreadInteractions,
  startEmbeddedPostgresTestDatabase,
} from "./index.js";

describe("issue command delivery migration order", () => {
  it("creates the interaction scope uniqueness before the delivery foreign key", async () => {
    const sql = await readFile(new URL("./migrations/0298_shocking_lilith.sql", import.meta.url), "utf8");
    const uniqueAt = sql.indexOf('CREATE UNIQUE INDEX "issue_thread_interactions_company_issue_id_uq"');
    const fkAt = sql.indexOf('ADD CONSTRAINT "issue_command_deliveries_interaction_scope_fk"');
    expect(uniqueAt).toBeGreaterThan(-1);
    expect(fkAt).toBeGreaterThan(uniqueAt);
  });
});

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.runIf(support.supported)("issue command delivery scope constraints (PostgreSQL)", () => {
  it("keeps one named agent delivery in its company and interaction", async () => {
    const temporary = external ? undefined
      : await startEmbeddedPostgresTestDatabase("paperclip-issue-command-delivery-");
    const db = createDb(external ?? temporary!.connectionString);
    try {
      const companyId = randomUUID();
      const foreignCompanyId = randomUUID();
      const authorId = randomUUID();
      const targetId = randomUUID();
      const foreignTargetId = randomUUID();
      const issueId = randomUUID();
      const otherIssueId = randomUUID();
      await db.insert(companies).values([
        { id: companyId, name: "Delivery company", issuePrefix: `D${companyId.slice(0, 7)}` },
        { id: foreignCompanyId, name: "Other company", issuePrefix: `F${foreignCompanyId.slice(0, 7)}` },
      ]);
      await db.insert(agents).values([
        { id: authorId, companyId, name: "Author" },
        { id: targetId, companyId, name: "Reviewer" },
        { id: foreignTargetId, companyId: foreignCompanyId, name: "Foreign reviewer" },
      ]);
      await db.insert(issues).values([
        { id: issueId, companyId, title: "Review me" },
        { id: otherIssueId, companyId, title: "Other task" },
      ]);
      const [interaction] = await db.insert(issueThreadInteractions).values({
        companyId, issueId, kind: "request_confirmation", status: "pending",
        createdByAgentId: authorId, addresseeAgentId: targetId,
        payload: { version: 1, prompt: "Review this" },
      }).returning();
      const intent = {
        companyId, issueId, interactionId: interaction.id,
        sourceRunId: randomUUID(), targetAgentId: targetId,
        kind: "interaction_pending",
      };
      const [saved] = await db.insert(issueCommandDeliveries).values(intent).returning();
      expect(saved).toMatchObject({ status: "awaiting_handoff", attempts: 0 });
      await expect(db.insert(issueCommandDeliveries).values(intent)).rejects.toThrow();
      await expect(db.insert(issueCommandDeliveries).values({
        ...intent, targetAgentId: foreignTargetId,
      })).rejects.toThrow();
      await expect(db.insert(issueCommandDeliveries).values({
        ...intent, issueId: otherIssueId,
      })).rejects.toThrow();
      await expect(db.insert(issueCommandDeliveries).values({
        ...intent, kind: "unknown_delivery",
      })).rejects.toThrow();
      await db.delete(agents).where(eq(agents.id, targetId));
      expect(await db.select().from(issueCommandDeliveries)
        .where(eq(issueCommandDeliveries.id, saved.id))).toHaveLength(0);
    } finally {
      await db.$client.end();
      await temporary?.cleanup();
    }
  }, 90_000);
});
