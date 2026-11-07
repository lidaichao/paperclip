ALTER TABLE "local_defect_repair_handoffs" ADD COLUMN "qa_wakeup_request_id" uuid;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD COLUMN "qa_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_qa_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("qa_wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, and this new defect-qa key prefix has no historical rows; the uniqueness gate must commit before the first QA wake writer.
CREATE UNIQUE INDEX "agent_wakeup_requests_independent_defect_qa_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'defect-qa:%';--> statement-breakpoint
CREATE UNIQUE INDEX "local_defect_repair_handoffs_qa_wakeup_uq" ON "local_defect_repair_handoffs" USING btree ("qa_wakeup_request_id") WHERE "local_defect_repair_handoffs"."qa_wakeup_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_qa_delivery_check" CHECK (
    ("local_defect_repair_handoffs"."qa_wakeup_request_id" IS NULL AND "local_defect_repair_handoffs"."qa_delivered_at" IS NULL) OR
    ("local_defect_repair_handoffs"."state" = 'submitted' AND "local_defect_repair_handoffs"."qa_wakeup_request_id" IS NOT NULL AND "local_defect_repair_handoffs"."qa_delivered_at" IS NOT NULL));
