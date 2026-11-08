ALTER TABLE "work_record_view_preferences" ADD COLUMN "name" text DEFAULT '个人视图' NOT NULL;--> statement-breakpoint
DROP INDEX "work_record_view_preferences_scope_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "work_record_view_preferences_scope_uq" ON "work_record_view_preferences" USING btree ("company_id","project_id","user_id","view_kind",lower("name"));
