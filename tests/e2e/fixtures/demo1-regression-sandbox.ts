import type { APIRequestContext, APIResponse } from "@playwright/test";
import { eq } from "../../../server/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issues,
  type createDb,
} from "../../../packages/db/src/index.ts";

type CompanySeed = { id: string; issuePrefix: string };
type ProjectSeed = { id: string; name: string };
type VersionSeed = { id: string; name: string; revision: number };
type IterationSeed = { id: string; name: string; versionId: string; revision: number };
type AgentSeed = {
  id: string;
  name: string;
  adapterConfig: { command: string; args: string[] };
  runtimeConfig: { heartbeat: { enabled: boolean; wakeOnDemand: boolean } };
};
export type Demo1SeedRecord = {
  id: string;
  title: string;
  kind: "plan" | "defect";
  revision: number;
  dependencySetRevision: number;
  parentRecordId: string | null;
  iterationId: string | null;
  iterationAssignmentMode: "inherit_parent" | "independent";
  foundInVersionId: string | null;
  qaCoverageRecordIds: string[];
  dependencies: Array<{ predecessorRecordId: string }>;
};

export type Demo1PlanRecords = {
  packageRoot: Demo1SeedRecord;
  design: Demo1SeedRecord;
  development: Demo1SeedRecord;
  qa: Demo1SeedRecord;
  independent: Demo1SeedRecord;
  releaseNotes: Demo1SeedRecord;
  regressionChecklist: Demo1SeedRecord;
};

export type Demo1DefectRecords = {
  textTruncation: Demo1SeedRecord;
  lowEndFrameDrop: Demo1SeedRecord;
  acceptanceCopyMismatch: Demo1SeedRecord;
};

export type Demo1SandboxBase = {
  company: CompanySeed;
  project: ProjectSeed;
  version: VersionSeed;
  iterations: { primary: IterationSeed; independent: IterationSeed };
  agents: { worker: AgentSeed };
  planRecords: Partial<Demo1PlanRecords>;
  defectRecords: Partial<Demo1DefectRecords>;
  cleanup: {
    companyId: string;
    projectId: string;
    ephemeral: true;
    titlePrefix: "[E2E-FR]";
  };
};

export type Demo1Sandbox = Omit<Demo1SandboxBase, "planRecords" | "defectRecords"> & {
  planRecords: Demo1PlanRecords;
  defectRecords: Demo1DefectRecords;
};

export type CreateDemo1SandboxOptions = {
  seedRecords?: boolean;
  companyName?: string;
  projectName?: string;
  agentName?: string;
  versionName?: string;
  primaryIterationName?: string;
  independentIterationName?: string;
};

export type NativeSideEffectSnapshot = {
  issues: number;
  comments: number;
  runs: number;
  wakes: number;
};

export async function snapshotNativeSideEffects(
  db: ReturnType<typeof createDb>,
  companyId: string,
): Promise<NativeSideEffectSnapshot> {
  return {
    issues: (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length,
    comments: (await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId))).length,
    runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length,
    wakes: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).length,
  };
}

