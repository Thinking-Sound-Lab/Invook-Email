ALTER TABLE "messages" ADD COLUMN "snippet" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_content_version_check" CHECK ("threads"."content_version" > 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_job_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.status IN ('complete', 'failed') THEN
		PERFORM pg_notify('invook_job_status', NEW.id::text);
	ELSIF TG_OP = 'UPDATE'
		AND NEW.status IN ('complete', 'failed')
		AND OLD.status IS DISTINCT FROM NEW.status THEN
		PERFORM pg_notify('invook_job_status', NEW.id::text);
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_notify_terminal_status"
AFTER INSERT OR UPDATE OF "status" ON "jobs"
FOR EACH ROW
EXECUTE FUNCTION notify_invook_job_terminal();
