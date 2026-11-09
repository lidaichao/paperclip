CREATE TABLE IF NOT EXISTS "company_user_my_todo_preferences_0323_rollback_backup" (
  LIKE "company_user_my_todo_preferences" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);
INSERT INTO "company_user_my_todo_preferences_0323_rollback_backup" SELECT * FROM "company_user_my_todo_preferences";
DROP TABLE "company_user_my_todo_preferences";
