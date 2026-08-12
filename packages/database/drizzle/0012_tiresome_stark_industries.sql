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
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text NOT NULL,
	"system_key" text,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"analysis_state" text DEFAULT 'pending' NOT NULL,
	"last_analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_name_check" CHECK (char_length(btrim("labels"."name")) > 0),
	CONSTRAINT "labels_normalized_name_check" CHECK (char_length(btrim("labels"."normalized_name")) > 0),
	CONSTRAINT "labels_description_check" CHECK (char_length(btrim("labels"."description")) > 0),
	CONSTRAINT "labels_system_key_check" CHECK ("labels"."system_key" is null or "labels"."system_key" in ('important', 'travel', 'pitch', 'newsletter')),
	CONSTRAINT "labels_definition_version_check" CHECK ("labels"."definition_version" > 0),
	CONSTRAINT "labels_analysis_state_check" CHECK ("labels"."analysis_state" in ('pending', 'running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "memory_pending_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_pending_evidence_scope_check" CHECK ("memory_pending_evidence"."scope" in ('global', 'contact')),
	CONSTRAINT "memory_pending_evidence_contact_check" CHECK (("memory_pending_evidence"."scope" = 'global' and "memory_pending_evidence"."contact_email" = '') or ("memory_pending_evidence"."scope" = 'contact' and char_length(btrim("memory_pending_evidence"."contact_email")) > 0)),
	CONSTRAINT "memory_pending_evidence_schema_version_check" CHECK ("memory_pending_evidence"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "thread_label_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"model_id" text,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_label_analyses_definition_version_check" CHECK ("thread_label_analyses"."definition_version" > 0)
);
--> statement-breakpoint
INSERT INTO "labels" (
	"user_id",
	"account_id",
	"name",
	"normalized_name",
	"description",
	"system_key",
	"definition_version",
	"analysis_state"
)
SELECT
	"user_id",
	"id",
	definition."name",
	definition."normalized_name",
	definition."description",
	definition."system_key",
	1,
	'pending'
FROM "connected_accounts"
CROSS JOIN (
	VALUES
		('Important', 'important', 'Requires timely attention, a reply, a decision, or has meaningful financial, legal, security, or personal consequence. Routine bulk mail does not belong here.', 'important'),
		('Travel', 'travel', 'Bookings, itineraries, tickets, lodging, visas, check-in, transport, or trip changes.', 'travel'),
		('Pitch', 'pitch', 'Sales, recruiting, partnership, fundraising, investment, sponsorship, or service proposals.', 'pitch'),
		('Newsletter', 'newsletter', 'Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.', 'newsletter')
) AS definition("name", "normalized_name", "description", "system_key");
--> statement-breakpoint
ALTER TABLE "thread_labels" DROP CONSTRAINT "thread_labels_key_check";--> statement-breakpoint
DROP INDEX "thread_labels_thread_key_idx";--> statement-breakpoint
DROP INDEX "thread_labels_account_key_state_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "snippet" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD COLUMN "label_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "thread_labels"
SET "label_id" = "labels"."id"
FROM "labels"
WHERE "labels"."account_id" = "thread_labels"."account_id"
	AND "labels"."system_key" = "thread_labels"."label_key";--> statement-breakpoint
INSERT INTO "thread_label_analyses" (
	"user_id",
	"account_id",
	"thread_id",
	"label_id",
	"definition_version",
	"model_id"
)
SELECT
	"threads"."user_id",
	"threads"."account_id",
	"threads"."id",
	"labels"."id",
	1,
	NULL
FROM "threads"
INNER JOIN "labels" ON "labels"."account_id" = "threads"."account_id"
WHERE COALESCE("threads"."classification_version", 0) >= 1;--> statement-breakpoint
UPDATE "labels"
SET "analysis_state" = 'complete', "last_analyzed_at" = now()
WHERE NOT EXISTS (
	SELECT 1
	FROM "threads"
	WHERE "threads"."account_id" = "labels"."account_id"
		AND COALESCE("threads"."classification_version", 0) < 1
);--> statement-breakpoint
ALTER TABLE "thread_labels" ALTER COLUMN "label_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","created_at") WHERE "jobs"."status" in ('queued', 'retry');--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_name_idx" ON "labels" USING btree ("account_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_system_key_idx" ON "labels" USING btree ("account_id","system_key");--> statement-breakpoint
CREATE INDEX "labels_account_created_idx" ON "labels" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_pending_evidence_message_scope_idx" ON "memory_pending_evidence" USING btree ("message_id","scope","contact_email");--> statement-breakpoint
CREATE INDEX "memory_pending_evidence_account_scope_idx" ON "memory_pending_evidence" USING btree ("account_id","schema_version","scope","contact_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_analyses_thread_label_idx" ON "thread_label_analyses" USING btree ("thread_id","label_id");--> statement-breakpoint
CREATE INDEX "thread_label_analyses_label_version_idx" ON "thread_label_analyses" USING btree ("label_id","definition_version");--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_labels_thread_label_idx" ON "thread_labels" USING btree ("thread_id","label_id");--> statement-breakpoint
CREATE INDEX "thread_labels_account_label_state_idx" ON "thread_labels" USING btree ("account_id","label_id","state");--> statement-breakpoint
ALTER TABLE "thread_labels" DROP COLUMN "label_key";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "classification_version";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "classified_at";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_content_version_check" CHECK ("threads"."content_version" > 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_job_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.status IN ('queued', 'retry') THEN
		PERFORM pg_notify('invook_jobs', NEW.id::text);
	ELSIF TG_OP = 'UPDATE'
		AND NEW.status IN ('queued', 'retry')
		AND OLD.status IS DISTINCT FROM NEW.status THEN
		PERFORM pg_notify('invook_jobs', NEW.id::text);
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_notify_worker"
AFTER INSERT OR UPDATE OF "status" ON "jobs"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_job_available();--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_job_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.status IN ('complete', 'failed') THEN
		PERFORM pg_notify('invook_job_status', NEW.id::text);
	ELSIF TG_OP = 'UPDATE'
		AND NEW.status IN ('complete', 'failed')
		AND OLD.status IS DISTINCT FROM NEW.status THEN
		PERFORM pg_notify('invook_job_status', NEW.id::text);
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_notify_terminal_status"
AFTER INSERT OR UPDATE OF "status" ON "jobs"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_job_terminal();
