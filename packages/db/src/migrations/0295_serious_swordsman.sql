ALTER TABLE "work_record_outbox" ADD COLUMN "recovery_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "last_recovered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "work_record_outbox_project_state_idx" ON "work_record_outbox" USING btree ("company_id","project_id","state","available_at","id");--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_state_check" CHECK ("work_record_outbox"."state" IN ('pending', 'processing', 'retry', 'delivered', 'superseded', 'dead_letter'));