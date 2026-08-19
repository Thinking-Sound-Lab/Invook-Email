ALTER TABLE "queue_outbox" RENAME TO "temporal_commands";--> statement-breakpoint
ALTER TABLE "temporal_commands" RENAME COLUMN "queue_name" TO "activity_task_queue";--> statement-breakpoint
ALTER TABLE "temporal_commands" RENAME COLUMN "publish_attempts" TO "dispatch_attempts";--> statement-breakpoint
ALTER TABLE "temporal_commands" RENAME COLUMN "published_at" TO "dispatched_at";--> statement-breakpoint
DROP TRIGGER IF EXISTS "queue_outbox_notify_worker" ON "temporal_commands";--> statement-breakpoint
DROP FUNCTION IF EXISTS notify_invook_queue_outbox_available();--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP CONSTRAINT "queue_outbox_publish_attempts_check";--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP CONSTRAINT "queue_outbox_queue_name_check";--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP CONSTRAINT "queue_outbox_workflow_step_id_workflow_steps_id_fk";
--> statement-breakpoint
DROP INDEX "queue_outbox_workflow_step_idx";--> statement-breakpoint
DROP INDEX "queue_outbox_unpublished_idx";--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "temporal_commands_workflow_step_idx" ON "temporal_commands" USING btree ("workflow_step_id");--> statement-breakpoint
CREATE INDEX "temporal_commands_undispatched_idx" ON "temporal_commands" USING btree ("created_at") WHERE "temporal_commands"."dispatched_at" is null;--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_dispatch_attempts_check" CHECK ("temporal_commands"."dispatch_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_activity_task_queue_check" CHECK ("temporal_commands"."activity_task_queue" in ('gmail-pages', 'gmail-messages', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback', 'mail-label-submit'));--> statement-breakpoint
UPDATE "temporal_commands"
SET
	"dispatched_at" = NULL,
	"last_error" = NULL,
	"updated_at" = now()
FROM "workflow_steps"
WHERE "workflow_steps"."id" = "temporal_commands"."workflow_step_id"
	AND "workflow_steps"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_temporal_commands_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('invook_temporal_commands', NEW.id::text);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "temporal_commands_notify_worker"
AFTER INSERT ON "temporal_commands"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_temporal_commands_available();
