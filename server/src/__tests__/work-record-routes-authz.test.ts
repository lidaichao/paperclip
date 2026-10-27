import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workRecordRoutes } from "../routes/work-records.js";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  dispatch: vi.fn(),
  getDispatchRequest: vi.fn(),
  recoverRecord: vi.fn(),
}));
const logActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  workRecordService: () => service,
  logActivity,
}));

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", workRecordRoutes({} as never));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

const viewer = {
  type: "board",
  userId: "viewer-1",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
  source: "session",
  isInstanceAdmin: false,
} as Express.Request["actor"];

describe("work-record route authorization", () => {
  beforeEach(() => {
    for (const mock of Object.values(service)) mock.mockReset();
    logActivity.mockReset();
    service.list.mockResolvedValue([]);
    service.getDispatchRequest.mockResolvedValue({ state: "linked" });
  });

  it("allows a viewer to read records and inspect the same dispatch request", async () => {
    const app = createApp(viewer);
    await request(app).get("/api/companies/company-1/projects/project-1/work-records").expect(200, []);
    await request(app).get("/api/companies/company-1/projects/project-1/work-records/record-1/dispatch-requests/request-1").expect(200, { state: "linked" });
    expect(service.list).toHaveBeenCalledWith("company-1", "project-1");
    expect(service.getDispatchRequest).toHaveBeenCalledWith("company-1", "project-1", "record-1", "request-1");
  });

  it("keeps viewer access read-only for reconcile/recovery", async () => {
    const app = createApp(viewer);
    await request(app).post("/api/companies/company-1/projects/project-1/work-records/record-1/reconcile").send({}).expect(403, { error: "Viewer access is read-only" });
    expect(service.recoverRecord).not.toHaveBeenCalled();
  });

  it("rejects cross-company reads before the service can disclose records", async () => {
    const app = createApp(viewer);
    await request(app).get("/api/companies/company-2/projects/project-2/work-records").expect(403, { error: "User does not have access to this company" });
    expect(service.list).not.toHaveBeenCalled();
  });
});
