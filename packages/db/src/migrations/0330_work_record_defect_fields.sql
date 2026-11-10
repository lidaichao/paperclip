ALTER TABLE "work_records" DROP CONSTRAINT "work_records_defect_fields_check";--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "found_in_version_id" uuid;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_found_in_version_scope_fk" FOREIGN KEY ("company_id","project_id","found_in_version_id") REFERENCES "public"."project_versions"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_records_project_found_in_version_idx" ON "work_records" USING btree ("company_id","project_id","found_in_version_id");--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_priority_check" CHECK ("work_records"."priority" IN ('critical', 'high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_defect_fields_check" CHECK ("work_records"."kind" = 'defect' OR ("work_records"."defect_severity" IS NULL AND "work_records"."found_in_version_id" IS NULL));