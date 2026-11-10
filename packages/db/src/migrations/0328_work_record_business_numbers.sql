CREATE TABLE "work_record_counters" (
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_record_counters_pkey" PRIMARY KEY("company_id","project_id","kind"),
	CONSTRAINT "work_record_counters_kind_check" CHECK ("work_record_counters"."kind" IN ('plan', 'defect')),
	CONSTRAINT "work_record_counters_next_number_positive_check" CHECK ("work_record_counters"."next_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "work_records" ADD COLUMN "record_number" integer;
--> statement-breakpoint
WITH ranked AS (
	SELECT
		id,
		row_number() OVER (
			PARTITION BY company_id, project_id, kind
			ORDER BY created_at ASC, id ASC
		)::integer AS record_number
	FROM "work_records"
)
UPDATE "work_records" AS records
SET "record_number" = ranked."record_number"
FROM ranked
WHERE records.id = ranked.id;
--> statement-breakpoint
INSERT INTO "work_record_counters" ("company_id", "project_id", "kind", "next_number")
SELECT "company_id", "project_id", "kind", max("record_number") + 1
FROM "work_records"
GROUP BY "company_id", "project_id", "kind";
--> statement-breakpoint
ALTER TABLE "work_records" ALTER COLUMN "record_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "work_record_counters" ADD CONSTRAINT "work_record_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_counters" ADD CONSTRAINT "work_record_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_record_counters" ADD CONSTRAINT "work_record_counters_project_scope_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_company_project_kind_record_number_unique" UNIQUE("company_id","project_id","kind","record_number");--> statement-breakpoint
ALTER TABLE "work_records" ADD CONSTRAINT "work_records_record_number_positive_check" CHECK ("work_records"."record_number" >= 1);
