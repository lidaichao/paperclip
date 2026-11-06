-- Existing accepted/rejected reviews cannot be assigned fabricated decision receipts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "issue_completion_reviews" WHERE "state" IN ('accepted', 'rejected')) THEN
    RAISE EXCEPTION 'issue_completion_reviews contains decided rows without decision receipts'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD COLUMN "decision_request_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD COLUMN "decision_request_digest" text;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD COLUMN "decision_summary" text;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD COLUMN "decision_receipt" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_reviews_decision_request_uq" ON "issue_completion_reviews" USING btree ("company_id","decision_request_id") WHERE "issue_completion_reviews"."decision_request_id" is not null;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_decision_receipt_check" CHECK (
    coalesce((("issue_completion_reviews"."state" in ('pending', 'cancelled')
      and "issue_completion_reviews"."decision_request_id" is null
      and "issue_completion_reviews"."decision_request_digest" is null
      and "issue_completion_reviews"."decision_summary" is null
      and "issue_completion_reviews"."decision_receipt" is null)
    or ("issue_completion_reviews"."state" in ('accepted', 'rejected')
      and "issue_completion_reviews"."decision_request_id" is not null
      and "issue_completion_reviews"."decision_request_digest" is not null
      and "issue_completion_reviews"."decision_summary" is not null
      and "issue_completion_reviews"."decision_receipt" is not null
      and "issue_completion_reviews"."decision_request_digest" ~ '^[0-9a-f]{64}$'
      and length(btrim("issue_completion_reviews"."decision_summary")) between 1 and 4096
      and jsonb_typeof("issue_completion_reviews"."decision_receipt") = 'object'
      and "issue_completion_reviews"."decision_receipt"->>'schemaVersion' = '1'
      and "issue_completion_reviews"."decision_receipt"->>'reviewId' = "issue_completion_reviews"."id"::text
      and "issue_completion_reviews"."decision_receipt"->>'requestId' = "issue_completion_reviews"."decision_request_id"::text
      and "issue_completion_reviews"."decision_receipt"->>'outcome' = "issue_completion_reviews"."state")), false)
  );
