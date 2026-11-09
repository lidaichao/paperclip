import { describe, expect, it } from "vitest";
import { createWorkRecordSchema, defaultWorkRecordViewConfig, updateWorkRecordSchema, validateWorkRecordViewConfig } from "./work-records.js";

describe("G1 work-record planning and defect fields", () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("accepts ordered planned dates, one description, and severity on defect records", () => {
    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "defect",
      title: "Checkout fails",
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      description: "Custom defect template content.",
    })).toMatchObject({
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
    });
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
    })).toMatchObject({ expectedRevision: 2, plannedStartDate: null, defectSeverity: null });
  });
});

describe("Gantt personal view configuration", () => {
  it("accepts its own title-frozen default without an id column", () => {
    const config = defaultWorkRecordViewConfig("gantt");
    expect(validateWorkRecordViewConfig("gantt", config)).toEqual(config);
    expect(config.frozenFields).toEqual(["title"]);
    expect(config.visibleFields).toEqual(["title", "assignee", "businessStatus"]);
  });

  it("rejects a Gantt view that hides the required title column", () => {
    const config = defaultWorkRecordViewConfig("gantt");
    config.visibleFields = config.visibleFields.filter((field) => field !== "title");
    expect(() => validateWorkRecordViewConfig("gantt", config)).toThrow(/title visible/);
  });
});
