CREATE TABLE "work_record_dependency_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"predecessor_record_id" uuid NOT NULL,
	"successor_record_id" uuid NOT NULL,
	"predecessor_revision" integer NOT NULL,
	"successor_revision" integer NOT NULL,
	"predecessor_issue_link_id" uuid,
	"successor_issue_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_dependency_snapshots_not_self" CHECK ("work_record_dependency_snapshots"."predecessor_record_id" <> "work_record_dependency_snapshots"."successor_record_id")
);
--> statement-breakpoint
CREATE TABLE "work_record_dispatch_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"record_revision" integer NOT NULL,
	"inclusion_reason" text NOT NULL,
	"materialization_state" text DEFAULT 'pending' NOT NULL,
	"primary_issue_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_dispatch_batch_items_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_record_dispatch_batch_items_record_revision_check" CHECK ("work_record_dispatch_batch_items"."record_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_dispatch_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"root_record_id" uuid,
	"client_request_id" text NOT NULL,
	"request_payload_digest" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_digest" text NOT NULL,
	"root_record_revision" integer NOT NULL,
	"dependency_set_revision" integer NOT NULL,
	"workflow_version" integer DEFAULT 2 NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"error_code" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_dispatch_batches_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_record_dispatch_batches_workflow_version_check" CHECK ("work_record_dispatch_batches"."workflow_version" = 2),
	CONSTRAINT "work_record_dispatch_batches_revision_check" CHECK ("work_record_dispatch_batches"."root_record_revision" > 0 AND "work_record_dispatch_batches"."dependency_set_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_execution_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"batch_item_id" uuid,
	"quality_item_id" uuid,
	"intent_key" text NOT NULL,
	"request_payload_digest" text NOT NULL,
	"kind" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"expected_issue_status_version" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"waiting_reason" text,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_execution_intents_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_record_execution_intents_source_check" CHECK (num_nonnulls("work_record_execution_intents"."batch_item_id", "work_record_execution_intents"."quality_item_id") = 1),
	CONSTRAINT "work_record_execution_intents_generation_check" CHECK ("work_record_execution_intents"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_quality_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"aggregate_record_id" uuid NOT NULL,
	"cycle_number" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"quality_phase" text DEFAULT 'not_started' NOT NULL,
	"reason" text,
	"scope_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"opened_by_agent_id" uuid,
	"opened_by_user_id" text,
	"closed_by_agent_id" uuid,
	"closed_by_user_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_quality_cycles_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_record_quality_cycles_number_check" CHECK ("work_record_quality_cycles"."cycle_number" > 0),
	CONSTRAINT "work_record_quality_cycles_revision_check" CHECK ("work_record_quality_cycles"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_quality_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"defect_record_id" uuid,
	"role" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"issue_link_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_quality_items_company_project_id_uq" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "work_record_quality_items_revision_check" CHECK ("work_record_quality_items"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_quality_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"link_key" text NOT NULL,
	"link_kind" text NOT NULL,
	"defect_record_id" uuid NOT NULL,
	"package_record_id" uuid,
	"repair_record_id" uuid,
	"qa_record_id" uuid,
	"valid_from_cycle_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_quality_links_target_check" CHECK ("work_record_quality_links"."package_record_id" IS NOT NULL OR "work_record_quality_links"."repair_record_id" IS NOT NULL OR "work_record_quality_links"."qa_record_id" IS NOT NULL),
	CONSTRAINT "work_record_quality_links_cycle_number_check" CHECK ("work_record_quality_links"."valid_from_cycle_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_record_quality_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"defect_record_id" uuid,
	"client_request_id" text NOT NULL,
	"request_payload_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "work_record_outbox_release_uq";--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "workflow_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "quality_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "quality_item_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD COLUMN "execution_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "work_record_issue_links" ADD CONSTRAINT "work_record_issue_links_company_project_id_uq" UNIQUE("company_id","project_id","id");--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_batch_id_work_record_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."work_record_dispatch_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_predecessor_record_id_work_records_id_fk" FOREIGN KEY ("predecessor_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_successor_record_id_work_records_id_fk" FOREIGN KEY ("successor_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_predecessor_issue_link_id_work_record_issue_links_id_fk" FOREIGN KEY ("predecessor_issue_link_id") REFERENCES "public"."work_record_issue_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_successor_issue_link_id_work_record_issue_links_id_fk" FOREIGN KEY ("successor_issue_link_id") REFERENCES "public"."work_record_issue_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_batch_scope_fk" FOREIGN KEY ("company_id","project_id","batch_id") REFERENCES "public"."work_record_dispatch_batches"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_predecessor_scope_fk" FOREIGN KEY ("company_id","project_id","predecessor_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_successor_scope_fk" FOREIGN KEY ("company_id","project_id","successor_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_predecessor_link_scope_fk" FOREIGN KEY ("company_id","project_id","predecessor_issue_link_id") REFERENCES "public"."work_record_issue_links"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dependency_snapshots" ADD CONSTRAINT "work_record_dependency_snapshots_successor_link_scope_fk" FOREIGN KEY ("company_id","project_id","successor_issue_link_id") REFERENCES "public"."work_record_issue_links"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_batch_id_work_record_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."work_record_dispatch_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_primary_issue_link_id_work_record_issue_links_id_fk" FOREIGN KEY ("primary_issue_link_id") REFERENCES "public"."work_record_issue_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_batch_scope_fk" FOREIGN KEY ("company_id","project_id","batch_id") REFERENCES "public"."work_record_dispatch_batches"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_record_scope_fk" FOREIGN KEY ("company_id","project_id","record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batch_items" ADD CONSTRAINT "work_record_dispatch_batch_items_issue_link_scope_fk" FOREIGN KEY ("company_id","project_id","primary_issue_link_id") REFERENCES "public"."work_record_issue_links"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_root_record_id_work_records_id_fk" FOREIGN KEY ("root_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_project_scope_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_dispatch_batches" ADD CONSTRAINT "work_record_dispatch_batches_root_record_scope_fk" FOREIGN KEY ("company_id","project_id","root_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_batch_item_id_work_record_dispatch_batch_items_id_fk" FOREIGN KEY ("batch_item_id") REFERENCES "public"."work_record_dispatch_batch_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_quality_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("quality_item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_record_scope_fk" FOREIGN KEY ("company_id","project_id","record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_issue_scope_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_batch_item_scope_fk" FOREIGN KEY ("company_id","project_id","batch_item_id") REFERENCES "public"."work_record_dispatch_batch_items"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_execution_intents" ADD CONSTRAINT "work_record_execution_intents_quality_item_scope_fk" FOREIGN KEY ("company_id","project_id","quality_item_id") REFERENCES "public"."work_record_quality_items"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_aggregate_record_id_work_records_id_fk" FOREIGN KEY ("aggregate_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_opened_by_agent_id_agents_id_fk" FOREIGN KEY ("opened_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_closed_by_agent_id_agents_id_fk" FOREIGN KEY ("closed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_cycles" ADD CONSTRAINT "work_record_quality_cycles_aggregate_scope_fk" FOREIGN KEY ("company_id","project_id","aggregate_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_cycle_id_work_record_quality_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."work_record_quality_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_defect_record_id_work_records_id_fk" FOREIGN KEY ("defect_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_issue_link_id_work_record_issue_links_id_fk" FOREIGN KEY ("issue_link_id") REFERENCES "public"."work_record_issue_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_cycle_scope_fk" FOREIGN KEY ("company_id","project_id","cycle_id") REFERENCES "public"."work_record_quality_cycles"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_record_scope_fk" FOREIGN KEY ("company_id","project_id","record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_defect_scope_fk" FOREIGN KEY ("company_id","project_id","defect_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_items" ADD CONSTRAINT "work_record_quality_items_issue_link_scope_fk" FOREIGN KEY ("company_id","project_id","issue_link_id") REFERENCES "public"."work_record_issue_links"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_defect_record_id_work_records_id_fk" FOREIGN KEY ("defect_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_package_record_id_work_records_id_fk" FOREIGN KEY ("package_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_repair_record_id_work_records_id_fk" FOREIGN KEY ("repair_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_qa_record_id_work_records_id_fk" FOREIGN KEY ("qa_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_defect_scope_fk" FOREIGN KEY ("company_id","project_id","defect_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_package_scope_fk" FOREIGN KEY ("company_id","project_id","package_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_repair_scope_fk" FOREIGN KEY ("company_id","project_id","repair_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_links" ADD CONSTRAINT "work_record_quality_links_qa_scope_fk" FOREIGN KEY ("company_id","project_id","qa_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_cycle_id_work_record_quality_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."work_record_quality_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_defect_record_id_work_records_id_fk" FOREIGN KEY ("defect_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_cycle_scope_fk" FOREIGN KEY ("company_id","project_id","cycle_id") REFERENCES "public"."work_record_quality_cycles"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_item_scope_fk" FOREIGN KEY ("company_id","project_id","item_id") REFERENCES "public"."work_record_quality_items"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_quality_verdicts" ADD CONSTRAINT "work_record_quality_verdicts_defect_scope_fk" FOREIGN KEY ("company_id","project_id","defect_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_dependency_snapshots_edge_uq" ON "work_record_dependency_snapshots" USING btree ("company_id","project_id","batch_id","predecessor_record_id","successor_record_id");--> statement-breakpoint
CREATE INDEX "work_record_dependency_snapshots_batch_idx" ON "work_record_dependency_snapshots" USING btree ("company_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_dispatch_batch_items_record_uq" ON "work_record_dispatch_batch_items" USING btree ("company_id","project_id","batch_id","record_id");--> statement-breakpoint
CREATE INDEX "work_record_dispatch_batch_items_batch_state_idx" ON "work_record_dispatch_batch_items" USING btree ("company_id","batch_id","materialization_state");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_dispatch_batches_request_uq" ON "work_record_dispatch_batches" USING btree ("company_id","client_request_id");--> statement-breakpoint
CREATE INDEX "work_record_dispatch_batches_project_state_idx" ON "work_record_dispatch_batches" USING btree ("company_id","project_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_intents_key_uq" ON "work_record_execution_intents" USING btree ("company_id","intent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_intents_batch_item_uq" ON "work_record_execution_intents" USING btree ("company_id","batch_item_id") WHERE "work_record_execution_intents"."batch_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_intents_quality_item_uq" ON "work_record_execution_intents" USING btree ("company_id","quality_item_id") WHERE "work_record_execution_intents"."quality_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_execution_intents_active_issue_uq" ON "work_record_execution_intents" USING btree ("company_id","issue_id") WHERE "work_record_execution_intents"."state" IN ('pending', 'waiting_dependencies', 'waiting_governance', 'ready', 'queued', 'running');--> statement-breakpoint
CREATE INDEX "work_record_execution_intents_state_idx" ON "work_record_execution_intents" USING btree ("company_id","project_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_quality_cycles_number_uq" ON "work_record_quality_cycles" USING btree ("company_id","project_id","aggregate_record_id","cycle_number");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_quality_cycles_active_uq" ON "work_record_quality_cycles" USING btree ("company_id","project_id","aggregate_record_id") WHERE "work_record_quality_cycles"."state" = 'open';--> statement-breakpoint
CREATE INDEX "work_record_quality_cycles_project_phase_idx" ON "work_record_quality_cycles" USING btree ("company_id","project_id","quality_phase","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_quality_items_cycle_record_role_uq" ON "work_record_quality_items" USING btree ("company_id","project_id","cycle_id","record_id","role");--> statement-breakpoint
CREATE INDEX "work_record_quality_items_readiness_idx" ON "work_record_quality_items" USING btree ("company_id","cycle_id","required","state");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_quality_links_key_uq" ON "work_record_quality_links" USING btree ("company_id","link_key");--> statement-breakpoint
CREATE INDEX "work_record_quality_links_defect_idx" ON "work_record_quality_links" USING btree ("company_id","project_id","defect_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_quality_verdicts_request_uq" ON "work_record_quality_verdicts" USING btree ("company_id","client_request_id");--> statement-breakpoint
CREATE INDEX "work_record_quality_verdicts_item_created_idx" ON "work_record_quality_verdicts" USING btree ("company_id","item_id","created_at");--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_batch_id_work_record_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."work_record_dispatch_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_quality_cycle_id_work_record_quality_cycles_id_fk" FOREIGN KEY ("quality_cycle_id") REFERENCES "public"."work_record_quality_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_quality_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("quality_item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_execution_intent_id_work_record_execution_intents_id_fk" FOREIGN KEY ("execution_intent_id") REFERENCES "public"."work_record_execution_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_batch_scope_fk" FOREIGN KEY ("company_id","project_id","batch_id") REFERENCES "public"."work_record_dispatch_batches"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_quality_cycle_scope_fk" FOREIGN KEY ("company_id","project_id","quality_cycle_id") REFERENCES "public"."work_record_quality_cycles"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_quality_item_scope_fk" FOREIGN KEY ("company_id","project_id","quality_item_id") REFERENCES "public"."work_record_quality_items"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_execution_intent_scope_fk" FOREIGN KEY ("company_id","project_id","execution_intent_id") REFERENCES "public"."work_record_execution_intents"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_outbox_intent_event_uq" ON "work_record_outbox" USING btree ("company_id","execution_intent_id","event_type") WHERE "work_record_outbox"."workflow_version" = 2 AND "work_record_outbox"."execution_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_outbox_release_uq" ON "work_record_outbox" USING btree ("company_id","record_id","dispatch_round","dependency_set_revision","blocked_cycle","event_type") WHERE "work_record_outbox"."workflow_version" = 1;--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_workflow_version_check" CHECK ("work_record_outbox"."workflow_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "work_record_outbox" ADD CONSTRAINT "work_record_outbox_workflow_payload_check" CHECK (("work_record_outbox"."workflow_version" = 1 AND "work_record_outbox"."batch_id" IS NULL AND "work_record_outbox"."quality_cycle_id" IS NULL AND "work_record_outbox"."quality_item_id" IS NULL AND "work_record_outbox"."execution_intent_id" IS NULL)
        OR ("work_record_outbox"."workflow_version" = 2 AND "work_record_outbox"."execution_intent_id" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION reject_work_record_quality_verdict_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'work_record_quality_verdicts is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER work_record_quality_verdicts_append_only
BEFORE UPDATE OR DELETE ON work_record_quality_verdicts
FOR EACH ROW EXECUTE FUNCTION reject_work_record_quality_verdict_mutation();
