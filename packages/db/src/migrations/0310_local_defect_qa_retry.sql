ALTER TABLE "local_defect_qa_verdict_commands" ADD COLUMN "escalated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD COLUMN "qa_delivery_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_defect_qa_verdict_commands" ADD CONSTRAINT "local_defect_qa_verdict_commands_escalation_check" CHECK (
    NOT "local_defect_qa_verdict_commands"."escalated" OR "local_defect_qa_verdict_commands"."state" = 'committed');--> statement-breakpoint
ALTER TABLE "local_defect_repair_handoffs" ADD CONSTRAINT "local_defect_repair_handoffs_qa_generation_check" CHECK (
    "local_defect_repair_handoffs"."qa_delivery_generation" BETWEEN 1 AND 2);