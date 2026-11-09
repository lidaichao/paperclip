CREATE TABLE IF NOT EXISTS "work_record_user_responsibilities_0322_rollback_backup" (
  LIKE "work_record_user_responsibilities" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);

INSERT INTO "work_record_user_responsibilities_0322_rollback_backup"
SELECT * FROM "work_record_user_responsibilities";

DROP TABLE "work_record_user_responsibilities";
