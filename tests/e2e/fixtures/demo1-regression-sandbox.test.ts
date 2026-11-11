import { describe, expect, it, vi } from "vitest";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { createDemo1Sandbox, snapshotNativeSideEffects } from "./demo1-regression-sandbox.js";

function response(payload: unknown, status = 200): APIResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => JSON.stringify(payload),
  } as unknown as APIResponse;
}

function requestDouble() {
  let recordSequence = 0;
  let iterationSequence = 0;
  const records = new Map<string, Record<string, unknown>>();
  const post = vi.fn(async (url: string, options?: { data?: Record<string, unknown> }) => {
    const data = options?.data ?? {};
    if (url === "/api/companies") return response({ id: "company-1", issuePrefix: "FRT" }, 201);
    if (url.endsWith("/projects")) return response({ id: "project-1", ...data }, 201);
    if (url.endsWith("/agents")) return response({ id: "agent-1", ...data }, 201);
    if (url.endsWith("/versions")) return response({ id: "version-1", revision: 1, ...data }, 201);
    if (url.endsWith("/iterations")) {
      iterationSequence += 1;
      return response({ id: `iteration-${iterationSequence}`, revision: 1, ...data }, 201);
    }
    if (url.endsWith("/work-records")) {
      recordSequence += 1;
      const predecessorRecordIds = (data.predecessorRecordIds as string[] | undefined) ?? [];
      const record = {
        id: `record-${recordSequence}`,
        revision: 1,
        dependencySetRevision: 1,
        businessStatus: "backlog",
        parentRecordId: null,
        iterationId: null,
        iterationAssignmentMode: "independent",
        foundInVersionId: null,
        qaCoverageRecordIds: [],
        ...data,
        dependencies: predecessorRecordIds.map((predecessorRecordId) => ({ predecessorRecordId })),
      };
      records.set(record.id, record);
      return response(record, 201);
    }
    throw new Error(`Unexpected POST ${url}`);
  });
  const patch = vi.fn(async (url: string, options?: { data?: Record<string, unknown> }) => {
    const id = url.split("/").at(-1)!;
    const current = records.get(id);
    if (!current) throw new Error(`Unexpected PATCH ${url}`);
    const next = { ...current, ...options?.data, revision: Number(current.revision) + 1 };
    records.set(id, next);
    return response(next);
  });
  return {
    request: { post, patch } as unknown as APIRequestContext,
    post,
  };
}

describe("createDemo1Sandbox", () => {
  it("creates the deterministic Demo regression graph without dispatching native work", async () => {
    const fake = requestDouble();
    const sandbox = await createDemo1Sandbox(fake.request, "unit");

    expect(Object.values(sandbox.iterations)).toHaveLength(2);
    expect(Object.values(sandbox.agents)).toHaveLength(1);
    expect(Object.values(sandbox.planRecords)).toHaveLength(7);
    expect(Object.values(sandbox.defectRecords)).toHaveLength(3);

    expect(sandbox.planRecords.packageRoot.title).toBe("跑马灯功能工作包");
    expect(sandbox.planRecords.design.parentRecordId).toBe(sandbox.planRecords.packageRoot.id);
    expect(sandbox.planRecords.development.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([sandbox.planRecords.design.id]);
    expect(sandbox.planRecords.qa.dependencies.map((edge) => edge.predecessorRecordId)).toEqual([sandbox.planRecords.development.id]);
    expect(sandbox.planRecords.independent.iterationAssignmentMode).toBe("independent");
    expect(sandbox.planRecords.independent.iterationId).toBe(sandbox.iterations.independent.id);
    expect(sandbox.defectRecords.textTruncation.foundInVersionId).toBe(sandbox.version.id);

    expect(sandbox.agents.worker.adapterConfig).toEqual({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    expect(sandbox.agents.worker.runtimeConfig).toEqual({
      heartbeat: { enabled: false, wakeOnDemand: false },
    });
    expect(sandbox.cleanup).toEqual(expect.objectContaining({
      companyId: sandbox.company.id,
      projectId: sandbox.project.id,
      ephemeral: true,
      titlePrefix: "[E2E-FR]",
    }));
    expect(fake.post.mock.calls.map(([url]) => url).some((url) => String(url).includes("/dispatch"))).toBe(false);
  });

  it("captures all native side-effect counters from one company boundary", async () => {
    const batches = [
      [{ id: "issue-1" }],
      [{ id: "comment-1" }, { id: "comment-2" }],
      [],
      [{ id: "wake-1" }],
    ];
    const where = vi.fn(async () => batches.shift() ?? []);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(snapshotNativeSideEffects({ select } as never, "company-1")).resolves.toEqual({
      issues: 1,
      comments: 2,
      runs: 0,
      wakes: 1,
    });
    expect(select).toHaveBeenCalledTimes(4);
    expect(where).toHaveBeenCalledTimes(4);
  });
});
