ALTER TABLE "work_record_assignment_gap_escalations" DROP CONSTRAINT "work_record_assignment_gap_escalations_state_check";--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD COLUMN "delivery_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD COLUMN "wake_status" text;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD COLUMN "run_status" text;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_state_check" CHECK ("work_record_assignment_gap_escalations"."state" IN ('pending', 'delivering', 'queued', 'delivered', 'acknowledged', 'ceo_unavailable', 'delivery_failed'));