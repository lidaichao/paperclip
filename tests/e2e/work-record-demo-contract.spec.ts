import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type APIResponse } from "@playwright/test";
import { closeRegisteredClients, createDb } from "../../packages/db/src/index.ts";
import {
  createDemo1Sandbox,
  snapshotNativeSideEffects,
  type Demo1SeedRecord,
  type NativeSideEffectSnapshot,
} from "./fixtures/demo1-regression-sandbox.js";

type ContractRecord = Demo1SeedRecord & {
  description: string | null;
  businessStatus: string;
  defectSeverity: string | null;
  plannedStartDate: string | null;
  plannedCompletionDate: string | null;
};

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function connectToE2eDatabase() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  return { db: createDb(url), url };
}

test("D1-PLAN-01 D1-GANTT-02 D1-DEFECT-01 keep every non-dispatch edit isolated from native Paperclip", async ({ request }) => {
  const sandbox = await createDemo1Sandbox(request, `contract-isolation-${Date.now()}`);
  const { company, project, iterations, planRecords, defectRecords } = sandbox;
  const { db, url } = await connectToE2eDatabase();

  try {
    const baseline = await snapshotNativeSideEffects(db, company.id);
    const expectIsolated = async (label: string, expected: NativeSideEffectSnapshot = baseline) => {
      expect(await snapshotNativeSideEffects(db, company.id), label).toEqual(expected);
    };
    const getRecord = async (recordId: string) => {
      const records = await json<ContractRecord[]>(
        await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
        "read contract records",
      );
      const record = records.find((candidate) => candidate.id === recordId);
      expect(record, `record ${recordId} must exist`).toBeTruthy();
      return record!;
    };

    const created = await json<ContractRecord>(
      await request.post(`/api/companies/${company.id}/work-records`, {
        data: {
          projectId: project.id,
          kind: "plan",
          title: "未派发合同记录",
          iterationId: iterations.primary.id,
          iterationAssignmentMode: "independent",
          plannedStartDate: "2026-11-05",
          plannedCompletionDate: "2026-11-06",
          predecessorRecordIds: [],
        },
      }),
      "create non-dispatched plan",
    );
    await expectIsolated("新建计划记录不应创建原生任务、评论、运行或唤醒请求");

    await json<ContractRecord>(
      await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${created.id}`, {
        data: { expectedRevision: created.revision, title: "未派发合同记录（已编辑）", description: "只保存记录，不派发。" },
      }),
      "edit non-dispatched plan",
    );
    await expectIsolated("编辑计划记录不应创建原生副作用");

    const packageRoot = await getRecord(planRecords.packageRoot.id);
    await json<ContractRecord>(
      await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${packageRoot.id}`, {
        data: { expectedRevision: packageRoot.revision, iterationId: iterations.independent.id },
      }),
      "change package iteration",
    );
    await expectIsolated("调整迭代归属不应隐式派发");

    const releaseNotes = await getRecord(planRecords.releaseNotes.id);
    await json<ContractRecord>(
      await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${releaseNotes.id}`, {
        data: { expectedRevision: releaseNotes.revision, parentRecordId: planRecords.packageRoot.id },
      }),
      "change parent record",
    );
    await expectIsolated("调整父子关系不应隐式派发");

    const regressionChecklist = await getRecord(planRecords.regressionChecklist.id);
    await json<ContractRecord[]>(
      await request.post(`/api/companies/${company.id}/projects/${project.id}/work-record-dependencies/mutate`, {
        data: {
          operation: "add",
          predecessorRecordId: planRecords.releaseNotes.id,
          successorRecordId: regressionChecklist.id,
          expectedRecords: [{
            recordId: regressionChecklist.id,
            expectedRevision: regressionChecklist.revision,
            expectedDependencySetRevision: regressionChecklist.dependencySetRevision,
          }],
        },
      }),
      "add non-dispatched dependency",
    );
    await expectIsolated("调整依赖关系不应隐式派发");

    const scheduled = await getRecord(planRecords.releaseNotes.id);
    await json<ContractRecord>(
      await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${scheduled.id}`, {
        data: {
          expectedRevision: scheduled.revision,
          plannedStartDate: "2026-11-09",
          plannedCompletionDate: "2026-11-13",
        },
      }),
      "move gantt dates",
    );
    await expectIsolated("甘特修改日期不应改变原生任务或唤醒 Agent");

    const defect = await getRecord(defectRecords.textTruncation.id);
    const updatedDefect = await json<ContractRecord>(
      await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${defect.id}`, {
        data: {
          expectedRevision: defect.revision,
          description: "统一描述字段：跑马灯尾部文字被截断。",
          defectSeverity: "high",
          businessStatus: "in_progress",
        },
      }),
      "edit non-dispatched defect",
    );
    expect(updatedDefect).toMatchObject({
      description: "统一描述字段：跑马灯尾部文字被截断。",
      defectSeverity: "high",
      businessStatus: "in_progress",
    });
    await expectIsolated("编辑缺陷不应自动创建原生任务或唤醒 Agent");
  } finally {
    await closeRegisteredClients(url);
  }
});

test("D1-PLAN-07 makes explicit dispatch idempotent across same and new request ids", async ({ request }) => {
  const sandbox = await createDemo1Sandbox(request, `contract-dispatch-${Date.now()}`);
  const { company, project, planRecords } = sandbox;
  const { db, url } = await connectToE2eDatabase();

  try {
    const baseline = await snapshotNativeSideEffects(db, company.id);
    const firstRecord = await json<ContractRecord[]>(
      await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
      "read record before dispatch",
    ).then((records) => records.find((record) => record.id === planRecords.releaseNotes.id)!);
    const first = await json<{ issueId: string; replayed: boolean }>(
      await request.post(`/api/companies/${company.id}/projects/${project.id}/work-records/${firstRecord.id}/dispatch`, {
        data: { clientRequestId: "demo-contract-first", expectedRevision: firstRecord.revision },
      }),
      "dispatch record once",
    );
    expect(first.replayed).toBe(false);

    const afterFirst = await snapshotNativeSideEffects(db, company.id);
    expect(afterFirst.issues).toBe(baseline.issues + 1);
    expect(afterFirst.comments).toBe(baseline.comments);

    const replay = await json<{ issueId: string; replayed: boolean }>(
      await request.post(`/api/companies/${company.id}/projects/${project.id}/work-records/${firstRecord.id}/dispatch`, {
        data: { clientRequestId: "demo-contract-first", expectedRevision: firstRecord.revision },
      }),
      "replay same dispatch request",
    );
    expect(replay).toEqual(expect.objectContaining({ issueId: first.issueId, replayed: true }));
    expect(await snapshotNativeSideEffects(db, company.id)).toEqual(afterFirst);

    const latestRecord = await json<ContractRecord[]>(
      await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
      "read record after dispatch",
    ).then((records) => records.find((record) => record.id === firstRecord.id)!);
    const secondRequest = await json<{ issueId: string }>(
      await request.post(`/api/companies/${company.id}/projects/${project.id}/work-records/${firstRecord.id}/dispatch`, {
        data: { clientRequestId: "demo-contract-second", expectedRevision: latestRecord.revision },
      }),
      "dispatch linked record with a new request id",
    );
    expect(secondRequest.issueId).toBe(first.issueId);
    expect(await snapshotNativeSideEffects(db, company.id)).toEqual(afterFirst);
  } finally {
    await closeRegisteredClients(url);
  }
});

test("D1-PLAN-02 preserves inherited and independent iteration semantics", async ({ request }) => {
  const sandbox = await createDemo1Sandbox(request, `contract-iteration-${Date.now()}`);
  const { company, project, iterations, planRecords } = sandbox;
  const read = async () => json<ContractRecord[]>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read iteration contract records",
  );

  const root = (await read()).find((record) => record.id === planRecords.packageRoot.id)!;
  await json<ContractRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${root.id}`, {
      data: { expectedRevision: root.revision, iterationId: iterations.independent.id },
    }),
    "move package to second iteration",
  );
  let byId = new Map((await read()).map((record) => [record.id, record]));
  for (const inheritedId of [planRecords.design.id, planRecords.development.id, planRecords.qa.id]) {
    expect(byId.get(inheritedId)).toMatchObject({
      iterationAssignmentMode: "inherit_parent",
      iterationId: iterations.independent.id,
    });
  }
  expect(byId.get(planRecords.independent.id)).toMatchObject({
    iterationAssignmentMode: "independent",
    iterationId: iterations.independent.id,
  });

  const design = byId.get(planRecords.design.id)!;
  const detached = await json<ContractRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${design.id}`, {
      data: { expectedRevision: design.revision, parentRecordId: null },
    }),
    "detach inherited child",
  );
  expect(detached).toMatchObject({
    parentRecordId: null,
    iterationAssignmentMode: "independent",
    iterationId: iterations.independent.id,
  });

  const movedRoot = (await read()).find((record) => record.id === root.id)!;
  await json<ContractRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${root.id}`, {
      data: { expectedRevision: movedRoot.revision, iterationId: iterations.primary.id },
    }),
    "move package back to first iteration",
  );
  byId = new Map((await read()).map((record) => [record.id, record]));
  expect(byId.get(planRecords.design.id)).toMatchObject({
    iterationAssignmentMode: "independent",
    iterationId: iterations.independent.id,
  });
  expect(byId.get(planRecords.development.id)).toMatchObject({
    iterationAssignmentMode: "inherit_parent",
    iterationId: iterations.primary.id,
  });
});

