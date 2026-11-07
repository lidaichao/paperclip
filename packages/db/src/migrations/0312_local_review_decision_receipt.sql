ALTER TABLE "local_run_write_receipts" DROP CONSTRAINT "local_run_write_receipts_kind_check";--> statement-breakpoint
ALTER TABLE "local_run_write_receipts" ADD CONSTRAINT "local_run_write_receipts_kind_check" CHECK ("local_run_write_receipts"."kind" in (
    'child_complete', 'defect_repair_handoff', 'po_verdict',
    'defect_qa_verdict', 'completion_review_handoff', 'review_decision'));