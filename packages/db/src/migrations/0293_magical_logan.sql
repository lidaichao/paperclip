CREATE TABLE "work_record_assignment_gap_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"root_record_id" uuid,
	"scope_kind" text NOT NULL,
	"scope_digest" text NOT NULL,
	"client_request_id" text NOT NULL,
	"request_payload_digest" text NOT NULL,
	"blockers" jsonb NOT NULL,
	"missing_record_ids" jsonb NOT NULL,
	"target_ceo_agent_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"wakeup_request_id" uuid,
	"delivery_error_code" text,
	"delivered_at" timestamp with time zone,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_assignment_gap_escalations_state_check" CHECK ("work_record_assignment_gap_escalations"."state" IN ('pending', 'delivering', 'delivered', 'ceo_unavailable', 'delivery_failed'))
);
--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_root_record_id_work_records_id_fk" FOREIGN KEY ("root_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_target_ceo_agent_id_agents_id_fk" FOREIGN KEY ("target_ceo_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_root_scope_fk" FOREIGN KEY ("company_id","project_id","root_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_gap_escalations" ADD CONSTRAINT "work_record_assignment_gap_escalations_target_ceo_scope_fk" FOREIGN KEY ("company_id","target_ceo_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_assignment_gap_escalations_request_uq" ON "work_record_assignment_gap_escalations" USING btree ("company_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_assignment_gap_escalations_scope_uq" ON "work_record_assignment_gap_escalations" USING btree ("company_id","project_id","scope_digest");--> statement-breakpoint
CREATE INDEX "work_record_assignment_gap_escalations_root_created_idx" ON "work_record_assignment_gap_escalations" USING btree ("company_id","project_id","root_record_id","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional migrations cannot use CONCURRENTLY; this partial index covers only the new work-record assignment-gap key namespace, so existing deployments have no matching rows.
CREATE UNIQUE INDEX "agent_wakeup_requests_work_record_assignment_gap_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'work-record-assignment-gap:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');
