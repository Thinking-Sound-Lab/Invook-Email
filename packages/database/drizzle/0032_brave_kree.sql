CREATE TABLE "thread_label_batch_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"provider_batch_id" text,
	"input_file_id" text,
	"output_file_id" text,
	"error_file_id" text,
	"model_id" text NOT NULL,
	"definition_hash" text NOT NULL,
	"flush_remainder" boolean DEFAULT false NOT NULL,
	"has_more" boolean DEFAULT false NOT NULL,
	"request_count" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"provider_state" text,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_label_batch_submissions_provider_check" CHECK ("thread_label_batch_submissions"."provider" = 'openai'),
	CONSTRAINT "thread_label_batch_submissions_status_check" CHECK ("thread_label_batch_submissions"."status" in ('preparing', 'submitted', 'complete', 'failed')),
	CONSTRAINT "thread_label_batch_submissions_request_count_check" CHECK ("thread_label_batch_submissions"."request_count" between 1 and 2000),
	CONSTRAINT "thread_label_batch_submissions_definition_hash_check" CHECK ("thread_label_batch_submissions"."definition_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP CONSTRAINT "temporal_commands_activity_task_queue_check";--> statement-breakpoint
ALTER TABLE "gmail_sync_items" ADD COLUMN "provider_thread_id" text;--> statement-breakpoint
UPDATE "gmail_sync_items" sync_item
SET "provider_thread_id" = stored_thread."provider_thread_id"
FROM "mail_sync_runs" sync_run
INNER JOIN "messages" stored_message
  ON stored_message."account_id" = sync_run."account_id"
INNER JOIN "threads" stored_thread
  ON stored_thread."id" = stored_message."thread_id"
WHERE sync_item."run_id" = sync_run."id"
  AND sync_item."provider_message_id" = stored_message."provider_message_id";--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_batch_submissions_workflow_step_idx" ON "thread_label_batch_submissions" USING btree ("workflow_step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_batch_submissions_provider_batch_idx" ON "thread_label_batch_submissions" USING btree ("provider","provider_batch_id") WHERE "thread_label_batch_submissions"."provider_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "thread_label_batch_submissions_account_status_idx" ON "thread_label_batch_submissions" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX "gmail_sync_items_run_thread_status_idx" ON "gmail_sync_items" USING btree ("run_id","provider_thread_id","status");--> statement-breakpoint
UPDATE "workflow_steps"
SET "status" = 'complete',
    "result" = '{"status":"superseded_by_batch"}'::jsonb,
    "last_error" = NULL,
    "completed_at" = coalesce("completed_at", now()),
    "updated_at" = now()
WHERE "step_type" = 'label.thread.assign'
  AND "status" IN ('queued', 'running');--> statement-breakpoint
UPDATE "threads" target_thread
SET "label_analysis_state" = 'pending',
    "label_analysis_error" = NULL,
    "label_analyzed_at" = NULL,
    "updated_at" = now()
WHERE target_thread."label_analysis_state" = 'running'
  AND NOT EXISTS (
    SELECT 1
    FROM "thread_label_assignments" assignment
    WHERE assignment."thread_id" = target_thread."id"
  );--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_activity_task_queue_check" CHECK ("temporal_commands"."activity_task_queue" in ('gmail-pages', 'gmail-messages', 'gmail-message-batches', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback', 'mail-label-live', 'mail-label-submit', 'mail-label-batch', 'mail-label-events'));
