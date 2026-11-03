import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createDecisionArchiveProposalSchema,
  decisionInputsSchema,
  decisionOptionsSchema,
  type AttentionArchiveManifestEntry,
  type AttentionArchiveTargetSnapshot,
  type AttentionItem,
  type CreateDecisionArchiveProposalInput,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { decisionService, type DecisionServiceOptions } from "../services/decisions.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { attentionService } from "../services/attention.js";
import { authorizationDeniedDetails, authorizationService } from "../services/authorization.js";
import { canReadDecisionSource } from "../services/decision-queues.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import { forbidden, unprocessable } from "../errors.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  ruleKey: z.string().trim().max(240).nullable().optional(),
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
  expiresAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(),
  continuationPolicy: z.enum(["none", "wake_origin_agent"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
const bundleSchema = z.object({ title: z.string().trim().min(1).max(500), summary: z.string().max(100_000), decisions: z.array(createSchema).min(1).max(50) }).strict();
const decideSchema = z.object({ optionId: z.string().trim().min(1).max(120), inputValues: z.record(z.string(), z.string().max(20_000)).optional(), idempotencyKey: z.string().trim().min(1).max(500).nullable().optional() }).strict();
const dismissSchema = z.object({ reason: z.string().max(20_000).nullable().optional() }).strict();
const statsQuerySchema = z.object({
  groupBy: z.literal("ruleKey"),
  originAgentId: z.string().guid().optional(),
  since: z.coerce.date().optional(),
}).strict();

function agentContext(req: Parameters<typeof getActorInfo>[0]) {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) return null;
  return { agentId: req.actor.agentId, runId: req.actor.runId };
}

function boardUserId(req: Parameters<typeof getActorInfo>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "local-implicit-board";
}

export function decisionRoutes(db: Db, options: DecisionServiceOptions) {
  const router = Router();
  const svc = decisionService(db, options);
  router.post(
    "/companies/:companyId/decision-archive-proposals",
    validate(createDecisionArchiveProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agent = agentContext(req);
      if (!agent) {
        res.status(403).json({ error: "需要智能体运行上下文" });
        return;
      }
      const access = await authorizationService(db).decide({
        actor: req.actor,
        action: "decision_triage:manage",
        resource: { type: "company", companyId },
      });
      if (!access.allowed) throw forbidden(access.explanation, authorizationDeniedDetails(access));

      const proposal = req.body as CreateDecisionArchiveProposalInput;
      const requested = new Map<string, CreateDecisionArchiveProposalInput["items"][number]>(proposal.items.map((item) => [
        `${item.sourceKind}:${item.sourceId}`,
        item,
      ]));
      const found = new Map<string, AttentionItem>();
      const snapshot = await db.transaction(async (tx) => attentionService(tx as unknown as Db).list(companyId, {
        includeDismissed: true,
        all: true,
        allowUnscopedAll: true,
      }), { isolationLevel: "repeatable read" });
      for (const item of snapshot.items) {
        const key = `${item.sourceKind}:${item.subject.id}`;
        if (requested.has(key)) found.set(key, item);
      }

      const manifest: AttentionArchiveManifestEntry[] = [];
      for (const [key, item] of [...requested.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const attentionItem = found.get(key);
        if (!attentionItem || !attentionItem.shelf || attentionItem.archivedAt) {
          throw unprocessable("每个归档提案事项都必须位于当前待清理区");
        }
        if (!(await canReadDecisionSource(db, req.actor, companyId, attentionItem.sourceKind, attentionItem.subject.id))) {
          throw unprocessable("每个归档提案事项都必须位于当前待清理区");
        }
        manifest.push({
          companyId,
          sourceKind: attentionItem.sourceKind,
          sourceId: attentionItem.subject.id,
          expectedVersion: attentionItem.retentionVersion,
          activityAt: attentionItem.activityAt,
          reason: item.reason,
        });
      }
      const manifestHash = hashAttentionArchiveManifest(manifest);
      const targetSnapshots = Object.fromEntries(manifest.map((entry) => [
        `attention:${entry.sourceKind}:${entry.sourceId}`,
        {
          status: "attention",
          assigneeAgentId: null,
          assigneeUserId: null,
          updatedAt: entry.activityAt,
          attentionArchive: entry,
        } satisfies AttentionArchiveTargetSnapshot,
      ]));
      const body = manifest.map((entry) => `- **${entry.sourceKind}:${entry.sourceId}** — ${entry.reason}`).join("\n");
      const created = await svc.create({
        companyId,
        actor: req.actor,
        ...agent,
        title: `归档 ${manifest.length} 个待清理决策？`,
        body,
        ruleKey: "attention.bulk_archive",
        idempotencyKey: proposal.idempotencyKey ?? `attention-archive:${manifestHash}:${agent.runId}`,
        continuationPolicy: "wake_origin_agent",
        options: [
          { id: "archive", label: "归档已复核事项", style: "destructive", effects: [] },
          { id: "keep", label: "保留事项", effects: [] },
        ],
        metadata: { kind: "attention_archive_proposal", manifestHash },
        additionalTargetSnapshots: targetSnapshots,
      });
      res.status(201).json(created);
    },
  );
  router.post("/companies/:companyId/decisions", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "需要智能体运行上下文" }); return; }
    res.status(201).json(await svc.create({ companyId, actor: req.actor, ...agent, ...req.body }));
  });
  router.post("/companies/:companyId/decision-bundles", validate(bundleSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "需要智能体运行上下文" }); return; }
    res.status(201).json(await svc.createBundle({ companyId, actor: req.actor, ...agent, ...req.body }));
  });
  router.get("/companies/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoard(req); assertCompanyAccess(req, companyId);
    const query = z.object({ status: z.enum(["open", "decided", "expired", "cancelled"]).optional(), bundleId: z.string().guid().optional(), targetIssueId: z.string().guid().optional(), originAgentId: z.string().guid().optional(), limit: z.coerce.number().int().positive().max(100).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "决策筛选条件无效", details: query.error.flatten() }); return; }
    res.json(await svc.list(companyId, query.data));
  });
  /**
   * Gardener telemetry contract:
   * { groupBy: "ruleKey", filters: { originAgentId: string|null, since: ISO-8601|null },
   *   totals: { proposed, accepted, rejected, expired },
   *   groups: [{ ruleKey: string|null, proposed, accepted, rejected, expired,
   *     chosenOptions: [{ optionId, count }] }] }
   * Accepted means a non-dismissed decided outcome; rejected means an explicit dismiss;
   * chosenOptions counts accepted outcomes only; expired is separate, and cancelled
   * decisions contribute only to proposed.
   */
  router.get("/companies/:companyId/decisions/stats", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoardOrAgent(req); assertCompanyAccess(req, companyId);
    const query = statsQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "决策统计筛选条件无效", details: query.error.flatten() }); return; }
    if (req.actor.type === "agent" && query.data.originAgentId && query.data.originAgentId !== req.actor.agentId) {
      res.status(403).json({ error: "智能体只能查看自己的决策统计" }); return;
    }
    const originAgentId = req.actor.type === "agent" ? req.actor.agentId : query.data.originAgentId;
    res.json(await svc.stats(companyId, { originAgentId, since: query.data.since }));
  });
  router.get("/decisions/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "未找到决策");
    if (!decision) return;
    if (req.actor.type === "agent" && req.actor.agentId !== decision.originAgentId) { res.status(403).json({ error: "只有发起该决策的智能体才能查看此决策" }); return; }
    res.json(await svc.outcome(decision.id));
  });
  router.post("/decisions/:id/decide", validate(decideSchema), async (req, res) => {
    const userId = boardUserId(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "未找到决策");
    if (!decision) return;
    res.json(await svc.decide({ id: decision.id, decidedByUserId: userId, userActor: req.actor, ...req.body }));
  });
  router.post("/decisions/:id/dismiss", validate(dismissSchema), async (req, res) => {
    const userId = boardUserId(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "未找到决策");
    if (!decision) return;
    res.json(await svc.dismiss(decision.id, userId, req.actor, req.body.reason));
  });
  router.post("/decisions/:id/cancel", async (req, res) => {
    assertBoardOrAgent(req);
    const decision = await getAccessibleResource(req, res, svc.get(req.params.id as string), "未找到决策");
    if (!decision) return;
    const actor = getActorInfo(req); res.json(await svc.cancel(decision.id, { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId }));
  });
  return router;
}
