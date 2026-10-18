CREATE TABLE "agent_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"active_run_id" uuid,
	"active_run_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_conversations_run_lease_check" CHECK (("agent_conversations"."active_run_id" is null) = ("agent_conversations"."active_run_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_role_check" CHECK ("agent_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "agent_messages_position_check" CHECK ("agent_messages"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_socket_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_socket_tickets" ADD CONSTRAINT "agent_socket_tickets_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_socket_tickets" ADD CONSTRAINT "agent_socket_tickets_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_conversations_user_updated_idx" ON "agent_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_conversation_position_idx" ON "agent_messages" USING btree ("conversation_id","position");--> statement-breakpoint
CREATE INDEX "agent_messages_user_idx" ON "agent_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_socket_tickets_user_expiration_idx" ON "agent_socket_tickets" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_socket_tickets_session_idx" ON "agent_socket_tickets" USING btree ("session_id");