ALTER TABLE "work_records"
  DROP CONSTRAINT "work_records_defect_fields_check",
  DROP CONSTRAINT "work_records_defect_severity_check",
  DROP CONSTRAINT "work_records_planned_dates_check";
--> statement-breakpoint
DROP INDEX "work_records_project_defect_severity_idx";
--> statement-breakpoint
DROP INDEX "work_records_project_planned_dates_idx";
--> statement-breakpoint
ALTER TABLE "work_records"
  DROP COLUMN "defect_severity",
  DROP COLUMN "planned_completion_date",
  DROP COLUMN "planned_start_date";
