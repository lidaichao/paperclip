import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { createWorkRecordViewSchema, deleteWorkRecordViewSchema, putWorkRecordViewPreferenceSchema, updateWorkRecordViewSchema, WORK_RECORD_VIEW_KINDS, type WorkRecordViewKind } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, workRecordViewPreferenceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "需要看板用户上下文" });
    return null;
  }
  return req.actor.userId;
}

function viewKind(req: Request, res: Response): WorkRecordViewKind | null {
  const value = req.params.viewKind;
  if (WORK_RECORD_VIEW_KINDS.includes(value as WorkRecordViewKind)) return value as WorkRecordViewKind;
  res.status(400).json({ error: "不支持的视图种类" });
  return null;
}

export function workRecordViewPreferenceRoutes(db: Db) {
  const router = Router();
  const service = workRecordViewPreferenceService(db);
  const path = "/companies/:companyId/projects/:projectId/work-record-view-preferences/:viewKind";
  const collectionPath = "/companies/:companyId/projects/:projectId/work-record-views/:viewKind";
  const itemPath = `${collectionPath}/:viewId`;

  const context = (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    const kind = viewKind(req, res);
    return userId && kind ? { companyId, projectId: req.params.projectId as string, userId, kind } : null;
  };

  const recordActivity = async (req: Request, action: string, details: Record<string, unknown>) => {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: req.params.companyId as string, actorType: actor.actorType, actorId: actor.actorId,
      agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action, entityType: "project", entityId: req.params.projectId as string, details,
    });
  };

  router.get(collectionPath, async (req, res) => {
    const ctx = context(req, res); if (!ctx) return;
    res.json(await service.list(ctx.companyId, ctx.projectId, ctx.userId, ctx.kind));
  });

  router.post(collectionPath, validate(createWorkRecordViewSchema), async (req, res) => {
    const ctx = context(req, res); if (!ctx) return;
    const result = await service.create(ctx.companyId, ctx.projectId, ctx.userId, ctx.kind, req.body.name, req.body.config);
    await recordActivity(req, "work_record.view_created", { viewId: result.id, viewKind: ctx.kind, revision: result.revision });
    res.status(201).json(result);
  });

  router.patch(itemPath, validate(updateWorkRecordViewSchema), async (req, res) => {
    const ctx = context(req, res); if (!ctx) return;
    const result = await service.update(ctx.companyId, ctx.projectId, ctx.userId, ctx.kind, req.params.viewId as string, req.body.expectedRevision, req.body);
    await recordActivity(req, "work_record.view_updated", { viewId: result.id, viewKind: ctx.kind, revision: result.revision });
    res.json(result);
  });

  router.delete(itemPath, validate(deleteWorkRecordViewSchema), async (req, res) => {
    const ctx = context(req, res); if (!ctx) return;
    const result = await service.remove(ctx.companyId, ctx.projectId, ctx.userId, ctx.kind, req.params.viewId as string, req.body.expectedRevision);
    await recordActivity(req, "work_record.view_deleted", { viewId: result.id, viewKind: ctx.kind });
    res.json(result);
  });

  router.get(path, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    const kind = viewKind(req, res);
    if (!userId || !kind) return;
    res.json(await service.get(companyId, req.params.projectId as string, userId, kind));
  });

  router.put(path, validate(putWorkRecordViewPreferenceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUserId(req, res);
    const kind = viewKind(req, res);
    if (!userId || !kind) return;
    const result = await service.put(
      companyId,
      req.params.projectId as string,
      userId,
      kind,
      req.body.expectedRevision,
      req.body.config,
    );
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "work_record.view_preference_updated",
      entityType: "project",
      entityId: req.params.projectId as string,
      details: { userId, viewKind: kind, revision: result.revision },
    });
    res.json(result);
  });

  return router;
}