async function json<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label}: ${response.status()} ${body}`);
  return JSON.parse(body) as T;
}

async function createRecord(
  request: APIRequestContext,
  companyId: string,
  data: Record<string, unknown>,
  label: string,
) {
  return json<Demo1SeedRecord>(
    await request.post(`/api/companies/${companyId}/work-records`, { data }),
    label,
  );
}

export function createDemo1Sandbox(
  request: APIRequestContext,
  suffix: string,
): Promise<Demo1Sandbox>;
export function createDemo1Sandbox(
  request: APIRequestContext,
  suffix: string,
  options: CreateDemo1SandboxOptions & { seedRecords: false },
): Promise<Demo1SandboxBase>;
export async function createDemo1Sandbox(
  request: APIRequestContext,
  suffix: string,
  options: CreateDemo1SandboxOptions = {},
): Promise<Demo1Sandbox | Demo1SandboxBase> {
  const safeSuffix = suffix.trim() || String(Date.now());
  const company = await json<CompanySeed>(
    await request.post("/api/companies", {
      data: { name: options.companyName ?? `[E2E-FR] Demo 1 ${safeSuffix}` },
    }),
    "create Demo 1 sandbox company",
  );
  const project = await json<ProjectSeed>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: { name: options.projectName ?? `[功能回归测试][${safeSuffix}] 人机协作闭环` },
    }),
    "create Demo 1 sandbox project",
  );
  const worker = await json<AgentSeed>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: options.agentName ?? "Demo 1 惰性执行者",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
    "create Demo 1 inert agent",
  );
  const version = await json<VersionSeed>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/versions`, {
      data: { name: options.versionName ?? "FR-V1-当前版本", targetDate: "2026-11-30" },
    }),
    "create Demo 1 version",
  );
  const primary = await json<IterationSeed>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: options.primaryIterationName ?? "FR-S1-当前迭代", startsOn: "2026-11-01", endsOn: "2026-11-15" },
    }),
    "create Demo 1 primary iteration",
  );
  const independent = await json<IterationSeed>(
    await request.post(`/api/companies/${company.id}/projects/${project.id}/iterations`, {
      data: { versionId: version.id, name: options.independentIterationName ?? "FR-S2-独立延期", startsOn: "2026-11-16", endsOn: "2026-11-30" },
    }),
    "create Demo 1 independent iteration",
  );
  const base = {
    company,
    project,
    version,
    iterations: { primary, independent },
    agents: { worker },
    cleanup: {
      companyId: company.id,
      projectId: project.id,
      ephemeral: true as const,
      titlePrefix: "[E2E-FR]" as const,
    },
  };
  if (options.seedRecords === false) return { ...base, planRecords: {}, defectRecords: {} };

  const common = {
    projectId: project.id,
    assigneeAgentId: worker.id,
    qaAssigneeAgentId: worker.id,
  };
  const packageRoot = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "跑马灯功能工作包",
    iterationId: primary.id,
    iterationAssignmentMode: "independent",
    plannedStartDate: "2026-11-03",
    plannedCompletionDate: "2026-11-14",
    predecessorRecordIds: [],
  }, "create package root");
  let design = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "策划设计",
    parentRecordId: packageRoot.id,
    iterationAssignmentMode: "inherit_parent",
    plannedStartDate: "2026-11-03",
    plannedCompletionDate: "2026-11-05",
    predecessorRecordIds: [],
  }, "create design child");
  let development = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "程序开发",
    parentRecordId: packageRoot.id,
    iterationAssignmentMode: "inherit_parent",
    plannedStartDate: "2026-11-06",
    plannedCompletionDate: "2026-11-10",
    predecessorRecordIds: [design.id],
  }, "create development child");
  const qa = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "QA 测试",
    parentRecordId: packageRoot.id,
    iterationAssignmentMode: "inherit_parent",
    packageQaRole: "qa",
    plannedStartDate: "2026-11-11",
    plannedCompletionDate: "2026-11-14",
    predecessorRecordIds: [development.id],
  }, "create QA child");
  design = await json<Demo1SeedRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${design.id}`, {
      data: { expectedRevision: design.revision, qaCoverageRecordIds: [qa.id] },
    }),
    "cover design with QA",
  );
  development = await json<Demo1SeedRecord>(
    await request.patch(`/api/companies/${company.id}/projects/${project.id}/work-records/${development.id}`, {
      data: { expectedRevision: development.revision, qaCoverageRecordIds: [qa.id] },
    }),
    "cover development with QA",
  );
  const independentPlan = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "低端机专项验证",
    parentRecordId: packageRoot.id,
    iterationId: independent.id,
    iterationAssignmentMode: "independent",
    plannedStartDate: "2026-11-18",
    plannedCompletionDate: "2026-11-22",
    predecessorRecordIds: [],
  }, "create independent delayed child");
  const releaseNotes = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "奖励配置说明",
    iterationId: primary.id,
    iterationAssignmentMode: "independent",
    plannedStartDate: "2026-11-04",
    plannedCompletionDate: "2026-11-07",
    predecessorRecordIds: [],
  }, "create release notes plan");
  const regressionChecklist = await createRecord(request, company.id, {
    ...common,
    kind: "plan",
    title: "版本回归清单",
    iterationId: primary.id,
    iterationAssignmentMode: "independent",
    plannedStartDate: "2026-11-08",
    plannedCompletionDate: "2026-11-12",
    predecessorRecordIds: [],
  }, "create regression checklist plan");

  const defectCommon = {
    ...common,
    kind: "defect",
    iterationId: primary.id,
    iterationAssignmentMode: "independent",
    foundInVersionId: version.id,
    predecessorRecordIds: [],
  };
  const textTruncation = await createRecord(request, company.id, {
    ...defectCommon,
    title: "跑马灯文本截断",
    defectSeverity: "critical",
    plannedCompletionDate: "2026-11-09",
  }, "create text truncation defect");
  const lowEndFrameDrop = await createRecord(request, company.id, {
    ...defectCommon,
    title: "低端机掉帧",
    defectSeverity: "high",
    plannedCompletionDate: "2026-11-11",
  }, "create low-end frame drop defect");
  const acceptanceCopyMismatch = await createRecord(request, company.id, {
    ...defectCommon,
    title: "验收文案偏差",
    defectSeverity: "medium",
    plannedCompletionDate: "2026-11-13",
  }, "create acceptance copy mismatch defect");

  return {
    ...base,
    planRecords: {
      packageRoot,
      design,
      development,
      qa,
      independent: independentPlan,
      releaseNotes,
      regressionChecklist,
    },
    defectRecords: { textTruncation, lowEndFrameDrop, acceptanceCopyMismatch },
  };
}
