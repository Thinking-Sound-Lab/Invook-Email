ALTER TABLE "labels" DROP CONSTRAINT "labels_analysis_state_check";--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_kind_contract_check";--> statement-breakpoint
ALTER TABLE "queue_outbox" DROP CONSTRAINT "queue_outbox_queue_name_check";--> statement-breakpoint
DELETE FROM "workflow_steps"
WHERE "step_type" IN ('label.backfill.submit', 'label.batch.retry', 'label.batch.event')
  AND "status" IN ('queued', 'running', 'failed');--> statement-breakpoint
DELETE FROM "queue_outbox" WHERE "queue_name" = 'mail-label-events';--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "label_analysis_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "label_analysis_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "label_analysis_definition_hash" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "label_analysis_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "label_analyzed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "messages"
SET "label_analysis_state" = 'complete',
    "label_analyzed_at" = "updated_at";--> statement-breakpoint
DELETE FROM "labels"
WHERE "kind" = 'gmail'
  AND "provider_label_id" NOT IN ('IMPORTANT', 'INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD');--> statement-breakpoint
UPDATE "labels"
SET "provider_type" = 'system'
WHERE "kind" = 'gmail';--> statement-breakpoint
UPDATE "labels"
SET "system_key" = 'newsletter',
    "name" = 'Newsletter',
    "description" = 'Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.',
    "definition_version" = "definition_version" + 1,
    "updated_at" = now()
WHERE "kind" = 'invook' AND "normalized_name" = 'newsletter';--> statement-breakpoint
INSERT INTO "labels" (
  "user_id",
  "account_id",
  "kind",
  "name",
  "normalized_name",
  "description",
  "system_key",
  "definition_version"
)
SELECT
  account."user_id",
  account."id",
  'invook',
  'Newsletter',
  'newsletter',
  'Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.',
  'newsletter',
  1
FROM "connected_accounts" account
WHERE NOT EXISTS (
  SELECT 1
  FROM "labels"
  WHERE "labels"."account_id" = account."id"
    AND "labels"."kind" = 'invook'
    AND "labels"."normalized_name" = 'newsletter'
);--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_system_key_idx" ON "labels" USING btree ("account_id","system_key") WHERE "labels"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_account_label_analysis_idx" ON "messages" USING btree ("account_id","label_analysis_state","sent_at");--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "analysis_state";--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "last_analyzed_at";--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "message_list_visibility";--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "label_list_visibility";--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "color";--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "provider_metadata";--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_system_key_check" CHECK ("labels"."system_key" is null or "labels"."system_key" = 'newsletter');--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_contract_check" CHECK (("labels"."kind" = 'gmail' and "labels"."provider_label_id" is not null and "labels"."provider_type" = 'system' and "labels"."system_key" is null) or ("labels"."kind" = 'invook' and "labels"."provider_label_id" is null and "labels"."provider_type" is null and char_length(btrim("labels"."description")) > 0));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_label_analysis_state_check" CHECK ("messages"."label_analysis_state" in ('pending', 'running', 'complete', 'failed'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_label_analysis_version_check" CHECK ("messages"."label_analysis_version" > 0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_label_analysis_definition_hash_check" CHECK ("messages"."label_analysis_definition_hash" is null or "messages"."label_analysis_definition_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_queue_name_check" CHECK ("queue_outbox"."queue_name" in ('gmail-pages', 'gmail-messages', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback', 'mail-label-submit'));
