CREATE TABLE IF NOT EXISTS "work_record_view_preferences_0321_rollback_backup" (
  LIKE "work_record_view_preferences" INCLUDING ALL
);

INSERT INTO "work_record_view_preferences_0321_rollback_backup"
SELECT * FROM "work_record_view_preferences" WHERE "view_kind" = 'gantt'
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "work_record_view_preferences" WHERE "view_kind" = 'gantt';

ALTER TABLE "work_record_view_preferences" DROP CONSTRAINT "work_record_view_preferences_view_kind_check";
ALTER TABLE "work_record_view_preferences" ADD CONSTRAINT "work_record_view_preferences_view_kind_check"
  CHECK ("view_kind" IN ('plan', 'defect'));
