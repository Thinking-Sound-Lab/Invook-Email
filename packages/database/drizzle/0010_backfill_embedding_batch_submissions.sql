WITH legacy_submissions AS (
	SELECT
		workflow_steps.id AS workflow_step_id,
		workflow_steps.user_id,
		workflow_steps.account_id,
		workflow_steps.result->>'providerBatchId' AS provider_batch_id,
		workflow_steps.result->>'inputFileId' AS input_file_id,
		workflow_steps.result->>'modelId' AS model_id,
		(workflow_steps.result->>'dimensions')::integer AS dimensions,
		(workflow_steps.result->>'indexVersion')::integer AS index_version,
		coalesce((workflow_steps.result->>'batchAttempt')::integer, 1) AS batch_attempt,
		(workflow_steps.result->>'hasMore')::boolean AS has_more,
		(workflow_steps.result->>'requestCount')::integer AS request_count,
		workflow_steps.result->'manifest' AS manifest,
		EXISTS (
			SELECT 1
			FROM "message_embeddings"
			WHERE "message_embeddings"."provider_batch_id" = workflow_steps.result->>'providerBatchId'
				AND "message_embeddings"."status" = 'submitted'
		) AS is_active,
		workflow_steps.completed_at,
		workflow_steps.created_at,
		workflow_steps.updated_at
	FROM "workflow_steps"
	WHERE workflow_steps.step_type = 'embedding.backfill'
		AND workflow_steps.status = 'complete'
		AND workflow_steps.user_id IS NOT NULL
		AND workflow_steps.account_id IS NOT NULL
		AND workflow_steps.result->>'provider' = 'openai'
		AND coalesce(workflow_steps.result->>'providerBatchId', '') <> ''
		AND coalesce(workflow_steps.result->>'inputFileId', '') <> ''
		AND coalesce(workflow_steps.result->>'modelId', '') <> ''
		AND workflow_steps.result->>'dimensions' ~ '^[0-9]+$'
		AND (workflow_steps.result->>'dimensions')::integer = 1536
		AND workflow_steps.result->>'indexVersion' ~ '^[0-9]+$'
		AND workflow_steps.result->>'requestCount' ~ '^[1-9][0-9]*$'
		AND coalesce(workflow_steps.result->>'batchAttempt', '1') ~ '^[1-9][0-9]*$'
		AND workflow_steps.result->>'hasMore' IN ('true', 'false')
		AND jsonb_typeof(workflow_steps.result->'manifest') = 'array'
		AND jsonb_array_length(workflow_steps.result->'manifest') = (workflow_steps.result->>'requestCount')::integer
),
ranked_submissions AS (
	SELECT
		legacy_submissions.*,
		row_number() OVER (
			PARTITION BY legacy_submissions.account_id, legacy_submissions.is_active
			ORDER BY legacy_submissions.updated_at DESC, legacy_submissions.workflow_step_id DESC
		) AS account_state_rank
	FROM legacy_submissions
)
INSERT INTO "embedding_batch_submissions" (
	"workflow_step_id",
	"user_id",
	"account_id",
	"provider",
	"provider_batch_id",
	"input_file_id",
	"model_id",
	"dimensions",
	"index_version",
	"batch_attempt",
	"has_more",
	"request_count",
	"manifest",
	"status",
	"provider_state",
	"submitted_at",
	"completed_at",
	"created_at",
	"updated_at"
)
SELECT
	ranked_submissions.workflow_step_id,
	ranked_submissions.user_id,
	ranked_submissions.account_id,
	'openai',
	ranked_submissions.provider_batch_id,
	ranked_submissions.input_file_id,
	ranked_submissions.model_id,
	ranked_submissions.dimensions,
	ranked_submissions.index_version,
	ranked_submissions.batch_attempt,
	ranked_submissions.has_more,
	ranked_submissions.request_count,
	ranked_submissions.manifest,
	CASE
		WHEN ranked_submissions.is_active AND ranked_submissions.account_state_rank = 1 THEN 'submitted'
		ELSE 'complete'
	END,
	CASE
		WHEN ranked_submissions.is_active AND ranked_submissions.account_state_rank = 1 THEN NULL
		ELSE 'migrated'
	END,
	coalesce(ranked_submissions.completed_at, ranked_submissions.updated_at),
	CASE
		WHEN ranked_submissions.is_active AND ranked_submissions.account_state_rank = 1 THEN NULL
		ELSE ranked_submissions.updated_at
	END,
	ranked_submissions.created_at,
	ranked_submissions.updated_at
FROM ranked_submissions
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "message_embeddings"
SET
	"status" = 'failed',
	"provider_batch_id" = NULL,
	"last_error" = 'The legacy provider batch was superseded while enabling durable embedding batch tracking.',
	"updated_at" = now()
WHERE "message_embeddings"."status" = 'submitted'
	AND "message_embeddings"."provider_batch_id" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "embedding_batch_submissions"
		WHERE "embedding_batch_submissions"."provider_batch_id" = "message_embeddings"."provider_batch_id"
			AND "embedding_batch_submissions"."status" = 'submitted'
	);
