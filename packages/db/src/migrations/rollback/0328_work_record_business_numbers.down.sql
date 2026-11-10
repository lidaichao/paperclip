ALTER TABLE "work_records" DROP CONSTRAINT IF EXISTS "work_records_record_number_positive_check";
--> statement-breakpoint
ALTER TABLE "work_records" DROP CONSTRAINT IF EXISTS "work_records_company_project_kind_record_number_unique";
--> statement-breakpoint
ALTER TABLE "work_records" DROP COLUMN IF EXISTS "record_number";
--> statement-breakpoint
DROP TABLE IF EXISTS "work_record_counters";
