ALTER TABLE "work_records" DROP CONSTRAINT "work_records_found_in_version_scope_fk";
--> statement-breakpoint
DROP INDEX "work_records_project_found_in_version_idx";
--> statement-breakpoint
ALTER TABLE "work_records" DROP CONSTRAINT "work_records_priority_check";
--> statement-breakpoint
ALTER TABLE "work_records" DROP CONSTRAINT "work_records_defect_fields_check";
--> statement-breakpoint
ALTER TABLE "work_records" DROP COLUMN "found_in_version_id";
--> statement-breakpoint
ALTER TABLE "work_records" DROP COLUMN "priority";
--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_defect_fields_check"
  CHECK ("work_records"."kind" = 'defect' OR "work_records"."defect_severity" IS NULL);
