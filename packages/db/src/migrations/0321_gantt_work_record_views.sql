ALTER TABLE "work_record_view_preferences" DROP CONSTRAINT "work_record_view_preferences_view_kind_check";--> statement-breakpoint
ALTER TABLE "work_record_view_preferences" ADD CONSTRAINT "work_record_view_preferences_view_kind_check" CHECK ("work_record_view_preferences"."view_kind" IN ('plan', 'defect', 'gantt'));
