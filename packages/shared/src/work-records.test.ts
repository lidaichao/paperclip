import { describe, expect, it } from "vitest";
import {
  WORK_RECORD_ITERATION_ASSIGNMENT_MODES,
  createProjectIterationSchema,
  createWorkRecordSchema,
  defaultWorkRecordViewConfig,
  workRecordIdentifier,
  updateWorkRecordSchema,
  updateProjectIterationSchema,
  validateWorkRecordViewConfig,
} from "./work-records.js";

describe("FID-03 work-record business identifiers", () => {
  it("formats stable plan and defect identifiers without native issue prefixes", () => {
    expect(workRecordIdentifier("plan", 1)).toBe("PT-1");
    expect(workRecordIdentifier("defect", 42)).toBe("PC-42");
  });

  it("rejects non-positive and non-integer record numbers", () => {
    expect(() => workRecordIdentifier("plan", 0)).toThrow(/positive integer/);
    expect(() => workRecordIdentifier("defect", 1.5)).toThrow(/positive integer/);
  });
});

describe("G1 work-record planning and defect fields", () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("accepts ordered planned dates, priority, discovery version, one description, and severity on defect records", () => {
    const foundInVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "defect",
      title: "Checkout fails",
      priority: "critical",
      foundInVersionId,
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      description: "Custom defect template content.",
    })).toMatchObject({
      priority: "critical",
      foundInVersionId,
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
    });
  });

  it("keeps priority optional at the API boundary and rejects discovery versions on plan records", () => {
    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "defect",
      title: "Default priority defect",
    }).priority).toBeUndefined();

    expect(() => createWorkRecordSchema.parse({
      projectId,
      kind: "plan",
      title: "Plan cannot have a discovery version",
      foundInVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).toThrow(/Defect fields require a defect record/);

    expect(() => createWorkRecordSchema.parse({
      projectId,
      kind: "defect",
      title: "Invalid priority",
      priority: "urgent",
    })).toThrow();
  });

  it("rejects reversed planned dates and defect-only fields on plan records", () => {
    expect(createWorkRecordSchema.safeParse({
      projectId,
      kind: "plan",
      title: "Invalid plan",
      plannedStartDate: "2026-11-12",
      plannedCompletionDate: "2026-11-10",
      defectSeverity: "critical",
    }).success).toBe(false);
  });

  it("allows update payloads to set or clear every new field", () => {
    expect(updateWorkRecordSchema.parse({
      expectedRevision: 2,
      plannedStartDate: null,
      plannedCompletionDate: "2026-11-20",
      defectSeverity: null,
      priority: "low",
      foundInVersionId: null,
    })).toMatchObject({ expectedRevision: 2, plannedStartDate: null, defectSeverity: null, priority: "low", foundInVersionId: null });
  });
});

describe("Gantt personal view configuration", () => {
  it("accepts its own title-frozen default without an id column", () => {
    const config = defaultWorkRecordViewConfig("gantt");
    expect(validateWorkRecordViewConfig("gantt", config)).toEqual(config);
    expect(config.frozenFields).toEqual(["title"]);
    expect(config.visibleFields).toEqual(["title", "assignee", "businessStatus"]);
    expect(config.columnWidths).toEqual({ title: 200, assignee: 90, businessStatus: 90 });
  });

  it("rejects a Gantt view that hides the required title column", () => {
    const config = defaultWorkRecordViewConfig("gantt");
    config.visibleFields = config.visibleFields.filter((field) => field !== "title");
    expect(() => validateWorkRecordViewConfig("gantt", config)).toThrow(/title visible/);
  });
});

