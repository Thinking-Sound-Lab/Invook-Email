CREATE TABLE "gmail_deleted_messages" (
	"account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_history_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_deleted_messages_account_message_pk" PRIMARY KEY("account_id","provider_message_id")
);
--> statement-breakpoint
ALTER TABLE "gmail_deleted_messages" ADD CONSTRAINT "gmail_deleted_messages_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;