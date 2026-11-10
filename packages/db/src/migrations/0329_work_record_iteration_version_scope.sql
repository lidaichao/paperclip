INSERT INTO "project_versions" ("company_id", "project_id", "name")
SELECT DISTINCT "company_id", "project_id", '历史未归属版本'
FROM "project_iterations"
WHERE "version_id" IS NULL
ON CONFLICT ("company_id", "project_id", "name") DO NOTHING;
--> statement-breakpoint
UPDATE "project_iterations" AS iterations
SET "version_id" = versions."id",
    "updated_at" = now()
FROM "project_versions" AS versions
WHERE iterations."version_id" IS NULL
  AND versions."company_id" = iterations."company_id"
  AND versions."project_id" = iterations."project_id"
  AND versions."name" = '历史未归属版本';
--> statement-breakpoint
ALTER TABLE "project_iterations"
  DROP CONSTRAINT "project_iterations_version_id_project_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "project_iterations"
  ALTER COLUMN "version_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_iterations"
  ADD CONSTRAINT "project_iterations_version_id_project_versions_id_fk"
  FOREIGN KEY ("version_id") REFERENCES "public"."project_versions"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "project_iterations_project_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "project_iterations_version_name_uq"
  ON "project_iterations" USING btree ("company_id", "project_id", "version_id", "name");
