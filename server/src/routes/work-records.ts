import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createWorkRecordSchema,
  dispatchWorkRecordSchema,
  prepareWorkPackageDispatchSchema,
  previewWorkPackageDispatchSchema,
  updateWorkRecordSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { accessService, logActivity, workPackageDispatchService, workRecordService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function workRecordRoutes(db: Db) {
  const router = Router();
  const service = workRecordService(db);
  const packages = workPackageDispatchService(db);
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

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/preview", validate(previewWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const preview = await packages.preview(companyId, projectId, req.body);
    await assertPackageAssignmentAccess(req, companyId, projectId, preview.records.map((record) => record.assigneeAgentId));
    res.json(preview);
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/prepare", validate(prepareWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const preview = await packages.preview(companyId, projectId, req.body);
    await assertPackageAssignmentAccess(req, companyId, projectId, preview.records.map((record) => record.assigneeAgentId));
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
