CREATE TABLE "local_defect_repair_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"repair_item_id" uuid NOT NULL,
	"qa_item_id" uuid NOT NULL,
	"qa_agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"prepared_status_version" bigint NOT NULL,
	"prepared_cycle_revision" bigint NOT NULL,
	"submitted_status_version" bigint,
	"state" text DEFAULT 'prepared' NOT NULL,
	"comment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_defect_repair_handoffs_state_check" CHECK (
    ("local_defect_repair_handoffs"."state" = 'prepared' AND "local_defect_repair_handoffs"."submitted_status_version" IS NULL) OR
    ("local_defect_repair_handoffs"."state" = 'submitted' AND "local_defect_repair_handoffs"."submitted_status_version" IS NOT NULL) OR
    ("local_defect_repair_handoffs"."state" = 'aborted' AND "local_defect_repair_handoffs"."submitted_status_version" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_record_id_work_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_cycle_id_work_record_quality_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."work_record_quality_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_repair_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("repair_item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_qa_item_id_work_record_quality_items_id_fk" FOREIGN KEY ("qa_item_id") REFERENCES "public"."work_record_quality_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_qa_agent_id_agents_id_fk" FOREIGN KEY ("qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_defect_repair_handoffs_run_uq" ON "local_defect_repair_handoffs" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_defect_repair_handoffs_request_uq" ON "local_defect_repair_handoffs" USING btree ("company_id","run_id","client_request_id");--> statement-breakpoint
CREATE INDEX "local_defect_repair_handoffs_record_idx" ON "local_defect_repair_handoffs" USING btree ("company_id","record_id","created_at");