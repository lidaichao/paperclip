CREATE TABLE "issue_completion_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"native_decision_id" uuid,
	"client_pull_lease_run_id" uuid,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"issue_status_version" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_completion_reviews_evidence_check" CHECK (
    ("issue_completion_reviews"."source_kind" = 'native' and "issue_completion_reviews"."native_decision_id" is not null
      and "issue_completion_reviews"."client_pull_lease_run_id" is null)
    or ("issue_completion_reviews"."source_kind" = 'client_pull' and "issue_completion_reviews"."native_decision_id" is null
      and "issue_completion_reviews"."client_pull_lease_run_id" is not null
      and "issue_completion_reviews"."client_pull_lease_run_id" = "issue_completion_reviews"."source_run_id")
  ),
	CONSTRAINT "issue_completion_reviews_separate_reviewer_check" CHECK ("issue_completion_reviews"."source_agent_id" <> "issue_completion_reviews"."reviewer_agent_id"),
	CONSTRAINT "issue_completion_reviews_request_digest_check" CHECK (length("issue_completion_reviews"."request_digest") > 0),
	CONSTRAINT "issue_completion_reviews_version_check" CHECK ("issue_completion_reviews"."issue_status_version" >= 0),
	CONSTRAINT "issue_completion_reviews_state_check" CHECK ("issue_completion_reviews"."state" in ('pending','accepted','rejected','cancelled')),
	CONSTRAINT "issue_completion_reviews_decision_check" CHECK (
    ("issue_completion_reviews"."state" = 'pending' and "issue_completion_reviews"."decided_at" is null)
    or ("issue_completion_reviews"."state" <> 'pending' and "issue_completion_reviews"."decided_at" is not null)
  )
);
--> statement-breakpoint
-- The source evidence must be unique before the review foreign keys reference it.
ALTER TABLE "local_agent_run_leases" ADD CONSTRAINT "local_agent_run_leases_company_issue_run_uq" UNIQUE("company_id","issue_id","run_id");--> statement-breakpoint
ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_company_issue_run_id_uq" UNIQUE("company_id","issue_id","run_id","id");--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_issue_scope_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_reviewer_scope_fk" FOREIGN KEY ("company_id","reviewer_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_source_agent_scope_fk" FOREIGN KEY ("company_id","source_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_interaction_scope_fk" FOREIGN KEY ("company_id","issue_id","interaction_id") REFERENCES "public"."issue_thread_interactions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_native_decision_scope_fk" FOREIGN KEY ("company_id","issue_id","source_run_id","native_decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_completion_reviews" ADD CONSTRAINT "issue_completion_reviews_local_lease_scope_fk" FOREIGN KEY ("company_id","issue_id","client_pull_lease_run_id") REFERENCES "public"."local_agent_run_leases"("company_id","issue_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_reviews_run_request_uq" ON "issue_completion_reviews" USING btree ("company_id","source_run_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_completion_reviews_interaction_uq" ON "issue_completion_reviews" USING btree ("company_id","interaction_id");
