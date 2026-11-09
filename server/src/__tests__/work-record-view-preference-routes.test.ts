import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkRecordViewConfig } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { workRecordViewPreferenceRoutes } from "../routes/work-record-view-preferences.js";

const service = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), put: vi.fn() }));
const logActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  workRecordViewPreferenceService: () => service,
  logActivity,
}));

function app(actor: Express.Request["actor"]) {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api", workRecordViewPreferenceRoutes({} as never));
  result.use(errorHandler);
  return result;
}

const board = {
  type: "board",
  userId: "user-a",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
  source: "session",
  isInstanceAdmin: false,
} as Express.Request["actor"];

describe("work-record view preference routes", () => {
  beforeEach(() => {
    service.get.mockReset();
    service.put.mockReset();
    service.list.mockReset(); service.create.mockReset(); service.update.mockReset(); service.remove.mockReset();
    logActivity.mockReset();
    service.get.mockResolvedValue({ revision: 0, config: defaultWorkRecordViewConfig("plan") });
    service.put.mockResolvedValue({ revision: 1, config: defaultWorkRecordViewConfig("plan") });
    const personal = { id: "view-1", name: "Mine", revision: 1, isBuiltin: false, config: defaultWorkRecordViewConfig("plan") };
    service.list.mockResolvedValue([personal]); service.create.mockResolvedValue(personal); service.update.mockResolvedValue({ ...personal, revision: 2 }); service.remove.mockResolvedValue({ id: "view-1", deleted: true });
  });

  it("exposes named personal view CRUD without accepting builtin mutations", async () => {
    const base = "/api/companies/company-1/projects/project-1/work-record-views/plan";
    await request(app(board)).get(base).expect(200);
    expect(service.list).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan");
    await request(app(board)).post(base).send({ name: " Mine ", config: defaultWorkRecordViewConfig("plan") }).expect(201);
    await request(app(board)).patch(`${base}/view-1`).send({ expectedRevision: 1, name: "Renamed" }).expect(200);
    await request(app(board)).delete(`${base}/view-1`).send({ expectedRevision: 2 }).expect(200);
    expect(service.create).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan", "Mine", defaultWorkRecordViewConfig("plan"));
    expect(service.update).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan", "view-1", 1, expect.objectContaining({ name: "Renamed" }));
    expect(service.remove).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan", "view-1", 2);
    expect(logActivity).toHaveBeenCalledTimes(3);
  });

  it("binds reads and writes to the authenticated board user", async () => {
    await request(app(board)).get("/api/companies/company-1/projects/project-1/work-record-view-preferences/plan").expect(200);
    expect(service.get).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan");
    await request(app(board)).put("/api/companies/company-1/projects/project-1/work-record-view-preferences/plan")
      .send({ expectedRevision: 0, config: defaultWorkRecordViewConfig("plan") }).expect(200);
    expect(service.put).toHaveBeenCalledWith("company-1", "project-1", "user-a", "plan", 0, defaultWorkRecordViewConfig("plan"));
    expect(logActivity).toHaveBeenCalledOnce();
  });

  it("rejects cross-company, agent, unsupported view, and arbitrary config fields", async () => {
    await request(app(board)).get("/api/companies/company-2/projects/project-1/work-record-view-preferences/plan").expect(403);
    await request(app({ type: "agent", agentId: "agent-1", companyId: "company-1", keyId: null, source: "agent_key" } as Express.Request["actor"]))
      .get("/api/companies/company-1/projects/project-1/work-record-view-preferences/plan").expect(403);
    await request(app(board)).get("/api/companies/company-1/projects/project-1/work-record-view-preferences/calendar").expect(400);
    await request(app(board)).put("/api/companies/company-1/projects/project-1/work-record-view-preferences/plan")
      .send({ expectedRevision: 0, config: { ...defaultWorkRecordViewConfig("plan"), privilege: "admin" } }).expect(400);
    expect(service.put).not.toHaveBeenCalled();
  });
});
