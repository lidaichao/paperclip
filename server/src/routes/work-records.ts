import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createWorkRecordSchema,
  dispatchWorkRecordSchema,
  fillWorkRecordAssignmentGapSchema,
  linkWorkPackageDefectSchema,
  prepareWorkPackageDispatchSchema,
  previewWorkPackageDispatchSchema,
  recordPoQualityVerdictSchema,
  recordQaQualityVerdictSchema,
  updateWorkRecordSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { HttpError, forbidden } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  accessService,
  logActivity,
  workPackageDispatchService,
  workRecordQualityService,
  workRecordService,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

export function workRecordRoutes(db: Db) {
  const router = Router();
  const service = workRecordService(db);
  const packages = workPackageDispatchService(db);
  const quality = workRecordQualityService(db);
  const access = accessService(db);

  async function assertPackageAssignmentAccess(req: Parameters<typeof getActorInfo>[0], companyId: string, projectId: string, assigneeAgentIds: Array<string | null>) {
    assertCompanyAccess(req, companyId);
    for (const assigneeAgentId of new Set(assigneeAgentIds.filter((id): id is string => Boolean(id)))) {
      const decision = await access.decide({
        actor: req.actor,
        action: "tasks:assign",
        resource: { type: "issue", companyId, issueId: null, projectId, parentIssueId: null, assigneeAgentId, assigneeUserId: null },
        scope: { projectId, parentIssueId: null, assigneeAgentId, assigneeUserId: null },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
  }

  async function logPackageRunEvent(req: Parameters<typeof getActorInfo>[0], action: string, payload: Record<string, unknown>) {
    const actor = getActorInfo(req);
    if (!actor.runId || !actor.agentId) return;
    await appendHeartbeatRunEvent(db, {
      companyId: req.params.companyId as string,
      runId: actor.runId,
      agentId: actor.agentId,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: action,
      payload,
    });
  }

  function commandError(error: unknown) {
    if (!(error instanceof HttpError)) return { status: 500, code: "internal_error" };
    const errorDetails = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : null;
    return {
      status: error.status,
      code: typeof errorDetails?.code === "string" ? errorDetails.code : "http_error",
    };
  }

  async function executeQualityCommand<T>(
    req: Parameters<typeof getActorInfo>[0],
    input: {
      command: "po_verdict" | "qa_verdict" | "defect_link";
      companyId: string;
      projectId: string;
      recordId: string;
      cycleId: string;
      itemId: string | null;
      requestKey: string;
      expectedCycleRevision: number;
    },
    execute: () => Promise<T>,
  ) {
    const actor = getActorInfo(req);
    const auditAllowed = hasCompanyAccess(req, input.companyId);
    let before: Awaited<ReturnType<typeof quality.auditSnapshot>> | null = null;
    let result: T;
    try {
      assertCompanyAccess(req, input.companyId);
      before = await quality.auditSnapshot(
        input.companyId,
        input.projectId,
        input.recordId,
        input.cycleId,
        input.itemId,
      );
      result = await execute();
    } catch (error) {
      if (auditAllowed) {
        if (!before) {
          try {
            before = await quality.auditSnapshot(
              input.companyId,
              input.projectId,
              input.recordId,
              input.cycleId,
              input.itemId,
            );
          } catch {
            before = null;
          }
        }
        const errorSummary = commandError(error);
        const outcome = errorSummary.status === 409 ? "conflict" : "rejected";
        const auditDetails = {
          companyId: input.companyId,
          projectId: input.projectId,
          recordId: input.recordId,
          batchId: null,
          cycleId: input.cycleId,
          itemId: input.itemId,
          intentIds: before?.intentIds ?? [],
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          requestKey: input.requestKey,
          beforeRevision: before ?? { cycleRevision: input.expectedCycleRevision },
          afterRevision: before ?? { cycleRevision: input.expectedCycleRevision },
          outcome,
          error: errorSummary,
          command: input.command,
        };
        await logActivity(db, {
          companyId: input.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "work_record.quality_command",
          entityType: "work_record_quality_command",
          entityId: `${input.command}:${input.requestKey}`,
          details: auditDetails,
        });
        await logPackageRunEvent(req, "work_record_quality_command", auditDetails);
      }
      throw error;
    }

    const after = await quality.auditSnapshot(
      input.companyId,
      input.projectId,
      input.recordId,
      input.cycleId,
      input.itemId,
    );
    const replayed = Boolean((result as { replayed?: unknown }).replayed);
    const auditDetails = {
      companyId: input.companyId,
      projectId: input.projectId,
      recordId: input.recordId,
      batchId: null,
      cycleId: input.cycleId,
      itemId: input.itemId,
      intentIds: [...new Set([...(before?.intentIds ?? []), ...after.intentIds])],
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      requestKey: input.requestKey,
      beforeRevision: before,
      afterRevision: after,
      outcome: replayed ? "replayed" : "succeeded",
      error: null,
      command: input.command,
    };
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "work_record.quality_command",
      entityType: "work_record_quality_command",
      entityId: `${input.command}:${input.requestKey}`,
      details: auditDetails,
    });
    await logPackageRunEvent(req, "work_record_quality_command", auditDetails);
    return result;
  }

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/preview", validate(previewWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const preview = await packages.preview(companyId, projectId, req.body);
    await assertPackageAssignmentAccess(req, companyId, projectId, preview.records.flatMap((record) => [
      record.assigneeAgentId,
      record.qaAssigneeAgentId,
    ]));
    res.json(preview);
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/prepare", validate(prepareWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const preview = await packages.preview(companyId, projectId, req.body);
    await assertPackageAssignmentAccess(req, companyId, projectId, preview.records.flatMap((record) => [
      record.assigneeAgentId,
      record.qaAssigneeAgentId,
    ]));
    const actor = getActorInfo(req);
    const result = await packages.prepare(companyId, projectId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: result.replayed ? "work_package.dispatch_replayed" : "work_package.dispatch_prepared",
      entityType: "work_record_dispatch_batch",
      entityId: result.batch.id,
      details: { projectId, state: result.batch.state, scopeKind: result.batch.scopeKind, itemCount: result.items.length },
    });
    await logPackageRunEvent(req, "work_package_dispatch_prepared", { batchId: result.batch.id, replayed: result.replayed });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get("/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await packages.getBatch(companyId, projectId, req.params.batchId as string));
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/:batchId/reconcile", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const result = await packages.reconcile(companyId, projectId, req.params.batchId as string, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "work_package.dispatch_reconciled",
      entityType: "work_record_dispatch_batch",
      entityId: result.batch.id,
      details: { projectId, state: result.batch.state, itemCount: result.items.length },
    });
    await logPackageRunEvent(req, "work_package_dispatch_reconciled", { batchId: result.batch.id, state: result.batch.state });
    res.json(result);
  });

  router.get("/companies/:companyId/projects/:projectId/work-records", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId, projectId));
  });

  router.get("/companies/:companyId/projects/:projectId/work-records/:recordId/quality", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await quality.get(companyId, projectId, req.params.recordId as string));
  });

  router.post(
    "/companies/:companyId/projects/:projectId/work-records/:recordId/quality/po-verdicts",
    validate(recordPoQualityVerdictSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      const recordId = req.params.recordId as string;
      const result = await executeQualityCommand(req, {
        command: "po_verdict",
        companyId,
        projectId,
        recordId,
        cycleId: req.body.cycleId,
        itemId: req.body.itemId,
        requestKey: req.body.clientRequestId,
        expectedCycleRevision: req.body.expectedCycleRevision,
      }, () => quality.recordPoVerdict(companyId, projectId, recordId, req.body, getActorInfo(req)));
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/projects/:projectId/work-records/:recordId/quality/qa-verdicts",
    validate(recordQaQualityVerdictSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      const recordId = req.params.recordId as string;
      const result = await executeQualityCommand(req, {
        command: "qa_verdict",
        companyId,
        projectId,
        recordId,
        cycleId: req.body.cycleId,
        itemId: req.body.itemId,
        requestKey: req.body.clientRequestId,
        expectedCycleRevision: req.body.expectedCycleRevision,
      }, () => quality.recordQaVerdict(companyId, projectId, recordId, req.body, getActorInfo(req)));
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/projects/:projectId/work-record-quality/defect-links",
    validate(linkWorkPackageDefectSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      const result = await executeQualityCommand(req, {
        command: "defect_link",
        companyId,
        projectId,
        recordId: req.body.packageRecordId,
        cycleId: req.body.cycleId,
        itemId: null,
        requestKey: req.body.clientRequestId,
        expectedCycleRevision: req.body.expectedCycleRevision,
      }, () => quality.linkPackageDefect(companyId, projectId, req.body, getActorInfo(req)));
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post("/companies/:companyId/work-records", validate(createWorkRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const record = await service.create(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "work_record.created",
      entityType: "work_record",
      entityId: record.id,
      details: { projectId: record.projectId, kind: record.kind },
    });
    res.status(201).json(record);
  });

  router.post(
    "/companies/:companyId/projects/:projectId/work-records/:recordId/assignment",
    validate(fillWorkRecordAssignmentGapSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      const recordId = req.params.recordId as string;
      const actor = getActorInfo(req);
      const auditAllowed = hasCompanyAccess(req, companyId);
      let result: Awaited<ReturnType<typeof service.fillAssignmentGap>>;
      try {
        assertCompanyAccess(req, companyId);
        result = await service.fillAssignmentGap(companyId, projectId, recordId, req.body, {
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        });
      } catch (error) {
        if (auditAllowed) {
          const errorSummary = commandError(error);
          const outcome = errorSummary.status === 409 ? "conflict" : "rejected";
          const auditDetails = {
            companyId,
            projectId,
            recordId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            requestKey: req.body.clientRequestId,
            approvalId: req.body.approvalId ?? null,
            expectedAssigneeAgentId: req.body.expectedAssigneeAgentId,
            assigneeAgentId: req.body.assigneeAgentId,
            beforeRevision: req.body.expectedRecordRevision,
            afterRevision: null,
            outcome,
            error: errorSummary,
          };
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "work_record.assignment_command",
            entityType: "work_record_assignment_command",
            entityId: `${recordId}:${req.body.clientRequestId}`,
            details: auditDetails,
          });
          await logPackageRunEvent(req, "work_record_assignment_command", auditDetails);
        }
        throw error;
      }
      const auditDetails = {
        companyId,
        projectId,
        recordId,
        commandId: result.command.id,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        requestKey: req.body.clientRequestId,
        approvalId: result.command.approvalId,
        expectedAssigneeAgentId: result.command.expectedAssigneeAgentId,
        assigneeAgentId: result.command.assigneeAgentId,
        beforeRevision: result.command.previousRevision,
        afterRevision: result.command.resultingRevision,
        outcome: result.replayed ? "replayed" : "succeeded",
        error: null,
      };
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "work_record.assignment_command",
        entityType: "work_record_assignment_command",
        entityId: result.command.id,
        details: auditDetails,
      });
      await logPackageRunEvent(req, "work_record_assignment_command", auditDetails);
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.patch("/companies/:companyId/projects/:projectId/work-records/:recordId", validate(updateWorkRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const recordId = req.params.recordId as string;
    assertCompanyAccess(req, companyId);
    const record = await service.update(companyId, projectId, recordId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "work_record.updated",
      entityType: "work_record",
      entityId: record.id,
      details: { projectId, revision: record.revision },
    });
    res.json(record);
  });

  router.post("/companies/:companyId/projects/:projectId/work-records/:recordId/dispatch", validate(dispatchWorkRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const recordId = req.params.recordId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const result = await service.dispatch(companyId, projectId, recordId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      issueId: result.issueId,
      action: result.replayed ? "work_record.dispatch_replayed" : "work_record.dispatched",
      entityType: "work_record",
      entityId: recordId,
      details: { projectId, issueId: result.issueId, issueLinkId: result.issueLinkId, commandId: result.commandId },
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get("/companies/:companyId/projects/:projectId/work-records/:recordId/dispatch-requests/:clientRequestId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const recordId = req.params.recordId as string;
    const clientRequestId = req.params.clientRequestId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.getDispatchRequest(companyId, projectId, recordId, clientRequestId));
  });

  router.post("/companies/:companyId/projects/:projectId/work-records/:recordId/reconcile", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const recordId = req.params.recordId as string;
    assertCompanyAccess(req, companyId);
    const record = await service.recoverRecord(companyId, projectId, recordId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      issueId: record.execution.issueId,
      action: "work_record.reconciled",
      entityType: "work_record",
      entityId: recordId,
      details: { projectId, recoveryCode: record.recovery.code },
    });
    res.json(record);
  });

  return router;
}