describe("dense work-record defaults", () => {
  it.each(["plan", "defect"] as const)("uses compact rows for the built-in %s view", (kind) => {
    expect(defaultWorkRecordViewConfig(kind).density).toBe("compact");
  });

  it("keeps version and priority separate and exposes defect discovery fields", () => {
    const plan = defaultWorkRecordViewConfig("plan");
    const defect = defaultWorkRecordViewConfig("defect");

    expect(plan.columnOrder).toEqual(expect.arrayContaining(["priority", "version", "iteration"]));
    expect(plan.columnOrder.indexOf("version")).toBeLessThan(plan.columnOrder.indexOf("iteration"));
    expect(plan.visibleFields).toEqual([
      "id", "title", "businessStatus", "assignee", "priority", "plannedStartDate", "plannedCompletionDate",
      "dependencies", "version", "iteration", "dispatchState",
    ]);
    expect(plan.columnWidths).toMatchObject({ id: 100, title: 370, dependencies: 280, dispatchState: 70 });
    expect(defect.columnOrder).toEqual(expect.arrayContaining(["priority", "defectSeverity", "foundInVersion"]));
    expect(defect.visibleFields).toEqual([
      "id", "title", "businessStatus", "assignee", "qaAssignee", "priority", "defectSeverity",
      "foundInVersion", "plannedCompletionDate", "version", "iteration",
    ]);
    expect(defect.columnWidths).toEqual({
      id: 100, title: 330, businessStatus: 110, assignee: 110, qaAssignee: 110,
      priority: 90, defectSeverity: 100, foundInVersion: 150, plannedCompletionDate: 150,
      version: 160, iteration: 180,
    });
    expect(defect.visibleFields).not.toEqual(expect.arrayContaining(["description", "plannedStartDate", "dependencies", "dispatchState"]));
  });
});

describe("work-record iteration assignment contract", () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const parentRecordId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const iterationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("exposes only inherit-parent and independent modes", () => {
    expect(WORK_RECORD_ITERATION_ASSIGNMENT_MODES).toEqual([
      "inherit_parent",
      "independent",
    ]);
  });

  it("defaults top-level records to independent and child records to inherit-parent", () => {
    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "plan",
      title: "Top-level work package",
    }).iterationAssignmentMode).toBe("independent");

    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "plan",
      title: "Inherited child",
      parentRecordId,
    }).iterationAssignmentMode).toBe("inherit_parent");
  });

  it("rejects inheritance without a parent and an explicit iteration on inherited records", () => {
    expect(createWorkRecordSchema.safeParse({
      projectId,
      kind: "plan",
      title: "Parentless inheritance",
      iterationAssignmentMode: "inherit_parent",
    }).success).toBe(false);
    expect(createWorkRecordSchema.safeParse({
      projectId,
      kind: "plan",
      title: "Conflicting inherited child",
      parentRecordId,
      iterationAssignmentMode: "inherit_parent",
      iterationId,
    }).success).toBe(false);
  });

  it("accepts switching an existing record to independent with an explicit iteration", () => {
    expect(updateWorkRecordSchema.parse({
      expectedRevision: 3,
      iterationAssignmentMode: "independent",
      iterationId,
    })).toMatchObject({
      iterationAssignmentMode: "independent",
      iterationId,
    });
  });

  it("rejects an explicit iteration while switching to inheritance", () => {
    expect(updateWorkRecordSchema.safeParse({
      expectedRevision: 3,
      iterationAssignmentMode: "inherit_parent",
      iterationId,
    }).success).toBe(false);
  });
});

describe("FID-05 version-scoped iteration contract", () => {
  const versionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("requires a non-null version for both iteration creation and updates", () => {
    expect(createProjectIterationSchema.safeParse({ name: "Sprint 1" }).success).toBe(false);
    expect(createProjectIterationSchema.safeParse({ versionId: null, name: "Sprint 1" }).success).toBe(false);
    expect(createProjectIterationSchema.parse({ versionId, name: "Sprint 1" })).toMatchObject({ versionId });

    expect(updateProjectIterationSchema.safeParse({ expectedRevision: 1, name: "Sprint 2" }).success).toBe(false);
    expect(updateProjectIterationSchema.safeParse({ expectedRevision: 1, versionId: null, name: "Sprint 2" }).success).toBe(false);
    expect(updateProjectIterationSchema.parse({ expectedRevision: 1, versionId, name: "Sprint 2" })).toMatchObject({ versionId });
  });
});
