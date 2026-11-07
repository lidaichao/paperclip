CREATE TABLE "local_run_write_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"source_receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_run_write_receipts_kind_check" CHECK ("local_run_write_receipts"."kind" in (
    'child_complete', 'defect_repair_handoff', 'po_verdict',
    'defect_qa_verdict', 'completion_review_handoff')),
	CONSTRAINT "local_run_write_receipts_digest_check" CHECK ("local_run_write_receipts"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "local_run_write_receipts" ADD CONSTRAINT "local_run_write_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_run_write_receipts" ADD CONSTRAINT "local_run_write_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_run_write_receipts" ADD CONSTRAINT "local_run_write_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_run_write_receipts" ADD CONSTRAINT "local_run_write_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_run_write_receipts_request_uq" ON "local_run_write_receipts" USING btree ("company_id","run_id","client_request_id");