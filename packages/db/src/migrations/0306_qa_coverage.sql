CREATE TABLE "work_record_qa_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"execution_record_id" uuid NOT NULL,
	"qa_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_qa_coverage_not_self" CHECK ("work_record_qa_coverage"."execution_record_id" <> "work_record_qa_coverage"."qa_record_id")
);
--> statement-breakpoint
CREATE TABLE "work_record_qa_coverage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"execution_record_id" uuid NOT NULL,
	"qa_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_qa_coverage_snapshots_not_self" CHECK ("work_record_qa_coverage_snapshots"."execution_record_id" <> "work_record_qa_coverage_snapshots"."qa_record_id")
);
--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "package_qa_role" text;--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "qa_retest_exemption_reason" text;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_package_qa_role_check" CHECK ("work_records"."package_qa_role" IS NULL OR "work_records"."package_qa_role" IN ('execution', 'qa'));--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_qa_exemption_check" CHECK ("work_records"."qa_retest_exemption_reason" IS NULL OR ("work_records"."package_qa_role" = 'execution' AND "work_records"."parent_record_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_execution_record_id_work_records_id_fk" FOREIGN KEY ("execution_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_qa_record_id_work_records_id_fk" FOREIGN KEY ("qa_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_execution_scope_fk" FOREIGN KEY ("company_id","project_id","execution_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage" ADD CONSTRAINT "work_record_qa_coverage_qa_scope_fk" FOREIGN KEY ("company_id","project_id","qa_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_batch_id_work_record_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."work_record_dispatch_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_execution_record_id_work_records_id_fk" FOREIGN KEY ("execution_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_qa_record_id_work_records_id_fk" FOREIGN KEY ("qa_record_id") REFERENCES "public"."work_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_batch_scope_fk" FOREIGN KEY ("company_id","project_id","batch_id") REFERENCES "public"."work_record_dispatch_batches"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_execution_scope_fk" FOREIGN KEY ("company_id","project_id","execution_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_qa_coverage_snapshots" ADD CONSTRAINT "work_record_qa_coverage_snapshots_qa_scope_fk" FOREIGN KEY ("company_id","project_id","qa_record_id") REFERENCES "public"."work_records"("company_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_qa_coverage_pair_uq" ON "work_record_qa_coverage" USING btree ("company_id","project_id","execution_record_id","qa_record_id");--> statement-breakpoint
CREATE INDEX "work_record_qa_coverage_qa_idx" ON "work_record_qa_coverage" USING btree ("company_id","project_id","qa_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_qa_coverage_snapshots_pair_uq" ON "work_record_qa_coverage_snapshots" USING btree ("company_id","project_id","batch_id","execution_record_id","qa_record_id");--> statement-breakpoint
CREATE INDEX "work_record_qa_coverage_snapshots_execution_idx" ON "work_record_qa_coverage_snapshots" USING btree ("company_id","project_id","execution_record_id");
