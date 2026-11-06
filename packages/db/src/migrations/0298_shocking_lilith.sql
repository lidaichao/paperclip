CREATE TABLE "issue_command_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'awaiting_handoff' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"claim_token" uuid,
	"wakeup_request_id" uuid,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_command_deliveries_kind_check" CHECK ("issue_command_deliveries"."kind" = 'interaction_pending'),
	CONSTRAINT "issue_command_deliveries_status_check" CHECK ("issue_command_deliveries"."status" in ('awaiting_handoff','ready','claimed','delivered','deferred','cancelled')),
	CONSTRAINT "issue_command_deliveries_attempts_check" CHECK ("issue_command_deliveries"."attempts" >= 0),
	CONSTRAINT "issue_command_deliveries_claim_check" CHECK (("issue_command_deliveries"."status" = 'claimed') = ("issue_command_deliveries"."claim_token" is not null and "issue_command_deliveries"."claim_expires_at" is not null)),
	CONSTRAINT "issue_command_deliveries_receipt_check" CHECK ("issue_command_deliveries"."status" <> 'delivered' or ("issue_command_deliveries"."delivered_at" is not null and "issue_command_deliveries"."wakeup_request_id" is not null))
);
--> statement-breakpoint
-- The interaction scope must be unique before the delivery FK references it.
CREATE UNIQUE INDEX "issue_thread_interactions_company_issue_id_uq" ON "issue_thread_interactions" USING btree ("company_id","issue_id","id");--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD CONSTRAINT "issue_command_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD CONSTRAINT "issue_command_deliveries_interaction_scope_fk" FOREIGN KEY ("company_id","issue_id","interaction_id") REFERENCES "public"."issue_thread_interactions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_command_deliveries" ADD CONSTRAINT "issue_command_deliveries_target_agent_scope_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_command_deliveries_interaction_kind_uq" ON "issue_command_deliveries" USING btree ("company_id","interaction_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_command_deliveries_wakeup_receipt_uq" ON "issue_command_deliveries" USING btree ("wakeup_request_id") WHERE "issue_command_deliveries"."wakeup_request_id" is not null;--> statement-breakpoint
CREATE INDEX "issue_command_deliveries_pending_idx" ON "issue_command_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "issue_command_deliveries_agent_status_idx" ON "issue_command_deliveries" USING btree ("company_id","target_agent_id","status");
