ALTER TABLE "work_records"
  DROP CONSTRAINT "work_records_iteration_inheritance_parent_check",
  DROP CONSTRAINT "work_records_iteration_assignment_mode_check";
--> statement-breakpoint
ALTER TABLE "work_records" DROP COLUMN "iteration_assignment_mode";
