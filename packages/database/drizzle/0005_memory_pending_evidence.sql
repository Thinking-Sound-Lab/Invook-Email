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
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" ADD CONSTRAINT "memory_pending_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_pending_evidence_message_scope_idx" ON "memory_pending_evidence" USING btree ("message_id","scope","contact_email");--> statement-breakpoint
CREATE INDEX "memory_pending_evidence_account_scope_idx" ON "memory_pending_evidence" USING btree ("account_id","schema_version","scope","contact_email","created_at");
