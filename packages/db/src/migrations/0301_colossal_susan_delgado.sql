-- 0300 used ->> and admitted JSON string "1"; the schema now requires numeric 1.
-- Preserve decided-review history: reject legacy strings instead of rewriting them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "issue_completion_reviews"
    WHERE "state" IN ('accepted', 'rejected')
      AND ("decision_receipt"->'schemaVersion') IS DISTINCT FROM '1'::jsonb) THEN
    RAISE EXCEPTION 'issue_completion_reviews contains a nonnumeric decision receipt version'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" DROP CONSTRAINT "issue_command_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" DROP CONSTRAINT "issue_completion_reviews_decision_receipt_check";--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD COLUMN "review_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_reviews_delivery_scope_uq" ON "issue_completion_reviews" USING btree ("company_id","issue_id","interaction_id","id");--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD CONSTRAINT "issue_command_deliveries_review_scope_fk" FOREIGN KEY ("company_id","issue_id","interaction_id","review_id") REFERENCES "public"."issue_completion_reviews"("company_id","issue_id","interaction_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD CONSTRAINT "issue_command_deliveries_kind_check" CHECK (("issue_command_deliveries"."kind" = 'interaction_pending' and "issue_command_deliveries"."review_id" is null)
      or ("issue_command_deliveries"."kind" = 'completion_review' and "issue_command_deliveries"."review_id" is not null));--> statement-breakpoint
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
      and "issue_completion_reviews"."decision_receipt"->'schemaVersion' = '1'::jsonb
      and "issue_completion_reviews"."decision_receipt"->>'reviewId' = "issue_completion_reviews"."id"::text
      and "issue_completion_reviews"."decision_receipt"->>'requestId' = "issue_completion_reviews"."decision_request_id"::text
      and "issue_completion_reviews"."decision_receipt"->>'outcome' = "issue_completion_reviews"."state")), false)
  );
