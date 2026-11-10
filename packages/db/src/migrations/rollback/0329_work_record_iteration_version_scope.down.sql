DROP INDEX "project_iterations_version_name_uq";
--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "project_id", "name"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS duplicate_ordinal
  FROM "project_iterations"
)
UPDATE "project_iterations" AS iterations
SET "name" = iterations."name" || ' [回滚-' || iterations."id"::text || ']',
    "updated_at" = now()
FROM ranked
WHERE iterations."id" = ranked."id"
  AND ranked.duplicate_ordinal > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_iterations_project_name_uq"
  ON "project_iterations" USING btree ("company_id", "project_id", "name");
--> statement-breakpoint
ALTER TABLE "project_iterations"
  DROP CONSTRAINT "project_iterations_version_id_project_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "project_iterations"
  ALTER COLUMN "version_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_iterations"
  ADD CONSTRAINT "project_iterations_version_id_project_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id")
  ON DELETE set null ON UPDATE no action;
