CREATE TABLE "gmail_draft_write_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"provider_draft_id" text,
	"provider_message_id" text,
	"provider_thread_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_draft_write_operations_operation_check" CHECK ("gmail_draft_write_operations"."operation" in ('create', 'update')),
	CONSTRAINT "gmail_draft_write_operations_status_check" CHECK ("gmail_draft_write_operations"."status" in ('pending', 'complete')),
	CONSTRAINT "gmail_draft_write_operations_result_check" CHECK (("gmail_draft_write_operations"."status" = 'pending' and "gmail_draft_write_operations"."provider_draft_id" is null and "gmail_draft_write_operations"."provider_message_id" is null and "gmail_draft_write_operations"."provider_thread_id" is null and "gmail_draft_write_operations"."completed_at" is null) or ("gmail_draft_write_operations"."status" = 'complete' and "gmail_draft_write_operations"."provider_draft_id" is not null and "gmail_draft_write_operations"."provider_message_id" is not null and "gmail_draft_write_operations"."provider_thread_id" is not null and "gmail_draft_write_operations"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "gmail_draft_write_operations" ADD CONSTRAINT "gmail_draft_write_operations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_draft_write_operations" ADD CONSTRAINT "gmail_draft_write_operations_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_draft_write_operations_user_key_idx" ON "gmail_draft_write_operations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gmail_draft_write_operations_account_status_idx" ON "gmail_draft_write_operations" USING btree ("account_id","status","created_at");