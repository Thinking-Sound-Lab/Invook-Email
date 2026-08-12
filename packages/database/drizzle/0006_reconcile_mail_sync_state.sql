UPDATE "connected_accounts"
SET
	"sync_state" = "sync_state" || jsonb_build_object('mailSync', 'complete'),
	"updated_at" = now()
WHERE "status" = 'connected'
	AND "sync_state"->>'mailSync' IN ('pending', 'running')
	AND (
		"last_synced_at" IS NOT NULL
		OR EXISTS (
			SELECT 1
			FROM "jobs"
			WHERE "jobs"."account_id" = "connected_accounts"."id"
				AND "jobs"."job_type" = 'gmail.initial_sync'
				AND "jobs"."status" = 'complete'
		)
	);
