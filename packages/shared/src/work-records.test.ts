import { describe, expect, it } from "vitest";
import { createWorkRecordSchema, updateWorkRecordSchema } from "./work-records.js";

describe("G1 work-record planning and defect fields", () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("accepts ordered planned dates and defect details on defect records", () => {
    expect(createWorkRecordSchema.parse({
      projectId,
      kind: "defect",
      title: "Checkout fails",
      plannedStartDate: "2026-11-10",
      plannedCompletionDate: "2026-11-12",
      defectSeverity: "high",
      defectReproductionSteps: "Open checkout and submit a valid cart.",
      defectExpectedResult: "Order is created.",
      defectActualResult: "The request returns 500.",
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
      defectReproductionSteps: null,
      defectExpectedResult: null,
      defectActualResult: null,
    })).toMatchObject({ expectedRevision: 2, plannedStartDate: null, defectSeverity: null });
  });
});
