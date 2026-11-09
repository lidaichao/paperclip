CREATE TABLE "work_record_user_responsibilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "record_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "work_record_user_responsibilities_record_scope_fk"
    FOREIGN KEY ("company_id", "project_id", "record_id")
    REFERENCES "work_records" ("company_id", "project_id", "id") ON DELETE CASCADE,
  CONSTRAINT "work_record_user_responsibilities_role_check"
    CHECK ("role" IN ('execution', 'qa', 'po'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_user_responsibilities_user_record_role_uq"
  ON "work_record_user_responsibilities" ("company_id", "record_id", "user_id", "role");--> statement-breakpoint
CREATE INDEX "work_record_user_responsibilities_user_query_idx"
  ON "work_record_user_responsibilities" ("company_id", "user_id", "record_id");--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('work_record_user_responsibilities_0322_rollback_backup') IS NOT NULL THEN
    INSERT INTO "work_record_user_responsibilities"
      ("id", "company_id", "project_id", "record_id", "user_id", "role", "created_at")
    SELECT "id", "company_id", "project_id", "record_id", "user_id", "role", "created_at"
    FROM "work_record_user_responsibilities_0322_rollback_backup"
    ON CONFLICT DO NOTHING;
    DROP TABLE "work_record_user_responsibilities_0322_rollback_backup";
  END IF;
END $$;
