CREATE TABLE "gmail_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_draft_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"message_id" uuid,
	"provider_history_id" text,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_label_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"message_list_visibility" text,
	"label_list_visibility" text,
	"color" jsonb,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_labels_type_check" CHECK ("gmail_labels"."type" in ('system', 'user'))
);
--> statement-breakpoint
CREATE TABLE "gmail_message_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"gmail_label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_message_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_thread_id" text,
	"provider_history_id" text,
	"object_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_push_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"account_id" uuid,
	"email_address" text NOT NULL,
	"notification_history_id" text NOT NULL,
	"subscription" text NOT NULL,
	"published_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'stored' NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_push_events_status_check" CHECK ("gmail_push_events"."status" in ('stored', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "gmail_replica_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"provider_message_count" integer,
	"stored_message_count" integer,
	"missing_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_replica_audits_trigger_check" CHECK ("gmail_replica_audits"."trigger" in ('initial', 'history_expired', 'watch_renewal', 'manual')),
	CONSTRAINT "gmail_replica_audits_status_check" CHECK ("gmail_replica_audits"."status" in ('running', 'complete', 'repairing', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "gmail_replica_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"initial_history_id" text NOT NULL,
	"history_cursor" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"ready_at" timestamp with time zone,
	"last_history_at" timestamp with time zone,
	"last_audit_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_replica_states_state_check" CHECK ("gmail_replica_states"."state" in ('pending', 'snapshotting', 'replaying', 'auditing', 'ready', 'repairing', 'failed', 'deleting'))
);
--> statement-breakpoint
CREATE TABLE "gmail_watch_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"topic_name" text NOT NULL,
	"history_id" text NOT NULL,
	"expiration_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_watch_states_status_check" CHECK ("gmail_watch_states"."status" in ('active', 'stopped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "mailbox_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_change_events_type_check" CHECK ("mailbox_change_events"."change_type" in ('replica_ready', 'history_applied', 'repair_complete', 'drafts_changed', 'labels_changed'))
);
--> statement-breakpoint
ALTER TABLE "queue_outbox" DROP CONSTRAINT "queue_outbox_queue_name_check";--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "mime_part_path" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "content_disposition" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "checksum_sha256" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "content_length" integer;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_history_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "internal_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "size_estimate" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "header_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_html" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_object_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_checksum_sha256" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_content_length" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_etag" text;--> statement-breakpoint
UPDATE "messages" AS "message"
SET
	"account_id" = "thread"."account_id",
	"internal_date" = "message"."sent_at"
FROM "threads" AS "thread"
WHERE "thread"."id" = "message"."thread_id";--> statement-breakpoint
WITH "legacy_labels" AS (
	SELECT "message"."user_id", "thread"."account_id", "label"."provider_label_id"
	FROM "messages" AS "message"
	INNER JOIN "threads" AS "thread" ON "thread"."id" = "message"."thread_id"
	CROSS JOIN LATERAL unnest("message"."label_ids") AS "label"("provider_label_id")
	UNION
	SELECT "thread"."user_id", "thread"."account_id", "label"."provider_label_id"
	FROM "threads" AS "thread"
	CROSS JOIN LATERAL unnest("thread"."label_ids") AS "label"("provider_label_id")
)
INSERT INTO "gmail_labels" (
	"user_id",
	"account_id",
	"provider_label_id",
	"name",
	"type"
)
SELECT DISTINCT
	"user_id",
	"account_id",
	"provider_label_id",
	"provider_label_id",
	CASE
		WHEN "provider_label_id" IN (
			'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
			'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
			'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
		) THEN 'system'
		ELSE 'user'
	END
FROM "legacy_labels";--> statement-breakpoint
INSERT INTO "gmail_message_labels" (
	"account_id",
	"message_id",
	"gmail_label_id"
)
SELECT
	"message"."account_id",
	"message"."id",
	"gmail_label"."id"
FROM "messages" AS "message"
CROSS JOIN LATERAL unnest("message"."label_ids") AS "label"("provider_label_id")
INNER JOIN "gmail_labels" AS "gmail_label"
	ON "gmail_label"."account_id" = "message"."account_id"
	AND "gmail_label"."provider_label_id" = "label"."provider_label_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "gmail_replica_states" (
	"account_id",
	"initial_history_id",
	"state"
)
SELECT "id", "history_cursor", 'pending'
FROM "connected_accounts"
WHERE "status" = 'connected' AND "history_cursor" IS NOT NULL
ON CONFLICT ("account_id") DO NOTHING;--> statement-breakpoint
UPDATE "connected_accounts"
SET "sync_state" = jsonb_build_object(
	'mailSync', 'pending',
	'indexing', 'pending',
	'memory', 'pending'
)
WHERE "status" = 'connected' AND "history_cursor" IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "drafts" WHERE "provider_draft_id" IS NOT NULL) THEN
		RAISE EXCEPTION 'Cannot split legacy provider drafts without Gmail message identity; reconnect and synchronize Gmail drafts first.';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "internal_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_drafts" ADD CONSTRAINT "gmail_drafts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_drafts" ADD CONSTRAINT "gmail_drafts_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_drafts" ADD CONSTRAINT "gmail_drafts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_labels" ADD CONSTRAINT "gmail_labels_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_labels" ADD CONSTRAINT "gmail_labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_message_labels" ADD CONSTRAINT "gmail_message_labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_message_labels" ADD CONSTRAINT "gmail_message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_message_labels" ADD CONSTRAINT "gmail_message_labels_gmail_label_id_gmail_labels_id_fk" FOREIGN KEY ("gmail_label_id") REFERENCES "public"."gmail_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_message_tombstones" ADD CONSTRAINT "gmail_message_tombstones_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_message_tombstones" ADD CONSTRAINT "gmail_message_tombstones_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_push_events" ADD CONSTRAINT "gmail_push_events_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_replica_audits" ADD CONSTRAINT "gmail_replica_audits_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_replica_audits" ADD CONSTRAINT "gmail_replica_audits_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_replica_states" ADD CONSTRAINT "gmail_replica_states_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_watch_states" ADD CONSTRAINT "gmail_watch_states_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_change_events" ADD CONSTRAINT "mailbox_change_events_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_change_events" ADD CONSTRAINT "mailbox_change_events_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_drafts_account_provider_idx" ON "gmail_drafts" USING btree ("account_id","provider_draft_id");--> statement-breakpoint
CREATE INDEX "gmail_drafts_account_thread_idx" ON "gmail_drafts" USING btree ("account_id","provider_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_labels_account_provider_idx" ON "gmail_labels" USING btree ("account_id","provider_label_id");--> statement-breakpoint
CREATE INDEX "gmail_labels_account_name_idx" ON "gmail_labels" USING btree ("account_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_message_labels_message_label_idx" ON "gmail_message_labels" USING btree ("message_id","gmail_label_id");--> statement-breakpoint
CREATE INDEX "gmail_message_labels_account_label_idx" ON "gmail_message_labels" USING btree ("account_id","gmail_label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_message_tombstones_account_message_idx" ON "gmail_message_tombstones" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "gmail_message_tombstones_account_deleted_idx" ON "gmail_message_tombstones" USING btree ("account_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_push_events_provider_event_idx" ON "gmail_push_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "gmail_push_events_account_created_idx" ON "gmail_push_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "gmail_replica_audits_account_created_idx" ON "gmail_replica_audits" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "gmail_replica_states_state_idx" ON "gmail_replica_states" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "gmail_watch_states_expiration_idx" ON "gmail_watch_states" USING btree ("status","expiration_at");--> statement-breakpoint
CREATE INDEX "mailbox_change_events_account_created_idx" ON "mailbox_change_events" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_account_provider_idx" ON "messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "provider_draft_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "label_ids";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "label_ids";--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_content_length_check" CHECK ("message_attachments"."content_length" is null or "message_attachments"."content_length" >= 0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_size_estimate_check" CHECK ("messages"."size_estimate" is null or "messages"."size_estimate" >= 0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_raw_content_length_check" CHECK ("messages"."raw_content_length" is null or "messages"."raw_content_length" >= 0);--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_queue_name_check" CHECK ("queue_outbox"."queue_name" in ('gmail-pages', 'gmail-messages', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_mailbox_change()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('invook_mailbox_changes', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mailbox_change_events_notify
AFTER INSERT ON mailbox_change_events
FOR EACH ROW
EXECUTE FUNCTION notify_invook_mailbox_change();
