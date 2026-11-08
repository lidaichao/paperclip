import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkRecordViewConfig } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { workRecordViewPreferenceRoutes } from "../routes/work-record-view-preferences.js";

const service = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
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
    logActivity.mockReset();
    service.get.mockResolvedValue({ revision: 0, config: defaultWorkRecordViewConfig("plan") });
    service.put.mockResolvedValue({ revision: 1, config: defaultWorkRecordViewConfig("plan") });
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
    await request(app(board)).get("/api/companies/company-1/projects/project-1/work-record-view-preferences/gantt").expect(400);
    await request(app(board)).put("/api/companies/company-1/projects/project-1/work-record-view-preferences/plan")
      .send({ expectedRevision: 0, config: { ...defaultWorkRecordViewConfig("plan"), privilege: "admin" } }).expect(400);
    expect(service.put).not.toHaveBeenCalled();
  });
});
