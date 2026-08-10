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
ALTER TABLE "thread_labels" ADD COLUMN "label_id" uuid;--> statement-breakpoint
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
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_label_analyses" ADD CONSTRAINT "thread_label_analyses_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_name_idx" ON "labels" USING btree ("account_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_system_key_idx" ON "labels" USING btree ("account_id","system_key");--> statement-breakpoint
CREATE INDEX "labels_account_created_idx" ON "labels" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_analyses_thread_label_idx" ON "thread_label_analyses" USING btree ("thread_id","label_id");--> statement-breakpoint
CREATE INDEX "thread_label_analyses_label_version_idx" ON "thread_label_analyses" USING btree ("label_id","definition_version");--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_labels_thread_label_idx" ON "thread_labels" USING btree ("thread_id","label_id");--> statement-breakpoint
CREATE INDEX "thread_labels_account_label_state_idx" ON "thread_labels" USING btree ("account_id","label_id","state");--> statement-breakpoint
DELETE FROM "jobs" WHERE "job_type" = 'mail.classify';--> statement-breakpoint
ALTER TABLE "thread_labels" DROP COLUMN "label_key";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "classification_version";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "classified_at";
