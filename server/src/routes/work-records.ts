import { Router } from "express";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  createWorkRecordSchema,
  createProjectIterationSchema,
  createProjectVersionSchema,
  dispatchWorkRecordSchema,
  escalateWorkPackageAssignmentGapsSchema,
  fillWorkRecordAssignmentGapSchema,
  linkWorkPackageDefectSchema,
  prepareWorkPackageDispatchSchema,
  previewWorkPackageDispatchSchema,
  recordPoQualityVerdictSchema,
  recordQaQualityVerdictSchema,
  recoverWorkRecordOutboxSchema,
  mutateProjectContainerSchema,
  updateProjectIterationSchema,
  updateProjectVersionSchema,
  updateWorkRecordSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { HttpError, forbidden, unprocessable } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  accessService,
  heartbeatService,
  logActivity,
  workPackageDispatchService,
  workRecordQualityService,
  workRecordService,
} from "../services/index.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

export interface WorkRecordRouteOptions {
  heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
  /** Explicit isolated-test override; production routes resolve the environment cohort. */
  workflowV2WritesEnabled?: boolean;
}

export function workRecordRoutes(db: Db, options: WorkRecordRouteOptions = {}) {
  const router = Router();
  const service = workRecordService(db, { writesEnabled: options.workflowV2WritesEnabled });
  const packages = workPackageDispatchService(db, { writesEnabled: options.workflowV2WritesEnabled });
  const quality = workRecordQualityService(db, { writesEnabled: options.workflowV2WritesEnabled });
  const access = accessService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db);

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

  function assertCompanyReadAccess(req: Parameters<typeof getActorInfo>[0], companyId: string) {
    assertAuthenticated(req);
    if (hasCompanyAccess(req, companyId)) return;
    if (req.actor.type === "agent") throw forbidden("智能体密钥不能访问其他公司");
    throw forbidden("用户没有此公司的访问权限");
  }

  function isReadOnlyViewer(req: Parameters<typeof getActorInfo>[0], companyId: string) {
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return false;
      return req.actor.memberships?.some((item) => item.companyId === companyId && item.status === "active" && item.membershipRole === "viewer") ?? true;
    }
    if (req.actor.type === "agent" && req.actor.onBehalfOfUserId) {
      return req.actor.onBehalfOfMemberships?.some((item) => item.companyId === companyId && item.status === "active" && item.membershipRole === "viewer") ?? true;
    }
    return false;
  }

  function actionCapability(allowed: boolean, requiredRole: string) {
    return { allowed, requiredRole, reason: allowed ? null : `需要 ${requiredRole}；当前 Viewer 仅可读取事实。` };
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
    const code = typeof errorDetails?.code === "string" ? errorDetails.code : "http_error";
    const classification = code === "work_record_workflow_stale_revision"
      ? typeof errorDetails?.expectedScopeDigest === "string" && typeof errorDetails?.currentScopeDigest === "string"
        ? "scope_digest_mismatch"
        : "revision_mismatch"
      : null;
    return {
      status: error.status,
      code,
      classification,
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

  router.get("/companies/:companyId/projects/:projectId/work-record-capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const writable = !isReadOnlyViewer(req, companyId);
    res.json({
      preparePackage: actionCapability(writable, "公司 Operator、Admin、Owner，或具 tasks:assign 权限的 Agent"),
      escalateAssignmentGaps: actionCapability(writable, "公司 Operator、Admin 或 Owner"),
      recordPoVerdict: actionCapability(writable, "PO，或公司 Operator、Admin、Owner"),
      recordQaVerdict: actionCapability(writable, "QA，或公司 Operator、Admin、Owner"),
      linkDefect: actionCapability(writable, "PO/QA，或公司 Operator、Admin、Owner"),
      reconcile: actionCapability(writable, "公司 Operator、Admin 或 Owner"),
    });
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/preview", validate(previewWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyReadAccess(req, companyId);
    const preview = await packages.preview(companyId, projectId, req.body);
    res.json(preview);
  });

  router.get("/companies/:companyId/projects/:projectId/work-package-dispatch/assignment-gap-escalations/latest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    const rootRecordId = typeof req.query.rootRecordId === "string" ? req.query.rootRecordId : "";
    assertCompanyReadAccess(req, companyId);
    if (!rootRecordId) throw unprocessable("rootRecordId is required", { code: "work_package_root_required" });
    res.json(await packages.latestAssignmentEscalation(companyId, projectId, rootRecordId));
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/assignment-gap-escalations", validate(escalateWorkPackageAssignmentGapsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const receipt = await packages.escalateAssignmentGaps(companyId, projectId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    }, async (delivery) => {
      const idempotencyKey = `work-record-assignment-gap:${delivery.escalationId}:${delivery.deliveryAttempt}`;
      await heartbeat.wakeup(delivery.targetCeoAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "work_record_assignment_gap_escalated",
        payload: {
          mutation: "work_record_assignment_gap_escalated",
          escalationId: delivery.escalationId,
          projectId: delivery.projectId,
          rootRecordId: delivery.rootRecordId,
          scopeDigest: delivery.scopeDigest,
          missingRecordIds: delivery.missingRecordIds,
        },
        idempotencyKey,
        allowRunCoalescing: false,
        requestedByActorType: delivery.actor.actorType === "plugin" ? "system" : delivery.actor.actorType,
        requestedByActorId: delivery.actor.actorId,
        contextSnapshot: {
          source: "work_record.assignment_gap_escalated",
          projectId: delivery.projectId,
          rootRecordId: delivery.rootRecordId,
          escalationId: delivery.escalationId,
        },
      });
      const wakeup = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, delivery.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      )).then((rows) => rows[0] ?? null);
      if (!wakeup) {
        throw new Error("CEO 唤醒请求未被接受");
      }
      return {
        wakeupRequestId: wakeup.id,
        wakeStatus: wakeup.status,
        runId: wakeup.runId,
        claimedAt: wakeup.claimedAt,
        finishedAt: wakeup.finishedAt,
      };
    });
    if (!receipt.replayed) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "work_record.assignment_gap_escalated",
        entityType: "work_record_assignment_gap_escalation",
        entityId: receipt.id,
        details: { projectId, ...receipt },
      });
      await logPackageRunEvent(req, "work_record_assignment_gap_escalated", { projectId, ...receipt });
    }
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });

  router.post("/companies/:companyId/projects/:projectId/work-package-dispatch/prepare", validate(prepareWorkPackageDispatchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    let result: Awaited<ReturnType<typeof packages.prepare>>;
    try {
      const preview = await packages.preview(companyId, projectId, req.body);
      await assertPackageAssignmentAccess(req, companyId, projectId, preview.records.flatMap((record) => [
        record.assigneeAgentId,
        record.qaAssigneeAgentId,
      ]));
      result = await packages.prepare(companyId, projectId, req.body, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (error) {
      const errorSummary = commandError(error);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "work_record.dispatch_command",
        entityType: "work_record_dispatch_command",
        entityId: `prepare:${req.body.clientRequestId}`,
        details: {
          companyId,
          projectId,
          requestKey: req.body.clientRequestId,
          outcome: errorSummary.status === 409 ? "conflict" : "rejected",
          error: errorSummary,
          command: "prepare",
        },
      });
      throw error;
    }
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

  router.get("/companies/:companyId/projects/:projectId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyReadAccess(req, companyId);
    res.json(await service.listVersions(companyId, projectId));
  });

  router.post("/companies/:companyId/projects/:projectId/versions", validate(createProjectVersionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const version = await service.createVersion(companyId, projectId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_version.created", entityType: "project_version", entityId: version.id,
      details: { projectId },
    });
    res.status(201).json(version);
  });

  router.patch("/companies/:companyId/projects/:projectId/versions/:versionId", validate(updateProjectVersionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const version = await service.updateVersion(companyId, projectId, req.params.versionId as string, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_version.updated", entityType: "project_version", entityId: version.id,
      details: { projectId, expectedRevision: req.body.expectedRevision, revision: version.revision },
    });
    res.json(version);
  });

  for (const [operation, execute] of [
    ["archive", service.archiveVersion],
    ["restore", service.restoreVersion],
  ] as const) {
    router.post(`/companies/:companyId/projects/:projectId/versions/:versionId/${operation}`, validate(mutateProjectContainerSchema), async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      const version = await execute(companyId, projectId, req.params.versionId as string, req.body.expectedRevision);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
        runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
        action: `project_version.${operation}d`, entityType: "project_version", entityId: version.id,
        details: { projectId, expectedRevision: req.body.expectedRevision, revision: version.revision },
      });
      res.json(version);
    });
  }

  router.delete("/companies/:companyId/projects/:projectId/versions/:versionId", validate(mutateProjectContainerSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const result = await service.deleteVersion(companyId, projectId, req.params.versionId as string, req.body.expectedRevision);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_version.deleted", entityType: "project_version", entityId: result.id,
      details: { projectId },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/projects/:projectId/iterations", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyReadAccess(req, companyId);
    res.json(await service.listIterations(companyId, projectId));
  });

  router.post("/companies/:companyId/projects/:projectId/iterations", validate(createProjectIterationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const iteration = await service.createIteration(companyId, projectId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_iteration.created", entityType: "project_iteration", entityId: iteration.id,
      details: { projectId, versionId: iteration.versionId },
    });
    res.status(201).json(iteration);
  });

  router.patch("/companies/:companyId/projects/:projectId/iterations/:iterationId", validate(updateProjectIterationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const iteration = await service.updateIteration(companyId, projectId, req.params.iterationId as string, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_iteration.updated", entityType: "project_iteration", entityId: iteration.id,
      details: { projectId, expectedRevision: req.body.expectedRevision, revision: iteration.revision },
    });
    res.json(iteration);
  });

  for (const [operation, execute] of [
    ["archive", service.archiveIteration],
    ["restore", service.restoreIteration],
  ] as const) {
    router.post(`/companies/:companyId/projects/:projectId/iterations/:iterationId/${operation}`, validate(mutateProjectContainerSchema), async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      const iteration = await execute(companyId, projectId, req.params.iterationId as string, req.body.expectedRevision);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
        runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
        action: `project_iteration.${operation}d`, entityType: "project_iteration", entityId: iteration.id,
        details: { projectId, expectedRevision: req.body.expectedRevision, revision: iteration.revision },
      });
      res.json(iteration);
    });
  }

  router.delete("/companies/:companyId/projects/:projectId/iterations/:iterationId", validate(mutateProjectContainerSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const result = await service.deleteIteration(companyId, projectId, req.params.iterationId as string, req.body.expectedRevision);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "project_iteration.deleted", entityType: "project_iteration", entityId: result.id,
      details: { projectId },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/projects/:projectId/work-records", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    const paginationRequested = req.query.limit !== undefined || req.query.afterId !== undefined;
    if (!paginationRequested) {
      res.json(await service.list(companyId, projectId));
      return;
    }
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const afterId = typeof req.query.afterId === "string" ? req.query.afterId : null;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw unprocessable("limit must be an integer from 1 to 200");
    }
    if (afterId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterId)) {
      throw unprocessable("afterId must be a UUID cursor");
    }
    res.json(await service.listPage(companyId, projectId, { limit, afterId }));
  });

  router.get("/companies/:companyId/projects/:projectId/work-record-workflow/operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyReadAccess(req, companyId);
    res.json(await packages.operationsMetrics(companyId, projectId));
  });

  router.post(
    "/companies/:companyId/projects/:projectId/work-record-workflow/outbox/:eventId/recover",
    validate(recoverWorkRecordOutboxSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || isReadOnlyViewer(req, companyId)) {
        throw forbidden("恢复进入死信队列的工作流事件需要看板操作员权限");
      }
      const actor = getActorInfo(req);
      const recovered = await packages.recoverOutboxEvent(
        companyId,
        projectId,
        req.params.eventId as string,
        req.body,
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "work_record.outbox_recovered",
        entityType: "work_record_outbox",
        entityId: recovered.id,
        details: {
          projectId,
          workflowVersion: recovered.workflowVersion,
          recoveryCount: recovered.recoveryCount,
          reasonCode: req.body.reasonCode,
        },
      });
      res.json(recovered);
    },
  );

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
      details: { projectId: record.projectId, kind: record.kind, packageQaRole: record.packageQaRole, qaRetestExemptionReason: record.qaRetestExemptionReason },
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
      details: { projectId, expectedRevision: req.body.expectedRevision, revision: record.revision,
        ...(req.body.packageQaRole !== undefined ? { packageQaRole: record.packageQaRole } : {}),
        ...(req.body.qaRetestExemptionReason !== undefined ? { qaRetestExemptionReason: record.qaRetestExemptionReason } : {}),
        ...(req.body.qaCoverageRecordIds !== undefined ? { qaCoverageRecordIds: record.qaCoverageRecordIds } : {}),
      },
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
