CREATE TABLE "local_agent_device_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "local_agent_run_leases" ADD COLUMN "device_key_id" uuid;--> statement-breakpoint
ALTER TABLE "local_agent_device_bindings" ADD CONSTRAINT "local_agent_device_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_device_bindings_key_uq" ON "local_agent_device_bindings" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_device_bindings_active_device_uq" ON "local_agent_device_bindings" USING btree ("company_id","agent_id","device_id") WHERE "local_agent_device_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "local_agent_device_bindings_agent_idx" ON "local_agent_device_bindings" USING btree ("company_id","agent_id");