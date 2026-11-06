-- A rejected completion review must wake its source agent exactly once, even
-- if a previous wake is later marked failed, cancelled, or skipped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_wakeup_requests"
    WHERE "idempotency_key" LIKE 'completion-review-rejected:%'
    GROUP BY "company_id", "idempotency_key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate dedicated rejected completion review wake keys require reconciliation'
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner uses a transaction; this partial index must exist before the rejection producer is enabled. Schedule a maintenance window for production-sized tables.
CREATE UNIQUE INDEX "agent_wakeup_requests_review_rejected_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'completion-review-rejected:%';
