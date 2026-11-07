CREATE TABLE "local_run_finish_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"client_request_id" uuid,
	"request_digest" text,
	"outcome" text NOT NULL,
	"exit_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_run_finish_receipts_request_pair_check" CHECK (
    ("local_run_finish_receipts"."client_request_id" IS NULL AND "local_run_finish_receipts"."request_digest" IS NULL) OR
    ("local_run_finish_receipts"."client_request_id" IS NOT NULL AND "local_run_finish_receipts"."request_digest" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "local_run_finish_receipts_outcome_check" CHECK ("local_run_finish_receipts"."outcome" IN ('succeeded','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "local_run_finish_receipts" ADD CONSTRAINT "local_run_finish_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_run_finish_receipts" ADD CONSTRAINT "local_run_finish_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_run_finish_receipts" ADD CONSTRAINT "local_run_finish_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_run_finish_receipts_run_uq" ON "local_run_finish_receipts" USING btree ("company_id","run_id");
