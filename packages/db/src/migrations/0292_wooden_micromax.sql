CREATE TABLE "work_record_assignment_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"client_request_id" text NOT NULL,
	"request_payload_digest" text NOT NULL,
	"expected_record_revision" integer NOT NULL,
	"expected_assignee_agent_id" uuid,
	"assignee_agent_id" uuid NOT NULL,
	"approval_id" uuid,
	"previous_revision" integer NOT NULL,
	"resulting_revision" integer NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_expected_assignee_agent_id_agents_id_fk" FOREIGN KEY ("expected_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_record_scope_fk" FOREIGN KEY ("company_id","project_id","record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_assignee_scope_fk" FOREIGN KEY ("company_id","assignee_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_assignment_commands" ADD CONSTRAINT "work_record_assignment_commands_expected_assignee_scope_fk" FOREIGN KEY ("company_id","expected_assignee_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_assignment_commands_request_uq" ON "work_record_assignment_commands" USING btree ("company_id","record_id","client_request_id");