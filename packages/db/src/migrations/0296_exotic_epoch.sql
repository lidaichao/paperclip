CREATE TABLE "local_agent_run_leases" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"lease_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"stop_acknowledged_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_agent_run_leases_generation_check" CHECK ("local_agent_run_leases"."generation" >= 1),
	CONSTRAINT "local_agent_run_leases_outcome_check" CHECK ("local_agent_run_leases"."outcome" is null or "local_agent_run_leases"."outcome" in ('succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "local_agent_run_leases" ADD CONSTRAINT "local_agent_run_leases_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_run_leases" ADD CONSTRAINT "local_agent_run_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_run_leases" ADD CONSTRAINT "local_agent_run_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_run_leases" ADD CONSTRAINT "local_agent_run_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_run_leases_active_agent_uq" ON "local_agent_run_leases" USING btree ("company_id","agent_id") WHERE "local_agent_run_leases"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_run_leases_active_issue_uq" ON "local_agent_run_leases" USING btree ("company_id","issue_id") WHERE "local_agent_run_leases"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_run_leases_claim_idempotency_uq" ON "local_agent_run_leases" USING btree ("company_id","agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "local_agent_run_leases_company_expiry_idx" ON "local_agent_run_leases" USING btree ("company_id","expires_at");