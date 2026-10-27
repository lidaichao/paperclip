DROP INDEX "work_record_issue_links_issue_purpose_uq";--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "payload_digest" text NOT NULL;--> statement-breakpoint
CREATE INDEX "work_record_issue_links_issue_purpose_idx" ON "work_record_issue_links" USING btree ("company_id","issue_id","purpose");