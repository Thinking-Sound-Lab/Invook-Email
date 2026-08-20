CREATE TABLE "thread_label_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(5, 2),
	"model_id" text,
	"definition_version" integer NOT NULL,
	"assignment_version" integer DEFAULT 1 NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_label_assignments_source_check" CHECK ("thread_label_assignments"."source" in ('ai', 'user')),
	CONSTRAINT "thread_label_assignments_confidence_check" CHECK ("thread_label_assignments"."confidence" is null or "thread_label_assignments"."confidence" between 0 and 100),
	CONSTRAINT "thread_label_assignments_definition_version_check" CHECK ("thread_label_assignments"."definition_version" > 0),
	CONSTRAINT "thread_label_assignments_assignment_version_check" CHECK ("thread_label_assignments"."assignment_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_system_key_check";--> statement-breakpoint
ALTER TABLE "message_labels" DROP CONSTRAINT "message_labels_source_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_label_analysis_state_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_label_analysis_version_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_label_analysis_definition_hash_check";--> statement-breakpoint
ALTER TABLE "temporal_commands" DROP CONSTRAINT "temporal_commands_activity_task_queue_check";--> statement-breakpoint
DROP INDEX "messages_account_label_analysis_idx";--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "is_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analysis_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analysis_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analysis_definition_hash" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analysis_error" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread_label_assignments" ADD CONSTRAINT "thread_label_assignments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_assignments" ADD CONSTRAINT "thread_label_assignments_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_assignments" ADD CONSTRAINT "thread_label_assignments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_assignments" ADD CONSTRAINT "thread_label_assignments_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_assignments_thread_idx" ON "thread_label_assignments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_label_assignments_account_label_idx" ON "thread_label_assignments" USING btree ("account_id","label_id");--> statement-breakpoint
CREATE INDEX "threads_account_label_analysis_idx" ON "threads" USING btree ("account_id","label_analysis_state","latest_message_at");--> statement-breakpoint

UPDATE "labels" AS label
SET
	"name" = builtin.name,
	"normalized_name" = builtin.normalized_name,
	"description" = builtin.description,
	"system_key" = builtin.system_key,
	"definition_version" = GREATEST(label."definition_version", 1),
	"is_enabled" = true,
	"disabled_at" = null,
	"updated_at" = now()
FROM (
	VALUES
		('Important', 'important', 'Direct personal or work messages that require timely attention, a decision, or an action from the mailbox owner.', 'important'),
		('Newsletter', 'newsletter', 'Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.', 'newsletter'),
		('Billing', 'billing', 'Invoices, receipts, payment confirmations, subscription charges, account statements, refunds, or other billing records.', 'billing'),
		('Others', 'others', 'Fallback for an Inbox thread that does not match any enabled Invook label.', 'others')
) AS builtin(name, normalized_name, description, system_key)
WHERE label."kind" = 'invook'
	AND label."normalized_name" = builtin.normalized_name;--> statement-breakpoint

INSERT INTO "labels" (
	"user_id",
	"account_id",
	"kind",
	"name",
	"normalized_name",
	"description",
	"system_key",
	"definition_version",
	"is_enabled"
)
SELECT
	account."user_id",
	account."id",
	'invook',
	builtin.name,
	builtin.normalized_name,
	builtin.description,
	builtin.system_key,
	1,
	true
FROM "connected_accounts" AS account
CROSS JOIN (
	VALUES
		('Important', 'important', 'Direct personal or work messages that require timely attention, a decision, or an action from the mailbox owner.', 'important'),
		('Newsletter', 'newsletter', 'Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.', 'newsletter'),
		('Billing', 'billing', 'Invoices, receipts, payment confirmations, subscription charges, account statements, refunds, or other billing records.', 'billing'),
		('Others', 'others', 'Fallback for an Inbox thread that does not match any enabled Invook label.', 'others')
) AS builtin(name, normalized_name, description, system_key)
WHERE NOT EXISTS (
	SELECT 1
	FROM "labels" AS existing
	WHERE existing."account_id" = account."id"
		AND existing."kind" = 'invook'
		AND existing."system_key" = builtin.system_key
);--> statement-breakpoint

WITH unambiguous_user_assignments AS (
	SELECT
		message."thread_id",
		MIN(membership."label_id"::text)::uuid AS label_id
	FROM "messages" AS message
	INNER JOIN "message_labels" AS membership
		ON membership."message_id" = message."id"
	INNER JOIN "labels" AS label
		ON label."id" = membership."label_id"
	WHERE membership."source" = 'user'
		AND label."kind" = 'invook'
	GROUP BY message."thread_id"
	HAVING COUNT(DISTINCT membership."label_id") = 1
)
INSERT INTO "thread_label_assignments" (
	"user_id",
	"account_id",
	"thread_id",
	"label_id",
	"source",
	"confidence",
	"model_id",
	"definition_version"
)
SELECT
	thread."user_id",
	thread."account_id",
	thread."id",
	assignment.label_id,
	'user',
	null,
	null,
	label."definition_version"
FROM unambiguous_user_assignments AS assignment
INNER JOIN "threads" AS thread ON thread."id" = assignment."thread_id"
INNER JOIN "labels" AS label ON label."id" = assignment.label_id;--> statement-breakpoint

UPDATE "threads" AS thread
SET
	"label_analysis_state" = 'complete',
	"label_analysis_error" = null,
	"label_analyzed_at" = now(),
	"updated_at" = now()
WHERE EXISTS (
	SELECT 1
	FROM "thread_label_assignments" AS assignment
	WHERE assignment."thread_id" = thread."id"
);--> statement-breakpoint

DELETE FROM "message_labels" WHERE "source" <> 'gmail';--> statement-breakpoint
DELETE FROM "temporal_commands" AS command
USING "workflow_steps" AS step
WHERE command."workflow_step_id" = step."id"
	AND step."step_type" IN ('label.message.analyze', 'label.message.apply');--> statement-breakpoint
UPDATE "workflow_steps"
SET
	"status" = 'complete',
	"result" = '{"status":"superseded","reason":"thread_label_migration"}'::jsonb,
	"last_error" = null,
	"completed_at" = now(),
	"updated_at" = now()
WHERE "step_type" IN ('label.message.analyze', 'label.message.apply')
	AND "status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "message_label_decisions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "message_label_decisions" CASCADE;--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_analysis_state";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_analysis_version";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_analysis_definition_hash";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_analysis_error";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_analyzed_at";--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_enabled_contract_check" CHECK ("labels"."is_enabled" or "labels"."system_key" is distinct from 'others');--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_system_key_check" CHECK ("labels"."system_key" is null or "labels"."system_key" in ('important', 'newsletter', 'billing', 'others'));--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_source_check" CHECK ("message_labels"."source" = 'gmail');--> statement-breakpoint
ALTER TABLE "temporal_commands" ADD CONSTRAINT "temporal_commands_activity_task_queue_check" CHECK ("temporal_commands"."activity_task_queue" in ('gmail-pages', 'gmail-messages', 'gmail-message-batches', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback', 'mail-label-submit'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_label_analysis_state_check" CHECK ("threads"."label_analysis_state" in ('pending', 'running', 'complete', 'failed'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_label_analysis_version_check" CHECK ("threads"."label_analysis_version" > 0);--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_label_analysis_definition_hash_check" CHECK ("threads"."label_analysis_definition_hash" is null or "threads"."label_analysis_definition_hash" ~ '^[0-9a-f]{64}$');
