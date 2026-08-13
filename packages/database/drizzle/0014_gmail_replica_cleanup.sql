CREATE TABLE "gmail_account_cleanups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_count" integer,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_account_cleanups_status_check" CHECK ("gmail_account_cleanups"."status" in ('queued', 'running', 'complete', 'failed')),
	CONSTRAINT "gmail_account_cleanups_object_count_check" CHECK ("gmail_account_cleanups"."object_count" is null or "gmail_account_cleanups"."object_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "gmail_account_cleanups" ADD CONSTRAINT "gmail_account_cleanups_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_account_cleanups_account_idx" ON "gmail_account_cleanups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "gmail_account_cleanups_user_created_idx" ON "gmail_account_cleanups" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "history_cursor";--> statement-breakpoint
DROP TRIGGER IF EXISTS "jobs_notify_terminal_status" ON "jobs";--> statement-breakpoint
DROP FUNCTION IF EXISTS notify_invook_job_terminal();
