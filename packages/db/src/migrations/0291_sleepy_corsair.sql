ALTER TABLE "work_record_quality_links" ADD COLUMN "request_payload_digest" text;--> statement-breakpoint
UPDATE "work_record_quality_links"
SET "request_payload_digest" = "link_key"
WHERE "request_payload_digest" IS NULL;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ALTER COLUMN "request_payload_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "qa_assignee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_qa_assignee_agent_id_agents_id_fk" FOREIGN KEY ("qa_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_qa_assignee_scope_fk" FOREIGN KEY ("company_id","qa_assignee_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;
