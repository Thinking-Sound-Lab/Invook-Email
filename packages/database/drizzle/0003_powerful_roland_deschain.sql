DROP INDEX "jobs_ready_idx";--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","created_at") WHERE "jobs"."status" in ('queued', 'retry');--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "run_after";--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_job_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.status IN ('queued', 'retry') THEN
		PERFORM pg_notify('invook_jobs', NEW.id::text);
	ELSIF TG_OP = 'UPDATE'
		AND NEW.status IN ('queued', 'retry')
		AND OLD.status <> 'running' THEN
		PERFORM pg_notify('invook_jobs', NEW.id::text);
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_notify_worker"
AFTER INSERT OR UPDATE OF "status" ON "jobs"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_job_available();
