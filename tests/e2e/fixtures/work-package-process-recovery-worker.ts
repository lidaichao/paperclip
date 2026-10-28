import { closeRegisteredClients, createDb, workRecordDispatchBatches, workRecordOutbox } from "../../../packages/db/src/index.js";
import { and, eq, inArray } from "../../../server/node_modules/drizzle-orm/index.js";
import type { PreviewWorkPackageDispatch } from "../../../packages/shared/src/index.js";
import { heartbeatService } from "../../../server/src/services/heartbeat.js";
import { workRecordService } from "../../../server/src/services/work-records.js";
import {
  workPackageDispatchService,
  type WorkPackageFailpoint,
} from "../../../server/src/services/work-package-dispatch.js";

type WorkerInput = {
  companyId: string;
  projectId: string;
  recordIds: string[];
  clientRequestId: string;
};

const databaseUrl = process.env.PAPERCLIP_M2_R05_DATABASE_URL;
const operation = process.env.PAPERCLIP_M2_R05_OPERATION;
const failpoint = process.env.PAPERCLIP_M2_R05_FAILPOINT as WorkPackageFailpoint | undefined;
const rawInput = process.env.PAPERCLIP_M2_R05_INPUT;

if (!databaseUrl) throw new Error("PAPERCLIP_M2_R05_DATABASE_URL is required");
if (operation !== "crash" && operation !== "recover") {
  throw new Error("PAPERCLIP_M2_R05_OPERATION must be crash or recover");
}
if (!rawInput) throw new Error("PAPERCLIP_M2_R05_INPUT is required");

const input = JSON.parse(rawInput) as WorkerInput;
const db = createDb(databaseUrl);
const heartbeat = heartbeatService(db, {
  runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
});
const records = workRecordService(db, { writesEnabled: true });

function scope(): PreviewWorkPackageDispatch {
  return {
    workflowVersion: 2,
    projectId: input.projectId,
    scopeKind: "selected_records",
    rootRecordId: null,
    selectedRecordIds: input.recordIds,
  };
}

async function batchId() {
  const row = await db
    .select({ id: workRecordDispatchBatches.id })
    .from(workRecordDispatchBatches)
    .where(
      and(
        eq(workRecordDispatchBatches.companyId, input.companyId),
        eq(workRecordDispatchBatches.projectId, input.projectId),
        eq(workRecordDispatchBatches.clientRequestId, input.clientRequestId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row) throw new Error(`Dispatch batch ${input.clientRequestId} was not found`);
  return row.id;
}

async function prepare(service: ReturnType<typeof workPackageDispatchService>) {
  const request = scope();
  const preview = await service.preview(input.companyId, input.projectId, request);
  return service.prepare(
    input.companyId,
    input.projectId,
    {
      ...request,
      clientRequestId: input.clientRequestId,
      requestPayloadDigest: `m2-r05:${input.clientRequestId}`,
      expectedScopeDigest: preview.scopeDigest,
      expectedRootRevision: preview.rootRevision,
      expectedDependencySetRevision: preview.dependencySetRevision,
    },
    { actorType: "system", actorId: "m2-r05-process-worker" },
  );
}

async function crashAtBoundary() {
  if (!failpoint) throw new Error("PAPERCLIP_M2_R05_FAILPOINT is required for crash mode");
  const service = workPackageDispatchService(db, {
    writesEnabled: true,
    failpoint: async (name) => {
      if (name !== failpoint) return;
      if (name !== "after_partial_materialization") {
        await heartbeat.drainActiveRunExecutions();
      }
      process.stdout.write(`M2_R05_FAILPOINT ${JSON.stringify({ failpoint: name, pid: process.pid })}\n`);
      await new Promise<never>(() => {});
    },
  });

  await prepare(service);
  if (failpoint !== "after_partial_materialization") {
    await service.processOutbox(heartbeat.wakeup, 25);
  }
  throw new Error(`Failpoint ${failpoint} was not reached`);
}

async function recover() {
  const service = workPackageDispatchService(db, { writesEnabled: true });
  const recoveredBatchId = await batchId();
  await service.reconcile(input.companyId, input.projectId, recoveredBatchId, {
    actorType: "system",
    actorId: "m2-r05-process-recovery",
  });
  await service.processOutbox(heartbeat.wakeup, 25);
  await heartbeat.drainActiveRunExecutions();
  for (const recordId of input.recordIds) {
    await records.reconcileRecord(input.companyId, input.projectId, recordId);
  }
  await db.update(workRecordOutbox).set({ state: "superseded", updatedAt: new Date() }).where(and(
    eq(workRecordOutbox.companyId, input.companyId),
    eq(workRecordOutbox.workflowVersion, 1),
    inArray(workRecordOutbox.recordId, input.recordIds),
    inArray(workRecordOutbox.state, ["pending", "retry", "processing"]),
  ));
  process.stdout.write(`M2_R05_RECOVERED ${JSON.stringify({ batchId: recoveredBatchId, pid: process.pid })}\n`);
}

try {
  if (operation === "crash") await crashAtBoundary();
  else await recover();
} finally {
  await heartbeat.drainActiveRunExecutions();
  await closeRegisteredClients(databaseUrl);
}
