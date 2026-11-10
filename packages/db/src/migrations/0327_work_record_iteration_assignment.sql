ALTER TABLE "work_records" ADD COLUMN "iteration_assignment_mode" text;--> statement-breakpoint
UPDATE "work_records" SET "iteration_assignment_mode" = 'independent' WHERE "iteration_assignment_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "work_records" ALTER COLUMN "iteration_assignment_mode" SET DEFAULT 'independent';--> statement-breakpoint
ALTER TABLE "work_records" ALTER COLUMN "iteration_assignment_mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_iteration_assignment_mode_check" CHECK ("work_records"."iteration_assignment_mode" IN ('inherit_parent', 'independent'));--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_iteration_inheritance_parent_check" CHECK ("work_records"."iteration_assignment_mode" <> 'inherit_parent' OR "work_records"."parent_record_id" IS NOT NULL);
