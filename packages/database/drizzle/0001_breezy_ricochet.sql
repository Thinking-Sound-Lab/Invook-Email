CREATE TABLE "thread_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"label_key" text NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"confidence" numeric(5, 2),
	"model_id" text,
	"analysis_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_labels_key_check" CHECK ("thread_labels"."label_key" in ('important', 'travel', 'pitch', 'newsletter')),
	CONSTRAINT "thread_labels_source_check" CHECK ("thread_labels"."source" in ('ai', 'user')),
	CONSTRAINT "thread_labels_state_check" CHECK ("thread_labels"."state" in ('applied', 'dismissed')),
	CONSTRAINT "thread_labels_confidence_check" CHECK ("thread_labels"."confidence" is null or "thread_labels"."confidence" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "classification_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_labels_thread_key_idx" ON "thread_labels" USING btree ("thread_id","label_key");--> statement-breakpoint
CREATE INDEX "thread_labels_account_key_state_idx" ON "thread_labels" USING btree ("account_id","label_key","state");--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_audience_scope_check" CHECK ("voice_profiles"."audience_scope" in ('general', 'professional', 'familiar', 'group'));