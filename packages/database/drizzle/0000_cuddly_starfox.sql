CREATE TABLE "account_secrets" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"token_ciphertext" text NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"event_type" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"voice_acknowledged_at" timestamp with time zone NOT NULL,
	"history_cursor" text,
	"sync_state" jsonb DEFAULT '{"recent":"pending","voice":"pending","history":"pending"}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_accounts_provider_check" CHECK ("connected_accounts"."provider" = 'gmail'),
	CONSTRAINT "connected_accounts_status_check" CHECK ("connected_accounts"."status" in ('connected', 'reconnect_required', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"provider_draft_id" text,
	"status" text DEFAULT 'editing' NOT NULL,
	"generated_text" text,
	"current_text" text DEFAULT '' NOT NULL,
	"final_sent_text" text,
	"used_example_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"generation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edit_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_status_check" CHECK ("drafts"."status" in ('editing', 'sent', 'discarded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"account_id" uuid,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'retry', 'complete', 'failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"sender" jsonb NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"is_voice_eligible" boolean DEFAULT false NOT NULL,
	"excluded_from_voice" boolean DEFAULT false NOT NULL,
	"search_document" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body_text, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('incoming', 'outgoing'))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"voice_acknowledged_at" timestamp with time zone,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_thread_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"latest_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_message_count_check" CHECK ("threads"."message_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"audience_scope" text DEFAULT 'general' NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"explicit_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"learned_traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"learned_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"example_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"excluded_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(5, 2) DEFAULT '0' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_status_check" CHECK ("voice_profiles"."status" in ('building', 'ready', 'resetting', 'failed')),
	CONSTRAINT "voice_profiles_sample_count_check" CHECK ("voice_profiles"."sample_count" >= 0),
	CONSTRAINT "voice_profiles_confidence_check" CHECK ("voice_profiles"."confidence" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "account_secrets" ADD CONSTRAINT "account_secrets_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_provider_identity_idx" ON "connected_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "connected_accounts_user_created_idx" ON "connected_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "drafts_user_updated_idx" ON "drafts" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_after") WHERE "jobs"."status" in ('queued', 'retry');--> statement-breakpoint
CREATE UNIQUE INDEX "messages_thread_provider_message_idx" ON "messages" USING btree ("thread_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_sent_idx" ON "messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search_document");--> statement-breakpoint
CREATE INDEX "messages_voice_eligible_idx" ON "messages" USING btree ("user_id","sent_at") WHERE "messages"."direction" = 'outgoing' and "messages"."is_voice_eligible" and not "messages"."excluded_from_voice";--> statement-breakpoint
CREATE UNIQUE INDEX "threads_account_provider_thread_idx" ON "threads" USING btree ("account_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "threads_user_latest_idx" ON "threads" USING btree ("user_id","latest_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_account_audience_idx" ON "voice_profiles" USING btree ("account_id","audience_scope");