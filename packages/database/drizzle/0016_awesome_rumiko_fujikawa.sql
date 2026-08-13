CREATE TABLE "mailbox_action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gmail_label_id" uuid,
	"provider_label_id" text,
	"gmail_label_name" text,
	"request_fingerprint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"workflow_step_id" uuid,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_action_proposals_operation_check" CHECK ("mailbox_action_proposals"."operation" in ('archive', 'mark_read', 'mark_unread', 'trash', 'apply_gmail_label', 'remove_gmail_label', 'save_draft_to_gmail')),
	CONSTRAINT "mailbox_action_proposals_status_check" CHECK ("mailbox_action_proposals"."status" in ('pending', 'executing', 'completed', 'partial_failure', 'failed', 'cancelled')),
	CONSTRAINT "mailbox_action_proposals_label_check" CHECK (("mailbox_action_proposals"."operation" in ('apply_gmail_label', 'remove_gmail_label') and "mailbox_action_proposals"."provider_label_id" is not null and "mailbox_action_proposals"."gmail_label_name" is not null) or ("mailbox_action_proposals"."operation" not in ('apply_gmail_label', 'remove_gmail_label') and "mailbox_action_proposals"."provider_label_id" is null and "mailbox_action_proposals"."gmail_label_name" is null))
);
--> statement-breakpoint
CREATE TABLE "mailbox_action_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid,
	"draft_id" uuid,
	"thread_id" uuid NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text NOT NULL,
	"subject" text NOT NULL,
	"sender" text,
	"sent_at" timestamp with time zone,
	"expected_updated_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"provider_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_action_targets_kind_check" CHECK (("mailbox_action_targets"."message_id" is not null and "mailbox_action_targets"."draft_id" is null and "mailbox_action_targets"."provider_message_id" is not null) or ("mailbox_action_targets"."message_id" is null and "mailbox_action_targets"."draft_id" is not null and "mailbox_action_targets"."provider_message_id" is null)),
	CONSTRAINT "mailbox_action_targets_status_check" CHECK ("mailbox_action_targets"."status" in ('pending', 'executing', 'completed', 'failed', 'stale'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_action_proposals" ADD CONSTRAINT "mailbox_action_proposals_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_proposals" ADD CONSTRAINT "mailbox_action_proposals_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_proposals" ADD CONSTRAINT "mailbox_action_proposals_gmail_label_id_gmail_labels_id_fk" FOREIGN KEY ("gmail_label_id") REFERENCES "public"."gmail_labels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_proposals" ADD CONSTRAINT "mailbox_action_proposals_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_targets" ADD CONSTRAINT "mailbox_action_targets_proposal_id_mailbox_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."mailbox_action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_targets" ADD CONSTRAINT "mailbox_action_targets_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_action_targets" ADD CONSTRAINT "mailbox_action_targets_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_action_proposals_idempotency_idx" ON "mailbox_action_proposals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mailbox_action_proposals_user_created_idx" ON "mailbox_action_proposals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mailbox_action_proposals_account_status_idx" ON "mailbox_action_proposals" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_action_targets_proposal_message_idx" ON "mailbox_action_targets" USING btree ("proposal_id","message_id") WHERE "mailbox_action_targets"."message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_action_targets_proposal_draft_idx" ON "mailbox_action_targets" USING btree ("proposal_id","draft_id") WHERE "mailbox_action_targets"."draft_id" is not null;--> statement-breakpoint
CREATE INDEX "mailbox_action_targets_proposal_status_idx" ON "mailbox_action_targets" USING btree ("proposal_id","status","created_at");