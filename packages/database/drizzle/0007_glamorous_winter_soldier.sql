CREATE TABLE "gmail_sync_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_sync_items_status_check" CHECK ("gmail_sync_items"."status" in ('queued', 'running', 'complete', 'failed')),
	CONSTRAINT "gmail_sync_items_attempts_check" CHECK ("gmail_sync_items"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gmail_sync_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"page_token" text,
	"next_page_token" text,
	"discovered_message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_sync_pages_number_check" CHECK ("gmail_sync_pages"."page_number" > 0),
	CONSTRAINT "gmail_sync_pages_message_count_check" CHECK ("gmail_sync_pages"."discovered_message_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"starting_history_cursor" text NOT NULL,
	"final_history_cursor" text,
	"discovery_complete" boolean DEFAULT false NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"discovered_message_count" integer DEFAULT 0 NOT NULL,
	"processed_message_count" integer DEFAULT 0 NOT NULL,
	"failed_message_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sync_runs_status_check" CHECK ("mail_sync_runs"."status" in ('queued', 'running', 'complete', 'failed')),
	CONSTRAINT "mail_sync_runs_page_count_check" CHECK ("mail_sync_runs"."page_count" >= 0),
	CONSTRAINT "mail_sync_runs_message_counts_check" CHECK ("mail_sync_runs"."discovered_message_count" >= 0 and "mail_sync_runs"."processed_message_count" >= 0 and "mail_sync_runs"."failed_message_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queue_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"queue_name" text NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_outbox_publish_attempts_check" CHECK ("queue_outbox"."publish_attempts" >= 0),
	CONSTRAINT "queue_outbox_queue_name_check" CHECK ("queue_outbox"."queue_name" in ('gmail-pages', 'gmail-messages', 'mail-classification', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback'))
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"user_id" uuid,
	"account_id" uuid,
	"step_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_steps_status_check" CHECK ("workflow_steps"."status" in ('queued', 'running', 'complete', 'failed')),
	CONSTRAINT "workflow_steps_attempts_check" CHECK ("workflow_steps"."attempts" >= 0),
	CONSTRAINT "workflow_steps_max_attempts_check" CHECK ("workflow_steps"."max_attempts" > 0)
);
--> statement-breakpoint
INSERT INTO "workflow_steps" (
	"id",
	"user_id",
	"account_id",
	"step_type",
	"status",
	"input",
	"result",
	"attempts",
	"max_attempts",
	"last_error",
	"idempotency_key",
	"started_at",
	"completed_at",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"user_id",
	"account_id",
	"job_type",
	CASE WHEN "status" IN ('running', 'retry') THEN 'queued' ELSE "status" END,
	"payload",
	"result",
	"attempts",
	"max_attempts",
	"last_error",
	CASE
		WHEN "idempotency_key" IS null THEN 'legacy:' || "id"::text
		WHEN "duplicate_ordinal" = 1 THEN "idempotency_key"
		ELSE "idempotency_key" || ':migrated:' || "id"::text
	END,
	"locked_at",
	CASE WHEN "status" IN ('complete', 'failed') THEN "updated_at" ELSE null END,
	"created_at",
	"updated_at"
FROM (
	SELECT
		"jobs".*,
		row_number() OVER (
			PARTITION BY "idempotency_key"
			ORDER BY "created_at", "id"
		) AS "duplicate_ordinal"
	FROM "jobs"
) AS "legacy_jobs";
--> statement-breakpoint
INSERT INTO "queue_outbox" ("workflow_step_id", "queue_name")
SELECT
	"id",
	CASE
		WHEN "step_type" = 'mail.classify' THEN 'mail-classification'
		WHEN "step_type" IN ('embedding.backfill', 'embedding.batch.event') THEN 'mail-indexing-batch'
		WHEN "step_type" = 'embedding.incremental' THEN 'mail-indexing-live'
		WHEN "step_type" = 'memory.extract' THEN 'mail-memory-submit'
		WHEN "step_type" IN ('memory.batch.retry', 'memory.batch.event') THEN 'mail-memory-events'
		WHEN "step_type" = 'memory.feedback' THEN 'mail-memory-feedback'
	END
FROM "workflow_steps"
WHERE "status" = 'queued'
	AND "step_type" IN (
		'mail.classify',
		'embedding.backfill',
		'embedding.incremental',
		'embedding.batch.event',
		'memory.extract',
		'memory.batch.retry',
		'memory.batch.event',
		'memory.feedback'
	);
--> statement-breakpoint
DROP TABLE "jobs" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS "notify_invook_job_available"();--> statement-breakpoint
ALTER TABLE "gmail_sync_items" ADD CONSTRAINT "gmail_sync_items_run_id_mail_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mail_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" ADD CONSTRAINT "gmail_sync_pages_run_id_mail_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mail_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_mail_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mail_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_sync_items_run_message_idx" ON "gmail_sync_items" USING btree ("run_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "gmail_sync_items_run_status_idx" ON "gmail_sync_items" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_sync_pages_run_number_idx" ON "gmail_sync_pages" USING btree ("run_id","page_number");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_sync_runs_idempotency_key_idx" ON "mail_sync_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mail_sync_runs_account_created_idx" ON "mail_sync_runs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_outbox_workflow_step_idx" ON "queue_outbox" USING btree ("workflow_step_id");--> statement-breakpoint
CREATE INDEX "queue_outbox_unpublished_idx" ON "queue_outbox" USING btree ("created_at") WHERE "queue_outbox"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_idempotency_key_idx" ON "workflow_steps" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_created_idx" ON "workflow_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_steps_account_type_created_idx" ON "workflow_steps" USING btree ("account_id","step_type","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_queue_outbox_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('invook_queue_outbox', NEW.id::text);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "queue_outbox_notify_worker"
AFTER INSERT ON "queue_outbox"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_queue_outbox_available();
