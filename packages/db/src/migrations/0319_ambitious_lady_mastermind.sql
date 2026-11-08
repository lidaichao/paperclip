CREATE TABLE "work_record_view_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"view_kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_view_preferences_view_kind_check" CHECK ("work_record_view_preferences"."view_kind" IN ('plan', 'defect')),
	CONSTRAINT "work_record_view_preferences_revision_check" CHECK ("work_record_view_preferences"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "work_record_view_preferences" ADD CONSTRAINT "work_record_view_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_view_preferences" ADD CONSTRAINT "work_record_view_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_view_preferences" ADD CONSTRAINT "work_record_view_preferences_project_scope_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_view_preferences_scope_uq" ON "work_record_view_preferences" USING btree ("company_id","project_id","user_id","view_kind");--> statement-breakpoint
CREATE INDEX "work_record_view_preferences_user_project_idx" ON "work_record_view_preferences" USING btree ("user_id","project_id");