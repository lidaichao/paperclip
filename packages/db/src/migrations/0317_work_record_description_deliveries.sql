CREATE TABLE "work_record_description_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"description_revision" integer NOT NULL,
	"intent_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_agent_id" uuid,
	"acknowledged_by_run_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_description_deliveries_state_check" CHECK ("work_record_description_deliveries"."state" IN ('pending', 'delivering', 'delivered', 'retry', 'acknowledged')),
	CONSTRAINT "work_record_description_deliveries_revision_check" CHECK ("work_record_description_deliveries"."description_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_acknowledged_by_agent_id_agents_id_fk" FOREIGN KEY ("acknowledged_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_acknowledged_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("acknowledged_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_record_scope_fk" FOREIGN KEY ("company_id","project_id","record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_issue_scope_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_description_deliveries_revision_uq" ON "work_record_description_deliveries" USING btree ("company_id","record_id","description_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_description_deliveries_intent_uq" ON "work_record_description_deliveries" USING btree ("company_id","intent_key");--> statement-breakpoint
CREATE INDEX "work_record_description_deliveries_pending_idx" ON "work_record_description_deliveries" USING btree ("state","updated_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, and this new work-record-description key prefix has no historical rows; the uniqueness gate must commit before the first description-delivery wake writer.
CREATE UNIQUE INDEX "agent_wakeup_requests_work_record_description_delivery_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'work-record-description:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');
