CREATE TABLE "company_user_my_todo_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "config" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "company_user_my_todo_preferences_revision_check" CHECK ("revision" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_my_todo_preferences_scope_uq" ON "company_user_my_todo_preferences" ("company_id", "user_id");--> statement-breakpoint
CREATE INDEX "company_user_my_todo_preferences_user_idx" ON "company_user_my_todo_preferences" ("user_id");--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('company_user_my_todo_preferences_0323_rollback_backup') IS NOT NULL THEN
    INSERT INTO "company_user_my_todo_preferences" SELECT * FROM "company_user_my_todo_preferences_0323_rollback_backup" ON CONFLICT DO NOTHING;
    DROP TABLE "company_user_my_todo_preferences_0323_rollback_backup";
  END IF;
END $$;
