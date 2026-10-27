CREATE TABLE "project_iterations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid,
	"name" text NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_date" date,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_record_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_record_id" uuid NOT NULL,
	"successor_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_dependencies_not_self" CHECK ("work_record_dependencies"."predecessor_record_id" <> "work_record_dependencies"."successor_record_id")
);
--> statement-breakpoint
CREATE TABLE "work_record_dispatch_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"client_request_id" text NOT NULL,
	"record_revision" integer NOT NULL,
	"dispatch_round" integer NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"issue_link_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_record_execution_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"dependent_record_id" uuid NOT NULL,
	"dependent_issue_id" uuid NOT NULL,
	"blocking_record_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"dispatch_round" integer NOT NULL,
	"dependency_set_revision" integer NOT NULL,
	"blocked_cycle" integer NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_record_execution_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"issue_status" text NOT NULL,
	"issue_status_version" bigint DEFAULT 0 NOT NULL,
	"last_run_id" uuid,
	"last_event_cursor" bigint DEFAULT 0 NOT NULL,
	"sync_state" text DEFAULT 'current' NOT NULL,
	"sync_error" text,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_record_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"purpose" text DEFAULT 'primary' NOT NULL,
	"dispatch_round" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_record_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text DEFAULT 'release' NOT NULL,
	"dispatch_round" integer NOT NULL,
	"dependency_set_revision" integer NOT NULL,
	"blocked_cycle" integer NOT NULL,
	"payload" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_record_id" uuid,
	"iteration_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"description_revision" integer DEFAULT 1 NOT NULL,
	"assignee_agent_id" uuid,
	"business_status" text DEFAULT 'backlog' NOT NULL,
	"status_version" bigint DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"dispatch_state" text DEFAULT 'not_dispatched' NOT NULL,
	"dispatch_round" integer DEFAULT 0 NOT NULL,
	"dependency_set_revision" integer DEFAULT 1 NOT NULL,
	"blocked_cycle" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_records_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_records_parent_not_self" CHECK ("work_records"."parent_record_id" IS NULL OR "work_records"."parent_record_id" <> "work_records"."id")
);
--> statement-breakpoint
ALTER TABLE "project_iterations" ADD CONSTRAINT "project_iterations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_iterations" ADD CONSTRAINT "project_iterations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_iterations" ADD CONSTRAINT "project_iterations_version_id_project_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependencies" ADD CONSTRAINT "work_record_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependencies" ADD CONSTRAINT "work_record_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependencies" ADD CONSTRAINT "work_record_dependencies_predecessor_record_id_work_records_id_fk" FOREIGN KEY ("predecessor_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependencies" ADD CONSTRAINT "work_record_dependencies_successor_record_id_work_records_id_fk" FOREIGN KEY ("successor_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_commands" ADD CONSTRAINT "work_record_dispatch_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_commands" ADD CONSTRAINT "work_record_dispatch_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_commands" ADD CONSTRAINT "work_record_dispatch_commands_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_holds" ADD CONSTRAINT "work_record_execution_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_holds" ADD CONSTRAINT "work_record_execution_holds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_holds" ADD CONSTRAINT "work_record_execution_holds_dependent_record_id_work_records_id_fk" FOREIGN KEY ("dependent_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_holds" ADD CONSTRAINT "work_record_execution_holds_dependent_issue_id_issues_id_fk" FOREIGN KEY ("dependent_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_holds" ADD CONSTRAINT "work_record_execution_holds_blocking_record_id_work_records_id_fk" FOREIGN KEY ("blocking_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_projections" ADD CONSTRAINT "work_record_execution_projections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_projections" ADD CONSTRAINT "work_record_execution_projections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_projections" ADD CONSTRAINT "work_record_execution_projections_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_projections" ADD CONSTRAINT "work_record_execution_projections_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_projections" ADD CONSTRAINT "work_record_execution_projections_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_issue_links" ADD CONSTRAINT "work_record_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_issue_links" ADD CONSTRAINT "work_record_issue_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_issue_links" ADD CONSTRAINT "work_record_issue_links_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_issue_links" ADD CONSTRAINT "work_record_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_iteration_id_project_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."project_iterations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_iterations_project_name_uq" ON "project_iterations" USING btree ("company_id","project_id","name");--> statement-breakpoint
CREATE INDEX "project_iterations_company_project_idx" ON "project_iterations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_versions_project_name_uq" ON "project_versions" USING btree ("company_id","project_id","name");--> statement-breakpoint
CREATE INDEX "project_versions_company_project_idx" ON "project_versions" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_dependencies_edge_uq" ON "work_record_dependencies" USING btree ("company_id","project_id","predecessor_record_id","successor_record_id");--> statement-breakpoint
CREATE INDEX "work_record_dependencies_successor_idx" ON "work_record_dependencies" USING btree ("company_id","successor_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_dispatch_commands_request_uq" ON "work_record_dispatch_commands" USING btree ("company_id","record_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_holds_uq" ON "work_record_execution_holds" USING btree ("company_id","dependent_record_id","blocking_record_id","dispatch_round","dependency_set_revision","blocked_cycle");--> statement-breakpoint
CREATE INDEX "work_record_execution_holds_issue_unresolved_idx" ON "work_record_execution_holds" USING btree ("company_id","dependent_issue_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_projections_record_uq" ON "work_record_execution_projections" USING btree ("company_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_projections_issue_uq" ON "work_record_execution_projections" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_issue_links_record_purpose_uq" ON "work_record_issue_links" USING btree ("company_id","record_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_issue_links_issue_purpose_uq" ON "work_record_issue_links" USING btree ("company_id","issue_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_outbox_event_key_uq" ON "work_record_outbox" USING btree ("company_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_outbox_release_uq" ON "work_record_outbox" USING btree ("company_id","record_id","dispatch_round","dependency_set_revision","blocked_cycle","event_type");--> statement-breakpoint
CREATE INDEX "work_record_outbox_pending_idx" ON "work_record_outbox" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "work_records_company_project_idx" ON "work_records" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial index covers only new work-record release keys, so existing rows cannot enter it during upgrade
CREATE UNIQUE INDEX "agent_wakeup_requests_work_record_release_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'work-record-release:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');