test("D1-PLAN-06 D1-GANTT-06 D1-GANTT-07 support dependency rewires and reject dirty graphs", async ({ request }) => {
  const sandbox = await createDemo1Sandbox(request, `contract-dependency-${Date.now()}`);
  const { company, project, planRecords } = sandbox;
  const read = async () => json<ContractRecord[]>(
    await request.get(`/api/companies/${company.id}/projects/${project.id}/work-records`),
    "read dependency contract records",
  );
  const expected = (record: ContractRecord) => ({
    recordId: record.id,
    expectedRevision: record.revision,
    expectedDependencySetRevision: record.dependencySetRevision,
  });
  const mutate = (data: Record<string, unknown>) => request.post(
    `/api/companies/${company.id}/projects/${project.id}/work-record-dependencies/mutate`,
    { data },
  );

  let byId = new Map((await read()).map((record) => [record.id, record]));
  let development = byId.get(planRecords.development.id)!;
  await json<ContractRecord[]>(await mutate({
    operation: "replace_source",
    predecessorRecordId: planRecords.design.id,
    successorRecordId: development.id,
    replacementPredecessorRecordId: planRecords.releaseNotes.id,
    expectedRecords: [expected(development)],
  }), "replace dependency source");
  development = new Map((await read()).map((record) => [record.id, record])).get(planRecords.development.id)!;
  expect(development.dependencies.map((item) => item.predecessorRecordId)).toEqual([planRecords.releaseNotes.id]);

  byId = new Map((await read()).map((record) => [record.id, record]));
  development = byId.get(planRecords.development.id)!;
  let independent = byId.get(planRecords.independent.id)!;
  await json<ContractRecord[]>(await mutate({
    operation: "replace_target",
    predecessorRecordId: planRecords.releaseNotes.id,
    successorRecordId: development.id,
    replacementSuccessorRecordId: independent.id,
    expectedRecords: [expected(development), expected(independent)],
  }), "replace dependency target");
  byId = new Map((await read()).map((record) => [record.id, record]));
  expect(byId.get(planRecords.development.id)!.dependencies).toEqual([]);
  independent = byId.get(planRecords.independent.id)!;
  expect(independent.dependencies.map((item) => item.predecessorRecordId)).toEqual([planRecords.releaseNotes.id]);

  await json<ContractRecord[]>(await mutate({
    operation: "remove",
    predecessorRecordId: planRecords.releaseNotes.id,
    successorRecordId: independent.id,
    expectedRecords: [expected(independent)],
  }), "remove dependency");
  independent = new Map((await read()).map((record) => [record.id, record])).get(planRecords.independent.id)!;
  expect(independent.dependencies).toEqual([]);

  const selfResponse = await mutate({
    operation: "add",
    predecessorRecordId: independent.id,
    successorRecordId: independent.id,
    expectedRecords: [expected(independent)],
  });
  expect(selfResponse.ok(), "self dependency must be rejected").toBe(false);

  byId = new Map((await read()).map((record) => [record.id, record]));
  const qa = byId.get(planRecords.qa.id)!;
  development = byId.get(planRecords.development.id)!;
  const duplicateResponse = await mutate({
    operation: "add",
    predecessorRecordId: development.id,
    successorRecordId: qa.id,
    expectedRecords: [expected(qa)],
  });
  expect(duplicateResponse.ok(), "duplicate dependency must be rejected").toBe(false);

  const cycleResponse = await mutate({
    operation: "add",
    predecessorRecordId: qa.id,
    successorRecordId: development.id,
    expectedRecords: [expected(development)],
  });
  expect(cycleResponse.ok(), "cycle dependency must be rejected").toBe(false);

  await json<ContractRecord[]>(await mutate({
    operation: "add",
    predecessorRecordId: planRecords.releaseNotes.id,
    successorRecordId: independent.id,
    expectedRecords: [expected(independent)],
  }), "restore dependency before undo");
  independent = new Map((await read()).map((record) => [record.id, record])).get(planRecords.independent.id)!;
  await json<ContractRecord[]>(await mutate({
    operation: "remove",
    predecessorRecordId: planRecords.releaseNotes.id,
    successorRecordId: independent.id,
    expectedRecords: [expected(independent)],
  }), "undo restored dependency");

  const foreignProject = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/projects`, { data: { name: `Foreign dependency ${Date.now()}` } }),
    "create foreign dependency project",
  );
  const foreignRecord = await json<ContractRecord>(
    await request.post(`/api/companies/${company.id}/work-records`, {
      data: {
        projectId: foreignProject.id,
        kind: "plan",
        title: "Foreign project record",
        assigneeAgentId: sandbox.agents.worker.id,
        predecessorRecordIds: [],
      },
    }),
    "create foreign dependency record",
  );
  const crossProjectResponse = await mutate({
    operation: "add",
    predecessorRecordId: planRecords.releaseNotes.id,
    successorRecordId: foreignRecord.id,
    expectedRecords: [expected(foreignRecord)],
  });
  expect(crossProjectResponse.ok(), "cross-project dependency must be rejected").toBe(false);

  const finalById = new Map((await read()).map((record) => [record.id, record]));
  expect(finalById.get(planRecords.independent.id)!.dependencies).toEqual([]);
  expect(finalById.get(planRecords.development.id)!.dependencies).toEqual([]);
  expect(finalById.get(planRecords.qa.id)!.dependencies.map((item) => item.predecessorRecordId))
    .toEqual([planRecords.development.id]);
});
