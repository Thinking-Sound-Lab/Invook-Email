CREATE TABLE "memory_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"memory_type" text NOT NULL,
	"contact_email" text,
	"fingerprint" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_deletions_type_check" CHECK ("memory_deletions"."memory_type" in ('preference', 'contact', 'scheduling'))
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"memory_type" text NOT NULL,
	"contact_email" text,
	"statement" text NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(5, 2),
	"evidence_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"evidence_draft_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"model_id" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_type_check" CHECK ("memory_entries"."memory_type" in ('preference', 'contact', 'scheduling')),
	CONSTRAINT "memory_entries_source_check" CHECK ("memory_entries"."source" in ('user', 'inferred', 'feedback')),
	CONSTRAINT "memory_entries_contact_check" CHECK (("memory_entries"."memory_type" = 'contact' and "memory_entries"."contact_email" is not null) or ("memory_entries"."memory_type" <> 'contact' and "memory_entries"."contact_email" is null)),
	CONSTRAINT "memory_entries_statement_check" CHECK (char_length("memory_entries"."statement") between 3 and 500),
	CONSTRAINT "memory_entries_confidence_check" CHECK ("memory_entries"."confidence" is null or "memory_entries"."confidence" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "voice_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "voice_profiles" CASCADE;--> statement-breakpoint
ALTER TABLE "connected_accounts" RENAME COLUMN "voice_acknowledged_at" TO "memory_acknowledged_at";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "is_voice_eligible" TO "is_memory_eligible";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "excluded_from_voice" TO "excluded_from_memory";--> statement-breakpoint
ALTER TABLE "profiles" RENAME COLUMN "voice_acknowledged_at" TO "memory_acknowledged_at";--> statement-breakpoint
DROP INDEX "messages_voice_eligible_idx";--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "sync_state" SET DEFAULT '{"recent":"pending","memory":"pending","history":"pending"}'::jsonb;--> statement-breakpoint
UPDATE "connected_accounts"
SET "sync_state" = jsonb_set("sync_state" - 'voice', '{memory}', '"pending"'::jsonb, true);--> statement-breakpoint
UPDATE "jobs"
SET
	"job_type" = 'memory.extract',
	"status" = 'queued',
	"payload" = '{"schemaVersion":1}'::jsonb,
	"attempts" = 0,
	"run_after" = now(),
	"locked_at" = null,
	"locked_by" = null,
	"last_error" = null,
	"result" = null,
	"idempotency_key" = regexp_replace("idempotency_key", '^voice\.build:', 'memory.extract:'),
	"updated_at" = now()
WHERE "job_type" = 'voice.build';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "used_memory_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "feedback_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "last_feedback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_deletions" ADD CONSTRAINT "memory_deletions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_deletions" ADD CONSTRAINT "memory_deletions_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_deletions_account_fingerprint_idx" ON "memory_deletions" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "memory_deletions_user_deleted_idx" ON "memory_deletions" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entries_account_fingerprint_idx" ON "memory_entries" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "memory_entries_account_type_contact_idx" ON "memory_entries" USING btree ("account_id","memory_type","contact_email");--> statement-breakpoint
CREATE INDEX "messages_memory_eligible_idx" ON "messages" USING btree ("user_id","sent_at") WHERE "messages"."direction" = 'outgoing' and "messages"."is_memory_eligible" and not "messages"."excluded_from_memory";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "used_example_message_ids";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "preferences";
