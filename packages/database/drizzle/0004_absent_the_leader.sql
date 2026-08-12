CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_attachment_id" text,
	"filename" text NOT NULL,
	"mime_type" text,
	"size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_size_check" CHECK ("message_attachments"."size" is null or "message_attachments"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "message_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"dimensions" integer NOT NULL,
	"index_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"embedding" vector,
	"provider_batch_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_embeddings_dimensions_check" CHECK ("message_embeddings"."dimensions" > 0),
	CONSTRAINT "message_embeddings_status_check" CHECK ("message_embeddings"."status" in ('pending', 'submitted', 'complete', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "sync_state" SET DEFAULT '{"mailSync":"pending","indexing":"pending","memory":"pending"}'::jsonb;--> statement-breakpoint
UPDATE "connected_accounts"
SET "sync_state" = jsonb_build_object(
	'mailSync', CASE
		WHEN "sync_state"->>'history' = 'complete'
			OR "last_synced_at" IS NOT NULL
			OR EXISTS (
				SELECT 1
				FROM "jobs"
				WHERE "jobs"."account_id" = "connected_accounts"."id"
					AND "jobs"."job_type" = 'gmail.initial_sync'
					AND "jobs"."status" = 'complete'
			)
		THEN 'complete'
		WHEN "sync_state"->>'recent' = 'failed' OR "sync_state"->>'history' = 'failed' THEN 'failed'
		WHEN "sync_state"->>'recent' IN ('running', 'complete') OR "sync_state"->>'history' = 'running' THEN 'running'
		ELSE 'pending'
	END,
	'indexing', 'pending',
	'memory', coalesce("sync_state"->>'memory', 'pending')
);--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_attachments_account_filename_idx" ON "message_attachments" USING btree ("account_id","filename");--> statement-breakpoint
CREATE UNIQUE INDEX "message_embeddings_message_model_version_idx" ON "message_embeddings" USING btree ("message_id","model_id","index_version");--> statement-breakpoint
CREATE INDEX "message_embeddings_account_status_idx" ON "message_embeddings" USING btree ("account_id","model_id","index_version","status");
