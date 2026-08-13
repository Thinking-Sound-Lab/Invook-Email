ALTER TABLE "queue_outbox" DROP CONSTRAINT "queue_outbox_queue_name_check";
--> statement-breakpoint
DO $$
BEGIN
	LOCK TABLE "jobs", "workflow_steps", "queue_outbox", "connected_accounts", "gmail_watch_states" IN ACCESS EXCLUSIVE MODE;

	IF EXISTS (SELECT 1 FROM "jobs" WHERE "status" = 'running') THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot migrate PostgreSQL jobs while legacy work is running.',
			HINT = 'Stop the worker, drain or recover running legacy jobs, then retry the migration.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "jobs"
		WHERE "job_type" NOT IN (
			'memory.incremental',
			'memory.batch.retry',
			'memory.batch.event',
			'label.backfill.submit',
			'label.batch.retry',
			'label.batch.event'
		)
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot migrate an unsupported legacy PostgreSQL job type.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "jobs"
		INNER JOIN "workflow_steps" ON "workflow_steps"."id" = "jobs"."id"
	) OR EXISTS (
		SELECT 1
		FROM "jobs"
		INNER JOIN "workflow_steps"
			ON "jobs"."idempotency_key" IS NOT NULL
			AND "workflow_steps"."idempotency_key" = "jobs"."idempotency_key"
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot preserve legacy PostgreSQL job identities because a workflow step conflicts.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "workflow_steps"
		WHERE "step_type" = 'gmail.watch.renew'
			AND "status" = 'running'
			AND coalesce("input"->>'cadence', '') <> 'daily'
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot replace a legacy Gmail watch renewal while it is running.',
			HINT = 'Stop Gmail workers and retry after the renewal step reaches a terminal state.';
	END IF;

	INSERT INTO "workflow_steps" (
		"id",
		"user_id",
		"account_id",
		"step_type",
		"status",
		"input",
		"result",
		"attempts",
		"max_attempts",
		"last_error",
		"idempotency_key",
		"started_at",
		"completed_at",
		"created_at",
		"updated_at"
	)
	SELECT
		"id",
		"user_id",
		"account_id",
		"job_type",
		CASE WHEN "status" = 'retry' THEN 'queued' ELSE "status" END,
		"payload",
		"result",
		"attempts",
		"max_attempts",
		"last_error",
		coalesce("idempotency_key", 'legacy-job:' || "id"::text),
		"locked_at",
		CASE WHEN "status" IN ('complete', 'failed') THEN "updated_at" ELSE NULL END,
		"created_at",
		"updated_at"
	FROM "jobs";

	INSERT INTO "queue_outbox" ("workflow_step_id", "queue_name")
	SELECT
		"id",
		CASE
			WHEN "job_type" = 'memory.incremental' THEN 'mail-memory-submit'
			WHEN "job_type" IN ('memory.batch.retry', 'memory.batch.event') THEN 'mail-memory-events'
			WHEN "job_type" = 'label.backfill.submit' THEN 'mail-label-submit'
			WHEN "job_type" IN ('label.batch.retry', 'label.batch.event') THEN 'mail-label-events'
		END
	FROM "jobs"
	WHERE "status" IN ('queued', 'retry');

	DELETE FROM "queue_outbox"
	USING "workflow_steps"
	WHERE "queue_outbox"."workflow_step_id" = "workflow_steps"."id"
		AND "queue_outbox"."published_at" IS NULL
		AND "workflow_steps"."step_type" = 'gmail.watch.renew'
		AND "workflow_steps"."status" = 'queued'
		AND coalesce("workflow_steps"."input"->>'cadence', '') <> 'daily';

	UPDATE "workflow_steps"
	SET
		"status" = 'complete',
		"result" = jsonb_build_object(
			'status', 'superseded',
			'reason', 'replaced_by_daily_renewal',
			'completedAt', now()
		),
		"completed_at" = now(),
		"updated_at" = now()
	WHERE "step_type" = 'gmail.watch.renew'
		AND "status" = 'queued'
		AND coalesce("input"->>'cadence', '') <> 'daily';

	INSERT INTO "workflow_steps" (
		"user_id",
		"account_id",
		"step_type",
		"status",
		"input",
		"idempotency_key"
	)
	SELECT
		"connected_accounts"."user_id",
		"connected_accounts"."id",
		'gmail.watch.renew',
		'queued',
		jsonb_build_object(
			'cadence', 'daily',
			'runAt', to_char(
				("gmail_watch_states"."last_renewed_at" + interval '1 day') AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			),
			'expectedExpirationAt', to_char(
				"gmail_watch_states"."expiration_at" AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			)
		),
		'gmail-watch-renew:' || "connected_accounts"."id"::text || ':daily:' ||
			to_char(
				("gmail_watch_states"."last_renewed_at" + interval '1 day') AT TIME ZONE 'UTC',
				'YYYY-MM-DD'
			)
	FROM "connected_accounts"
	INNER JOIN "gmail_watch_states"
		ON "gmail_watch_states"."account_id" = "connected_accounts"."id"
	WHERE "connected_accounts"."status" = 'connected'
		AND "gmail_watch_states"."status" = 'active'
	ON CONFLICT ("idempotency_key") DO NOTHING;

	INSERT INTO "queue_outbox" ("workflow_step_id", "queue_name")
	SELECT "workflow_steps"."id", 'gmail-control'
	FROM "workflow_steps"
	LEFT JOIN "queue_outbox"
		ON "queue_outbox"."workflow_step_id" = "workflow_steps"."id"
	WHERE "workflow_steps"."step_type" = 'gmail.watch.renew'
		AND "workflow_steps"."status" = 'queued'
		AND "workflow_steps"."input"->>'cadence' = 'daily'
		AND "queue_outbox"."id" IS NULL;

	DROP TRIGGER IF EXISTS "jobs_notify_worker" ON "jobs";
	DROP FUNCTION IF EXISTS "notify_invook_job_available"();
	DROP TABLE "jobs";
END $$;
--> statement-breakpoint
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_queue_name_check" CHECK ("queue_outbox"."queue_name" in ('gmail-pages', 'gmail-messages', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback', 'mail-label-submit', 'mail-label-events'));
