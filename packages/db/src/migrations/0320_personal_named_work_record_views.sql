ALTER TABLE "work_record_view_preferences" ADD COLUMN "name" text DEFAULT '个人视图' NOT NULL;--> statement-breakpoint
DROP INDEX "work_record_view_preferences_scope_uq";--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.work_record_view_preferences_0320_rollback_backup') IS NOT NULL THEN
		WITH latest_batch AS (
			SELECT "backup_batch_id"
			FROM "work_record_view_preferences_0320_rollback_backup"
			ORDER BY "backed_up_at" DESC, "backup_batch_id" DESC
			LIMIT 1
		)
		UPDATE "work_record_view_preferences" AS current_view
		SET "name" = backup."name"
		FROM "work_record_view_preferences_0320_rollback_backup" AS backup, latest_batch
		WHERE backup."backup_batch_id" = latest_batch."backup_batch_id"
			AND current_view."id" = backup."original_id";

		WITH latest_batch AS (
			SELECT "backup_batch_id"
			FROM "work_record_view_preferences_0320_rollback_backup"
			ORDER BY "backed_up_at" DESC, "backup_batch_id" DESC
			LIMIT 1
		)
		UPDATE "work_record_view_preferences" AS current_view
		SET "name" = '回滚期间视图 ' || left(current_view."id"::text, 8)
		FROM latest_batch
		WHERE EXISTS (
			SELECT 1
			FROM "work_record_view_preferences_0320_rollback_backup" AS backup
			WHERE backup."backup_batch_id" = latest_batch."backup_batch_id"
				AND backup."company_id" = current_view."company_id"
				AND backup."project_id" = current_view."project_id"
				AND backup."user_id" = current_view."user_id"
				AND backup."view_kind" = current_view."view_kind"
		)
		AND NOT EXISTS (
			SELECT 1
			FROM "work_record_view_preferences_0320_rollback_backup" AS backup
			WHERE backup."backup_batch_id" = latest_batch."backup_batch_id"
				AND backup."original_id" = current_view."id"
		);

		WITH latest_batch AS (
			SELECT "backup_batch_id"
			FROM "work_record_view_preferences_0320_rollback_backup"
			ORDER BY "backed_up_at" DESC, "backup_batch_id" DESC
			LIMIT 1
		)
		INSERT INTO "work_record_view_preferences" (
			"id", "company_id", "project_id", "user_id", "view_kind", "name",
			"config", "revision", "created_at", "updated_at"
		)
		SELECT backup."original_id", backup."company_id", backup."project_id", backup."user_id",
			backup."view_kind", backup."name", backup."config", backup."revision",
			backup."created_at", backup."updated_at"
		FROM "work_record_view_preferences_0320_rollback_backup" AS backup, latest_batch
		WHERE backup."backup_batch_id" = latest_batch."backup_batch_id"
		ON CONFLICT ("id") DO NOTHING;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_view_preferences_scope_uq" ON "work_record_view_preferences" USING btree ("company_id","project_id","user_id","view_kind",lower("name"));
