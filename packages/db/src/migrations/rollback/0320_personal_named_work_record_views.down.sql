CREATE TABLE IF NOT EXISTS "work_record_view_preferences_0320_rollback_backup" (
	"backup_batch_id" text NOT NULL,
	"backed_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"original_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"view_kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_record_view_preferences_0320_backup_pk" PRIMARY KEY("backup_batch_id", "original_id")
);

DO $$
DECLARE
	batch_id text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS') || '-' || txid_current()::text;
BEGIN
	INSERT INTO "work_record_view_preferences_0320_rollback_backup" (
		"backup_batch_id", "original_id", "company_id", "project_id", "user_id",
		"view_kind", "name", "config", "revision", "created_at", "updated_at"
	)
	SELECT batch_id, "id", "company_id", "project_id", "user_id", "view_kind",
		"name", "config", "revision", "created_at", "updated_at"
	FROM "work_record_view_preferences";
END $$;

DROP INDEX IF EXISTS "work_record_view_preferences_scope_uq";

WITH ranked AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "company_id", "project_id", "user_id", "view_kind"
		ORDER BY "updated_at" DESC, "revision" DESC, "id" DESC
	) AS position
	FROM "work_record_view_preferences"
)
DELETE FROM "work_record_view_preferences"
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);

ALTER TABLE "work_record_view_preferences" DROP COLUMN IF EXISTS "name";
CREATE UNIQUE INDEX "work_record_view_preferences_scope_uq" ON "work_record_view_preferences" USING btree ("company_id","project_id","user_id","view_kind");
