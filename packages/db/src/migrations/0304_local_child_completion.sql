-- A child work-record execution may finish once per source run. A receipt
-- survives response loss and prevents an old request from completing a later
-- rework cycle.
CREATE TABLE "local_issue_completion_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "record_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "client_request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "prepared_status_version" bigint NOT NULL,
  "completed_status_version" bigint,
  "state" text DEFAULT 'prepared' NOT NULL,
  "comment_id" uuid REFERENCES "issue_comments"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "local_issue_completion_commands_state_check" CHECK (
    ("state" = 'prepared' AND "completed_status_version" IS NULL) OR
    ("state" = 'completed' AND "completed_status_version" IS NOT NULL) OR
    ("state" = 'aborted' AND "completed_status_version" IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "local_issue_completion_commands_request_uq" ON "local_issue_completion_commands" ("company_id", "run_id", "client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_issue_completion_commands_issue_run_uq" ON "local_issue_completion_commands" ("company_id", "issue_id", "run_id");
