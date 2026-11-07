ALTER TABLE "work_record_description_deliveries" DROP CONSTRAINT "work_record_description_deliveries_state_check";--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "successor_run_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "wakeup_request_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "stop_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "model_visible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "work_record_description_deliveries"
SET
  "state" = CASE
    WHEN "state" = 'delivering' THEN 'stopping'
    WHEN "state" = 'delivered' THEN 'queued'
    WHEN "state" = 'acknowledged' THEN 'confirmed'
    ELSE "state"
  END,
  "queued_at" = CASE WHEN "state" IN ('delivered', 'acknowledged') THEN COALESCE("delivered_at", "updated_at") ELSE NULL END,
  "model_visible_at" = CASE WHEN "state" = 'acknowledged' THEN COALESCE("acknowledged_at", "updated_at") ELSE NULL END,
  "confirmed_at" = CASE WHEN "state" = 'acknowledged' THEN COALESCE("acknowledged_at", "updated_at") ELSE NULL END;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_successor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("successor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_state_check" CHECK ("work_record_description_deliveries"."state" IN ('pending', 'stopping', 'queued', 'retry', 'confirmed'));
