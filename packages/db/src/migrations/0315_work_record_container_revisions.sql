ALTER TABLE "project_versions"
  ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_iterations"
  ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
