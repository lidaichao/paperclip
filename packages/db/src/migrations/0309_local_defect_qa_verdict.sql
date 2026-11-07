CREATE TABLE "local_defect_qa_verdict_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"handoff_id" uuid NOT NULL,
	"qa_agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prepared_status_version" bigint NOT NULL,
	"prepared_cycle_revision" bigint NOT NULL,
	"prepared_item_revision" bigint NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"verdict_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "local_defect_qa_verdict_commands_state_check" CHECK (
    ("local_defect_qa_verdict_commands"."state" = 'prepared' AND "local_defect_qa_verdict_commands"."verdict_id" IS NULL AND "local_defect_qa_verdict_commands"."committed_at" IS NULL) OR
    ("local_defect_qa_verdict_commands"."state" = 'committed' AND "local_defect_qa_verdict_commands"."verdict_id" IS NOT NULL AND "local_defect_qa_verdict_commands"."committed_at" IS NOT NULL) OR
    ("local_defect_qa_verdict_commands"."state" = 'aborted' AND "local_defect_qa_verdict_commands"."verdict_id" IS NULL AND "local_defect_qa_verdict_commands"."committed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_cycle_id_work_record_quality_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."work_record_quality_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_handoff_id_local_defect_repair_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."local_defect_repair_handoffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_qa_agent_id_agents_id_fk" FOREIGN KEY ("qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_verdict_id_work_record_quality_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."work_record_quality_verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_defect_qa_verdict_commands_run_uq" ON "local_defect_qa_verdict_commands" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_defect_qa_verdict_commands_request_uq" ON "local_defect_qa_verdict_commands" USING btree ("company_id","client_request_id");--> statement-breakpoint
CREATE INDEX "local_defect_qa_verdict_commands_handoff_idx" ON "local_defect_qa_verdict_commands" USING btree ("company_id","handoff_id","created_at");