ALTER TABLE "queue_outbox" DROP CONSTRAINT "queue_outbox_queue_name_check";--> statement-breakpoint
DELETE FROM "workflow_steps" WHERE "step_type" = 'mail.classify';--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_queue_name_check" CHECK ("queue_outbox"."queue_name" in ('gmail-pages', 'gmail-messages', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback'));
