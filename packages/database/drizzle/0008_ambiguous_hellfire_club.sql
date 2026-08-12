CREATE TABLE "embedding_batch_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"provider_batch_id" text,
	"input_file_id" text,
	"model_id" text NOT NULL,
	"dimensions" integer NOT NULL,
	"index_version" integer NOT NULL,
	"batch_attempt" integer DEFAULT 1 NOT NULL,
	"has_more" boolean NOT NULL,
	"request_count" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"provider_state" text,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_batch_submissions_provider_check" CHECK ("embedding_batch_submissions"."provider" = 'openai'),
	CONSTRAINT "embedding_batch_submissions_status_check" CHECK ("embedding_batch_submissions"."status" in ('preparing', 'submitted', 'complete', 'failed')),
	CONSTRAINT "embedding_batch_submissions_dimensions_check" CHECK ("embedding_batch_submissions"."dimensions" = 1536),
	CONSTRAINT "embedding_batch_submissions_request_count_check" CHECK ("embedding_batch_submissions"."request_count" > 0),
	CONSTRAINT "embedding_batch_submissions_batch_attempt_check" CHECK ("embedding_batch_submissions"."batch_attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "message_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(1536);--> statement-breakpoint
ALTER TABLE "embedding_batch_submissions" ADD CONSTRAINT "embedding_batch_submissions_workflow_step_id_workflow_steps_id_fk" FOREIGN KEY ("workflow_step_id") REFERENCES "public"."workflow_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_batch_submissions" ADD CONSTRAINT "embedding_batch_submissions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_batch_submissions" ADD CONSTRAINT "embedding_batch_submissions_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_batch_submissions_workflow_step_idx" ON "embedding_batch_submissions" USING btree ("workflow_step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_batch_submissions_provider_batch_idx" ON "embedding_batch_submissions" USING btree ("provider","provider_batch_id") WHERE "embedding_batch_submissions"."provider_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "embedding_batch_submissions_account_status_idx" ON "embedding_batch_submissions" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX "message_embeddings_embedding_hnsw_idx" ON "message_embeddings" USING hnsw ("embedding" vector_cosine_ops) WHERE "message_embeddings"."status" = 'complete';
