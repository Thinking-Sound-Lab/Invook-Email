LOCK TABLE "mail_sync_runs", "workflow_steps", "gmail_sync_items", "queue_outbox" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		WITH "ranked_active_runs" AS (
			SELECT
				"id",
				row_number() OVER (
					PARTITION BY "account_id"
					ORDER BY
						CASE WHEN "status" = 'running' THEN 0 ELSE 1 END,
						"discovery_complete" DESC,
						"processed_message_count" DESC,
						"page_count" DESC,
						"created_at" ASC,
						"id" ASC
				) AS "active_rank"
			FROM "mail_sync_runs"
			WHERE "status" in ('queued', 'running')
		)
		SELECT 1
		FROM "ranked_active_runs"
		INNER JOIN "workflow_steps"
			ON "workflow_steps"."run_id" = "ranked_active_runs"."id"
		WHERE "ranked_active_runs"."active_rank" > 1
			AND "workflow_steps"."status" = 'running'
	) OR EXISTS (
		WITH "ranked_active_runs" AS (
			SELECT
				"id",
				row_number() OVER (
					PARTITION BY "account_id"
					ORDER BY
						CASE WHEN "status" = 'running' THEN 0 ELSE 1 END,
						"discovery_complete" DESC,
						"processed_message_count" DESC,
						"page_count" DESC,
						"created_at" ASC,
						"id" ASC
				) AS "active_rank"
			FROM "mail_sync_runs"
			WHERE "status" in ('queued', 'running')
		)
		SELECT 1
		FROM "ranked_active_runs"
		INNER JOIN "gmail_sync_items"
			ON "gmail_sync_items"."run_id" = "ranked_active_runs"."id"
		WHERE "ranked_active_runs"."active_rank" > 1
			AND "gmail_sync_items"."status" = 'running'
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot enforce one active Gmail synchronization run while a duplicate run still has executing work.',
			HINT = 'Drain or stop Gmail workers, then retry the migration. No synchronization run was superseded.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP CONSTRAINT "mail_sync_runs_status_check";--> statement-breakpoint
WITH "ranked_active_runs" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "account_id"
			ORDER BY
				CASE WHEN "status" = 'running' THEN 0 ELSE 1 END,
				"discovery_complete" DESC,
				"processed_message_count" DESC,
				"page_count" DESC,
				"created_at" ASC,
				"id" ASC
		) AS "active_rank"
	FROM "mail_sync_runs"
	WHERE "status" in ('queued', 'running')
)
UPDATE "mail_sync_runs"
SET
	"status" = 'superseded',
	"last_error" = 'Superseded during single-active-run migration.',
	"completed_at" = coalesce("completed_at", now()),
	"updated_at" = now()
WHERE "id" IN (
	SELECT "id"
	FROM "ranked_active_runs"
	WHERE "active_rank" > 1
);--> statement-breakpoint
DELETE FROM "queue_outbox"
USING "workflow_steps", "mail_sync_runs"
WHERE "queue_outbox"."workflow_step_id" = "workflow_steps"."id"
	AND "workflow_steps"."run_id" = "mail_sync_runs"."id"
	AND "mail_sync_runs"."status" = 'superseded'
	AND "queue_outbox"."published_at" IS NULL;--> statement-breakpoint
UPDATE "workflow_steps" AS "step"
SET
	"status" = 'failed',
	"last_error" = 'Synchronization run was superseded during single-active-run migration.',
	"completed_at" = coalesce("step"."completed_at", now()),
	"updated_at" = now()
FROM "mail_sync_runs"
WHERE "step"."run_id" = "mail_sync_runs"."id"
	AND "mail_sync_runs"."status" = 'superseded'
	AND "step"."status" in ('queued', 'running');--> statement-breakpoint
UPDATE "gmail_sync_items" AS "item"
SET
	"status" = 'failed',
	"last_error" = 'Synchronization run was superseded during single-active-run migration.',
	"completed_at" = coalesce("item"."completed_at", now()),
	"updated_at" = now()
FROM "mail_sync_runs"
WHERE "item"."run_id" = "mail_sync_runs"."id"
	AND "mail_sync_runs"."status" = 'superseded'
	AND "item"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "mail_sync_runs_single_active_account_idx" ON "mail_sync_runs" USING btree ("account_id") WHERE "mail_sync_runs"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_status_check" CHECK ("mail_sync_runs"."status" in ('queued', 'running', 'complete', 'failed', 'superseded'));
