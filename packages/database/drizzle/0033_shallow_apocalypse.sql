ALTER TABLE "temporal_commands" DROP CONSTRAINT "temporal_commands_activity_task_queue_check";--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD COLUMN "activity_task_lane" text;--> statement-breakpoint
UPDATE "temporal_commands" command
SET "activity_task_lane" = CASE
  WHEN step."step_type" IN (
    'gmail.history.catchup',
    'gmail.message.refresh',
    'gmail.watch.renew'
  ) THEN 'control'
  WHEN step."step_type" IN (
    'embedding.batch.event',
    'embedding.incremental',
    'memory.incremental',
    'memory.batch.event',
    'memory.feedback',
    'label.thread.assign',
    'label.batch.submit',
    'label.batch.event'
  ) THEN 'live'
  WHEN step."step_type" IN (
    'gmail.sync.page',
    'gmail.sync.message',
    'gmail.sync.message.batch',
    'gmail.sync.finalize',
    'gmail.account.cleanup',
    'gmail.objects.delete',
    'embedding.backfill',
    'memory.extract',
    'memory.batch.retry',
    'label.thread.scan'
  ) THEN 'bulk'
END
FROM "workflow_steps" step
WHERE step."id" = command."workflow_step_id";--> statement-breakpoint
ALTER TABLE "temporal_commands" ALTER COLUMN "activity_task_lane" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "connected_accounts_active_user_idx" ON "connected_accounts" USING btree ("user_id") WHERE "connected_accounts"."status" <> 'disconnected';--> statement-breakpoint
CREATE INDEX "workflow_steps_user_status_idx" ON "workflow_steps" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP COLUMN "activity_task_queue";--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_activity_task_lane_check" CHECK ("temporal_commands"."activity_task_lane" in ('control', 'live', 'bulk'));
