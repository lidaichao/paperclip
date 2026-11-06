-- Keep historical delivery receipts intact. A duplicate means the durable
-- reviewer wake cannot be identified unambiguously and needs reconciliation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_wakeup_requests"
    WHERE "idempotency_key" LIKE 'interaction:%:completion-review:%'
    GROUP BY "company_id", "idempotency_key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate dedicated completion review wake keys require reconciliation'
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runner uses a transaction; this partial index is needed before the dedicated producer is enabled. Schedule a maintenance window for production-sized tables.
CREATE UNIQUE INDEX "agent_wakeup_requests_completion_review_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'interaction:%:completion-review:%';
