CREATE TABLE "local_po_verdict_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "record_id" uuid NOT NULL REFERENCES "work_records"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "client_request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "payload" jsonb NOT NULL,
  "prepared_status_version" bigint NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "verdict_id" uuid REFERENCES "work_record_quality_verdicts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "committed_at" timestamp with time zone,
  CONSTRAINT "local_po_verdict_commands_state_check" CHECK (
    ("state" = 'prepared' AND "verdict_id" IS NULL AND "committed_at" IS NULL) OR
    ("state" = 'committed' AND "verdict_id" IS NOT NULL AND "committed_at" IS NOT NULL) OR
    ("state" = 'aborted' AND "verdict_id" IS NULL AND "committed_at" IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "local_po_verdict_commands_request_uq" ON "local_po_verdict_commands" ("company_id", "run_id", "client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_po_verdict_commands_run_uq" ON "local_po_verdict_commands" ("company_id", "run_id");--> statement-breakpoint
CREATE INDEX "local_po_verdict_commands_record_idx" ON "local_po_verdict_commands" ("company_id", "record_id", "created_at");
