ALTER TABLE "work_record_description_deliveries" DROP CONSTRAINT IF EXISTS "work_record_description_deliveries_source_run_id_heartbeat_runs_id_fk";
ALTER TABLE "work_record_description_deliveries" DROP CONSTRAINT IF EXISTS "work_record_description_deliveries_successor_run_id_heartbeat_runs_id_fk";
ALTER TABLE "work_record_description_deliveries" DROP CONSTRAINT IF EXISTS "work_record_description_deliveries_wakeup_request_id_agent_wakeup_requests_id_fk";
ALTER TABLE "work_record_description_deliveries" DROP CONSTRAINT IF EXISTS "work_record_description_deliveries_state_check";
UPDATE "work_record_description_deliveries"
SET "state" = CASE
  WHEN "state" = 'stopping' THEN 'delivering'
  WHEN "state" = 'queued' THEN 'delivered'
  WHEN "state" = 'confirmed' THEN 'acknowledged'
  ELSE "state"
END;
ALTER TABLE "work_record_description_deliveries" ADD CONSTRAINT "work_record_description_deliveries_state_check" CHECK ("state" IN ('pending', 'delivering', 'delivered', 'retry', 'acknowledged'));
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "source_run_id";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "successor_run_id";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "wakeup_request_id";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "stop_confirmed_at";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "queued_at";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "model_visible_at";
ALTER TABLE "work_record_description_deliveries" DROP COLUMN "confirmed_at";
