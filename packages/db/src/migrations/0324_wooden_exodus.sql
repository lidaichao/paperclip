CREATE TABLE "agent_session_write_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"device_id" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_write_grants_token_hash_check" CHECK ("agent_session_write_grants"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_session_write_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_write_receipts_digest_check" CHECK ("agent_session_write_receipts"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "agent_session_write_receipts_status_check" CHECK ("agent_session_write_receipts"."status_code" is null or ("agent_session_write_receipts"."status_code" >= 100 and "agent_session_write_receipts"."status_code" <= 599))
);
--> statement-breakpoint
ALTER TABLE "agent_session_write_grants" ADD CONSTRAINT "agent_session_write_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_grants" ADD CONSTRAINT "agent_session_write_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_grants" ADD CONSTRAINT "agent_session_write_grants_key_id_agent_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_receipts" ADD CONSTRAINT "agent_session_write_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_receipts" ADD CONSTRAINT "agent_session_write_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_receipts" ADD CONSTRAINT "agent_session_write_receipts_key_id_agent_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_write_receipts" ADD CONSTRAINT "agent_session_write_receipts_grant_id_agent_session_write_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_session_write_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_write_grants_token_hash_uq" ON "agent_session_write_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_session_write_grants_actor_expiry_idx" ON "agent_session_write_grants" USING btree ("company_id","agent_id","key_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_write_receipts_actor_key_uq" ON "agent_session_write_receipts" USING btree ("company_id","agent_id","key_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_session_write_receipts_grant_idx" ON "agent_session_write_receipts" USING btree ("grant_id","created_at");--> statement-breakpoint
