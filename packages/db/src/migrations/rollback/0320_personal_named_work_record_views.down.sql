DROP INDEX IF EXISTS "work_record_view_preferences_scope_uq";
ALTER TABLE "work_record_view_preferences" DROP COLUMN IF EXISTS "name";
CREATE UNIQUE INDEX "work_record_view_preferences_scope_uq" ON "work_record_view_preferences" USING btree ("company_id","project_id","user_id","view_kind");
