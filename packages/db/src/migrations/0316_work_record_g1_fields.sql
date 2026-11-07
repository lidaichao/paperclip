ALTER TABLE "work_records" ADD COLUMN "planned_start_date" date;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "planned_completion_date" date;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "defect_severity" text;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "defect_reproduction_steps" text;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "defect_expected_result" text;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "defect_actual_result" text;--> statement-breakpoint
CREATE INDEX "work_records_project_planned_dates_idx" ON "work_records" USING btree ("company_id","project_id","planned_start_date","planned_completion_date");--> statement-breakpoint
CREATE INDEX "work_records_project_defect_severity_idx" ON "work_records" USING btree ("company_id","project_id","defect_severity");--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_planned_dates_check" CHECK ("work_records"."planned_start_date" IS NULL OR "work_records"."planned_completion_date" IS NULL OR "work_records"."planned_start_date" <= "work_records"."planned_completion_date");--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_defect_severity_check" CHECK ("work_records"."defect_severity" IS NULL OR "work_records"."defect_severity" IN ('critical', 'high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_defect_fields_check" CHECK ("work_records"."kind" = 'defect' OR ("work_records"."defect_severity" IS NULL AND "work_records"."defect_reproduction_steps" IS NULL AND "work_records"."defect_expected_result" IS NULL AND "work_records"."defect_actual_result" IS NULL));